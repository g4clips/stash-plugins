"""
ManyVidsStashDB.py — Plugin backend.

Same architecture family as IWantClipsStashDB: config-store performerStoreMap
keyed by a stable store identifier, proxyUrl setting, filename parsing,
single-clip JSON-LD scraping, and local performer/studio resolution against
Stash. Two things are genuinely new here (confirmed via live investigation,
not assumed from IWantClips):

  1. Store discovery has no sitemap/directory equivalent -- ManyVids has no
     known public "all performer stores" listing the way iwantclips.com's
     sitemap_artist.xml does. match_performer_store therefore only ever
     checks performerStoreMap; there is no fuzzy-suggestions layer. First
     use of a new performer always requires pasting a store URL.

  2. ManyVids has NO server-side search/filter (q=, search=, keyword=,
     title=, filter= were all tried live and silently ignored -- total
     result count never changed). "Find a clip" is therefore always: fetch
     every page of a confirmed store's catalog (paginated, ~9 clips/page
     embedded per SSR page load -- NOT the 100 the query string's
     limit=100 implies, confirmed live) and fuzzy-match titles locally.
     There is no Typesense-style live query_by=title to call.

Store identifier: the NUMERIC PROFILE ID (e.g. "1004021302") is the stable,
load-bearing key -- confirmed live: a wrong slug with the correct id
silently redirects to the canonical URL (200), while a wrong id with the
correct slug 404s for real. The slug is cosmetic/display-only, never stored
as the map key. Same lesson as IWantClipsStashDB's model_username/
model_path divergence bug.

Config shape (configuration.plugins.ManyVidsStashDB):
    {
        "performerStoreMap": {
            "<normalized performer name>": {
                "profileId": "<manyvids numeric profile id>",
                "storeUrl": "<full store URL, display-only>",
                "displayName": "<spaced display name, used as the studio search term>",
                "lastUsedAt": "<ms epoch, written/updated by the JS side on a completed scrape>"
            }
        },
        "proxyUrl": "<optional HTTP/HTTPS proxy URL>"
    }

Dependencies:
    pip install requests
"""

import html as html_lib
import json
import os
import re
import sys
from difflib import SequenceMatcher

import requests

PLUGIN_ID = "ManyVidsStashDB"
RESULT_TAG = "__mv_result__"

FUZZY_MATCH_THRESHOLD = 0.90  # performer-name matching against performerStoreMap keys
# Title fuzzy-matching against a store's full clip catalog uses a looser
# threshold than performer-name matching: filename-derived title candidates
# are often partial/reordered/truncated relative to the real clip title,
# and there's no server-side query to narrow the candidate set first (see
# module docstring point 2). This is a starting point to tune against real
# usage, not a proven value the way FUZZY_MATCH_THRESHOLD is.
TITLE_MATCH_THRESHOLD = 0.50
# Guardrail only (not the primary sizing mechanism, see match_clips_in_store) --
# a result set above this size for what should be a specific title query
# usually means the parsed title candidate is too generic or the threshold
# is too loose. Surfaced plainly in the UI, never hidden.
LARGE_RESULT_WARNING = 20
MAX_STORE_PAGES = 60  # safety cap on full-catalog pagination


def log(msg):
    print(f"time='' level=info msg='[ManyVidsStashDB] {msg}'", flush=True)


# ── Local Stash connection (from server_connection, not hardcoded) ──────────

def get_stash_connection(plugin_input):
    sc = plugin_input.get("server_connection", {})
    host = sc.get("Host", "localhost")
    if host in ("0.0.0.0", "", None):
        host = "localhost"
    url = f"{sc.get('Scheme','http')}://{host}:{sc.get('Port',9999)}/graphql"
    return url, sc.get("ApiKey", "")


def local_gql(url, api_key, query, variables=None):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["ApiKey"] = api_key
    resp = requests.post(url, json={"query": query, "variables": variables or {}},
                          headers=headers, timeout=15)
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise RuntimeError(body["errors"][0]["message"])
    return body["data"]


# ── Plugin config (performerStoreMap + proxyUrl) — read-modify-write, same
# pattern as IWantClipsStashDB/TagChips' JS readConfig/writeConfig. ────────

def read_config(stash_url, api_key):
    data = local_gql(stash_url, api_key, "{ configuration { plugins } }")
    cfg = (data["configuration"]["plugins"] or {}).get(PLUGIN_ID, {})
    return {
        "performerStoreMap": cfg.get("performerStoreMap") or {},
        "proxyUrl": cfg.get("proxyUrl", ""),
    }


def write_config(stash_url, api_key, patch):
    current = read_config(stash_url, api_key)
    merged = {**current, **patch}
    local_gql(stash_url, api_key,
        "mutation Configure($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }",
        {"id": PLUGIN_ID, "input": merged})
    return merged


# ── Result store (RESULT_TAG pattern, same as IWantClipsStashDB/Data18StashDB) ──

def store_result(stash_url, api_key, result):
    encoded = json.dumps(result)
    data = local_gql(stash_url, api_key,
        f'query{{findTags(filter:{{q:"{RESULT_TAG}",per_page:1}}){{tags{{id name}}}}}}')
    tags = [t for t in data["findTags"]["tags"] if t["name"] == RESULT_TAG]
    if tags:
        local_gql(stash_url, api_key,
            "mutation U($i:TagUpdateInput!){tagUpdate(input:$i){id}}",
            {"i": {"id": tags[0]["id"], "description": encoded}})
    else:
        local_gql(stash_url, api_key,
            "mutation C($i:TagCreateInput!){tagCreate(input:$i){id}}",
            {"i": {"name": RESULT_TAG, "description": encoded}})
    log("Result stored")


def normalize(s):
    if not s:
        return ""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# ── Filename -> candidate performer/title parsing ────────────────────────────
# Ported directly from IWantClipsStashDB -- confirmed (verbally, per this
# session's investigation) that this creator's library uses the identical
# space-delimited " - " / underscore "_-_" conventions. No local sample
# files were available on this dev machine to spot-check against real
# filenames (see _self_test_parse_filename for a synthetic check built from
# real scraped clip titles instead) -- treat this as carried over, not
# independently re-verified against real ManyVids filenames, until it's
# been run against an actual saved-file library.

def unescape_title(s):
    return s.replace("_", "'")


LEADING_COUNTER_PREFIX = re.compile(r"^\d+_(.*)$")


def detect_convention(stem):
    if " - " in stem:
        return "A"
    if "_-_" in stem:
        return "B"
    return None


def parse_filename(filename, known_names):
    """known_names: a set of normalized performer names (performerStoreMap
    keys) used to find the performer/title boundary when there's no
    explicit delimiter. No sitemap-derived name set exists for ManyVids
    (see module docstring), so this is performerStoreMap-only, unlike
    IWantClipsStashDB which also folds in its sitemap cache here."""
    stem = os.path.splitext(os.path.basename(filename))[0]

    m = LEADING_COUNTER_PREFIX.match(stem)
    if m:
        stem = m.group(1)

    convention = detect_convention(stem)

    if convention == "A":
        left, _, right = stem.partition(" - ")
        return {
            "performerCandidate": left.strip(),
            "titleCandidate": unescape_title(right.strip()),
            "method": "delimiter",
        }

    if convention == "B":
        left, _, right = stem.partition("_-_")
        title_candidate = right.replace("_-_", " - ").replace("_", " ").strip()
        return {
            "performerCandidate": left.replace("_", " ").strip(),
            "titleCandidate": title_candidate,
            "method": "delimiter",
        }

    sep = "_" if "_" in stem else "-"
    tokens = [t for t in stem.split(sep) if t != ""]

    def unescape_remainder(tokens):
        joined = " ".join(tokens)
        return joined.strip() if sep == "_" else unescape_title(joined).strip()

    for i in range(len(tokens), 0, -1):
        prefix = " ".join(tokens[:i])
        if normalize(prefix) in known_names:
            remainder = tokens[i:]
            return {
                "performerCandidate": prefix,
                "titleCandidate": unescape_remainder(remainder),
                "method": "prefix-walk",
                "matchedPrefixLength": i,
            }

    performer_candidate = tokens[0] if tokens else ""
    title_candidate = unescape_remainder(tokens[1:]) if len(tokens) > 1 else ""
    return {
        "performerCandidate": performer_candidate,
        "titleCandidate": title_candidate,
        "method": "fallback",
    }


def _self_test_parse_filename():
    known_names = {"latexnchill"}

    r = parse_filename("LATEXnCHILL - Lucky Nylon Feet Lover.mp4", known_names)
    assert r == {"performerCandidate": "LATEXnCHILL", "titleCandidate": "Lucky Nylon Feet Lover", "method": "delimiter"}, r

    r = parse_filename("LATEXnCHILL_-_Popping_Balloons_just_to_Torment_You.mp4", known_names)
    assert r == {"performerCandidate": "LATEXnCHILL", "titleCandidate": "Popping Balloons just to Torment You", "method": "delimiter"}, r

    # Real scraped title with an apostrophe-as-underscore, convention A.
    r = parse_filename("LATEXnCHILL - Stripping out of my purple latex dress.mp4", known_names)
    assert r == {"performerCandidate": "LATEXnCHILL", "titleCandidate": "Stripping out of my purple latex dress", "method": "delimiter"}, r

    r = parse_filename("2_LATEXnCHILL - Merciless pegging of a weak bitch.mp4", known_names)
    assert r == {"performerCandidate": "LATEXnCHILL", "titleCandidate": "Merciless pegging of a weak bitch", "method": "delimiter"}, r

    print("All parse_filename self-tests passed.")


# ── Store page fetch + Next.js RSC payload parsing ───────────────────────────
# Confirmed live: ManyVids' store pages are server-rendered (plain requests
# work, no JS/CDP needed). The full clip list for a page is embedded inside
# `self.__next_f.push([1, "<escaped JSON>"])` script calls (Next.js App
# Router's RSC streaming format), not a separately callable JSON API --
# direct requests to the internal fetch key as a standalone endpoint 404/308.
# There IS no true page-size limit found beyond what's embedded: confirmed
# live the SSR embeds ~9 clips/page regardless of the 'limit=100' visible in
# the cache key text -- paginate via ?page=N on the store page URL itself
# until currentPage == totalPages.

def _make_session(proxy_url=""):
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
        log(f"Using outbound proxy: {proxy_url}")
    return session


_NEXT_F_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,(".*?")\]\)', re.S)
_FLIGHT_LABEL_RE = re.compile(r"^([0-9a-zA-Z_]+):")


def _iter_next_f_payloads(page_html):
    """Each self.__next_f.push([1, "..."]) call carries one escaped-JSON
    string that decodes to `<label>:<value>`, where <value> is usually
    (but not always) a standalone JSON document -- some chunks are partial
    Flight-protocol fragments that don't parse alone. Best-effort: skip
    whatever doesn't parse rather than trying to fully implement the RSC
    wire format."""
    for m in _NEXT_F_PUSH_RE.finditer(page_html):
        try:
            s = json.loads(m.group(1))
        except Exception:
            continue
        s = s.rstrip("\n")
        lm = _FLIGHT_LABEL_RE.match(s)
        if not lm:
            continue
        try:
            yield json.loads(s[lm.end():])
        except Exception:
            continue


def _find_all(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            yield obj[key]
        for v in obj.values():
            yield from _find_all(v, key)
    elif isinstance(obj, list):
        for item in obj:
            yield from _find_all(item, key)


def _extract_clips_and_meta(value):
    """The swrFallback value's exact nesting differs depending on how the
    page was requested (confirmed live: a direct ?page=N SSR load nests one
    level shallower than the homepage's initial in-memory fallback) -- walk
    the structure looking for a list of clip dicts (each has an 'id') and a
    pagination-meta dict (has 'totalPages'), instead of assuming a fixed
    shape."""
    clips, meta = None, None

    def walk(x):
        nonlocal clips, meta
        if clips is not None and meta is not None:
            return
        if isinstance(x, list):
            if x and all(isinstance(i, dict) and "id" in i for i in x):
                if clips is None:
                    clips = x
                return
            for item in x:
                walk(item)
        elif isinstance(x, dict):
            if "totalPages" in x:
                if meta is None:
                    meta = x
                return
            for v in x.values():
                walk(v)

    walk(value)
    return clips, meta


def _resolve_canonical_store_url(profile_id, session):
    """The id-only URL (no slug) 200s, but confirmed live that a 308
    redirect to the canonical slugged URL DROPS any query string --
    ?page=N silently becomes page 1 again if fetched against the id-only
    URL. So the slugged URL is resolved once per crawl (via this redirect)
    and reused for ?page=N on every subsequent page -- the slug itself is
    still never stored/trusted as the identifier, just borrowed for one
    crawl's pagination."""
    resp = session.get(f"https://www.manyvids.com/Profile/{profile_id}/Store/Videos", timeout=20)
    resp.raise_for_status()
    return resp.url, resp.text


def fetch_store_page(base_store_url, page_num, session, listing="main", first_page_html=None):
    """listing="main" is the store's regular catalog (sort=.../page=N,
    excluding the bundle-promo variant). listing="vertical" is a genuinely
    separate subset -- confirmed live that the 3 vertical-tagged clips on
    the reference store do NOT appear anywhere in the 351-item main
    catalog, so a full-catalog crawl that only reads the main listing
    silently misses them. Both must be fetched and merged for a complete
    picture of the store."""
    if page_num == 1 and first_page_html is not None:
        page_html = first_page_html
    else:
        resp = session.get(f"{base_store_url}?page={page_num}", timeout=20)
        resp.raise_for_status()
        page_html = resp.text

    for payload in _iter_next_f_payloads(page_html):
        for fb in _find_all(payload, "swrFallback"):
            for key, value in fb.items():
                if "bundle" in key:
                    continue
                is_vertical_key = "vertical=1" in key
                if listing == "vertical" and not is_vertical_key:
                    continue
                if listing == "main" and is_vertical_key:
                    continue
                if f"page={page_num}" not in key:
                    continue
                clips, meta = _extract_clips_and_meta(value)
                if clips is not None:
                    return clips, meta or {}
    return [], {}


def _fetch_listing_all_pages(base_store_url, session, listing, first_page_html, max_pages):
    clips_out = []
    page_num = 1
    total_pages = None
    while True:
        clips, meta = fetch_store_page(base_store_url, page_num, session, listing=listing,
                                        first_page_html=first_page_html if page_num == 1 else None)
        if not clips:
            break
        clips_out.extend(clips)
        if total_pages is None:
            total_pages = meta.get("totalPages")
        log(f"Fetched {listing} store page {page_num}{f'/{total_pages}' if total_pages else ''} "
            f"({len(clips)} clips, {len(clips_out)} {listing} total so far)")
        page_num += 1
        if total_pages and page_num > total_pages:
            break
        if page_num > max_pages:
            log(f"Hit max_pages safety cap ({max_pages}) for {listing} listing -- stopping early")
            break
    return clips_out


def fetch_all_store_clips(profile_id, proxy_url="", max_pages=MAX_STORE_PAGES):
    session = _make_session(proxy_url)
    base_store_url, first_page_html = _resolve_canonical_store_url(profile_id, session)

    all_clips = []
    seen_ids = set()
    for listing in ("main", "vertical"):
        for c in _fetch_listing_all_pages(base_store_url, session, listing, first_page_html, max_pages):
            cid = c.get("id")
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                all_clips.append(c)
    return all_clips


# ── Store confirmation (performerStoreMap only -- no directory/sitemap
# equivalent exists for ManyVids, see module docstring point 1) ─────────────

def match_performer_store(candidate_name, performer_store_map):
    norm = normalize(candidate_name)
    if norm in performer_store_map:
        entry = performer_store_map[norm]
        return {
            "confidence": "confident",
            "source": "performerStoreMap",
            "match": {
                "profileId": entry["profileId"],
                "storeUrl": entry.get("storeUrl") or store_url_for(entry["profileId"]),
                "displayName": entry.get("displayName") or entry["profileId"],
            },
            "score": 1.0,
            "suggestions": [],
        }
    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": []}


def store_url_for(profile_id):
    return f"https://www.manyvids.com/Profile/{profile_id}/Store/Videos"


# ── Local title fuzzy-matching against a confirmed store's full catalog
# (replaces IWantClips' live Typesense query_by=title -- no server-side
# search exists on ManyVids, see module docstring point 2) ──────────────────

def clip_page_url(clip):
    return f"https://www.manyvids.com/Video/{clip.get('id')}/{clip.get('slug')}"


def match_clips_in_store(profile_id, title_candidate, proxy_url=""):
    clips = fetch_all_store_clips(profile_id, proxy_url=proxy_url)
    norm_query = normalize(title_candidate)

    scored = []
    for c in clips:
        score = SequenceMatcher(None, norm_query, normalize(c.get("title") or "")).ratio()
        if score >= TITLE_MATCH_THRESHOLD:
            scored.append((score, c))
    scored.sort(key=lambda x: x[0], reverse=True)

    hits = []
    for score, c in scored:
        price = (c.get("price") or {}).get("regular")
        thumbnail = (c.get("thumbnail") or {}).get("url", "")
        hits.append({
            "title": c.get("title", ""),
            "contentUrl": clip_page_url(c),
            "price": price,
            "publishDate": c.get("launchDate"),
            "description": c.get("description", ""),
            "thumbnail": thumbnail,
            "score": round(score, 3),
        })

    return {
        "found": len(hits),
        "totalInStore": len(clips),
        "largeResultWarning": len(hits) > LARGE_RESULT_WARNING,
        "hits": hits,
    }


# ── Single-clip scraping (VideoObject JSON-LD -- clean structured data, no
# HTML-label fallback needed the way IWantClipsStashDB's date extraction
# required) ───────────────────────────────────────────────────────────────
# Field-mapping notes (flagged per investigation):
#   - VideoObject.contentUrl is the raw CDN video FILE link, not a
#     bookmarkable clip page -- deliberately NOT used anywhere here. The
#     scene "URLs" field is populated from the clip PAGE url this function
#     was called with (passed in from the match_clips hit, same pattern as
#     IWantClipsStashDB's hit.contentUrl), not from JSON-LD.
#   - VideoObject.creator is a single object (one name), not a "performer"
#     array like IWantClips' JSON-LD -- mapped to a one-item performers list.
#   - duration ("PT8M9S" ISO 8601) is present but unused: IWantClipsStashDB's
#     comparison table has no duration row either (Stash derives scene
#     duration from the file itself), so no conversion logic was added.

def _clean_ld_json(raw):
    if not raw:
        return raw
    raw = re.sub(r"[\x00-\x1F\x7F]", " ", raw)
    raw = raw.replace("\n", " ").replace("\t", " ")
    return raw.strip()


def _find_json_ld_objects(page_html):
    objects = []
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', page_html, re.S):
        try:
            objects.append(json.loads(_clean_ld_json(m.group(1))))
        except Exception:
            pass
    return objects


def scrape_clip(url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(url, timeout=20)
    resp.raise_for_status()

    objects = _find_json_ld_objects(resp.text)
    video_obj = next((o for o in objects if o.get("@type") == "VideoObject"), None)
    if not video_obj:
        raise RuntimeError(f"No VideoObject JSON-LD found on clip page: {url}")

    title = html_lib.unescape(video_obj.get("name") or "").strip()
    if not title:
        raise RuntimeError(f"Could not extract clip metadata (no VideoObject 'name' field) from: {url}")

    description = html_lib.unescape((video_obj.get("description") or "").strip())

    upload_date = video_obj.get("uploadDate") or ""
    date = upload_date[:10] if len(upload_date) >= 10 else None

    creator = video_obj.get("creator")
    creator_name = creator.get("name") if isinstance(creator, dict) else None
    performers = [html_lib.unescape(creator_name)] if creator_name else []

    return {"url": url, "title": title, "date": date, "performers": performers, "description": description}


# ── Local performer/studio resolution (identical to IWantClipsStashDB,
# just using this file's own normalize/local_gql) ───────────────────────────

def _query_token(name):
    m = re.search(r"[A-Za-z]+", name)
    return m.group(0) if m else name


def resolve_performer(name, stash_url, api_key):
    clean_name = name.strip()
    norm = normalize(clean_name)
    token = _query_token(clean_name)

    def query(search_value):
        data = local_gql(stash_url, api_key, """
            query PerformerByName($name: String!) {
                findPerformers(performer_filter: { name: { value: $name, modifier: INCLUDES } }) {
                    performers { id name alias_list disambiguation }
                }
            }
        """, {"name": search_value})
        return data["findPerformers"]["performers"]

    performers = query(token)
    if not performers and len(token) > 1:
        for i in range(len(token) - 1, 0, -1):
            performers = query(token[:i])
            if performers:
                break

    for p in performers:
        p["_normName"] = normalize(p["name"])
        p["_normAliases"] = [normalize(a) for a in (p.get("alias_list") or [])]
        p["_normDis"] = normalize(p.get("disambiguation"))

    for p in performers:
        if p["_normName"] == norm:
            return {"name": name, "localId": p["id"], "found": True, "matchType": "exact"}
    for p in performers:
        if norm in p["_normAliases"]:
            return {"name": name, "localId": p["id"], "found": True, "matchType": "alias"}
    for p in performers:
        if p["_normDis"] == norm:
            return {"name": name, "localId": p["id"], "found": True, "matchType": "disambiguation"}

    best, best_score = None, 0
    for p in performers:
        score = SequenceMatcher(None, norm, p["_normName"]).ratio()
        if score > best_score:
            best_score, best = score, p
    if best and best_score >= FUZZY_MATCH_THRESHOLD:
        return {"name": name, "localId": best["id"], "found": True, "matchType": "fuzzy", "score": round(best_score, 3)}

    return {"name": name, "localId": None, "found": False}


def resolve_studio(name, stash_url, api_key):
    if not name:
        return {"name": "", "localId": None, "found": False}
    clean_name = name.strip()
    norm = normalize(clean_name)
    token = _query_token(clean_name)

    def query(search_value):
        data = local_gql(stash_url, api_key, """
            query StudioByName($name: String!) {
                findStudios(studio_filter: { name: { value: $name, modifier: INCLUDES } }) {
                    studios { id name }
                }
            }
        """, {"name": search_value})
        return data["findStudios"]["studios"]

    studios = query(token)
    if not studios and len(token) > 1:
        for i in range(len(token) - 1, 0, -1):
            studios = query(token[:i])
            if studios:
                break

    for s in studios:
        if normalize(s["name"]) == norm:
            return {"name": name, "localId": s["id"], "found": True, "matchType": "exact"}
    if studios:
        return {"name": name, "localId": studios[0]["id"], "found": True, "matchType": "first-result"}
    return {"name": name, "localId": None, "found": False}


def main():
    raw = sys.stdin.read().strip()
    plugin_input = json.loads(raw) if raw else {}
    args = plugin_input.get("args", {})
    mode = args.get("mode", "")
    stash_url, api_key = get_stash_connection(plugin_input)

    try:
        if mode == "test_config":
            current = read_config(stash_url, api_key)
            test_map = dict(current["performerStoreMap"])
            test_map["_configtest"] = {
                "profileId": "0",
                "storeUrl": "https://example.invalid/Profile/0/_configtest/Store/Videos",
            }
            write_config(stash_url, api_key, {"performerStoreMap": test_map})
            verify = read_config(stash_url, api_key)
            ok = verify["performerStoreMap"].get("_configtest", {}).get("profileId") == "0"

            test_map.pop("_configtest", None)
            write_config(stash_url, api_key, {"performerStoreMap": test_map})

            result = {"ok": ok, "message": "Config round-trip succeeded" if ok else "Config round-trip FAILED"}

        elif mode == "parse_filename":
            filename = args.get("filename", "")
            settings = read_config(stash_url, api_key)
            known_names = set(settings["performerStoreMap"].keys())
            parsed = parse_filename(filename, known_names)
            result = {"ok": True, "output": parsed}

        elif mode == "match_performer":
            performer_name = args.get("performer_name", "")
            settings = read_config(stash_url, api_key)
            match = match_performer_store(performer_name, settings["performerStoreMap"])
            result = {"ok": True, "output": match}

        elif mode == "match_clips":
            profile_id = args.get("profile_id", "")
            query_text = args.get("query_text", "")
            if not profile_id:
                raise RuntimeError("match_clips requires profile_id")
            settings = read_config(stash_url, api_key)
            output = match_clips_in_store(profile_id, query_text, proxy_url=settings.get("proxyUrl", ""))
            result = {"ok": True, "output": output}

        elif mode == "scrape_clip":
            url = args.get("url", "")
            studio_name = args.get("studio_name", "")
            if not url:
                raise RuntimeError("scrape_clip requires a url")
            settings = read_config(stash_url, api_key)
            scraped = scrape_clip(url, proxy_url=settings.get("proxyUrl", ""))
            resolved_performers = [resolve_performer(p, stash_url, api_key) for p in scraped["performers"]]
            resolved_studio = resolve_studio(studio_name, stash_url, api_key)
            result = {
                "ok": True,
                "output": {
                    "scraped": scraped,
                    "resolvedPerformers": resolved_performers,
                    "resolvedStudio": resolved_studio,
                },
            }

        else:
            result = {"ok": False, "error": f"Unknown mode: {mode!r}"}
    except Exception as e:
        log(f"Error: {e}")
        result = {"ok": False, "error": str(e)}

    store_result(stash_url, api_key, result)
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        _self_test_parse_filename()
    else:
        main()
