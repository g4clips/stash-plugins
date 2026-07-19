"""
IWantClipsStashDB.py — Plugin backend.

Staged build. Config plumbing, sitemap-based store discovery, and
Typesense in-store search (Steps 1-4) plus single-clip scraping and
local performer/studio resolution (Step 5), ported from a working
reference script that scraped one known clip page via JSON-LD.

Config shape (configuration.plugins.IWantClipsStashDB):
    {
        "performerStoreMap": {
            "<normalized performer name>": {
                "modelUsername": "<iwantclips store slug>",
                "storeUrl": "<full store URL>",
                "displayName": "<spaced display name, used as the studio search term>",
                "lastUsedAt": "<ms epoch, written/updated by the JS side on a completed scrape>"
            }
        },
        "proxyUrl": "<optional HTTP/HTTPS proxy URL>"
    }

Dependencies:
    pip install requests beautifulsoup4
"""

import datetime
import html as html_lib
import json
import os
import re
import sys
import time
from difflib import SequenceMatcher

import requests
from bs4 import BeautifulSoup

PLUGIN_ID = "IWantClipsStashDB"
RESULT_TAG = "__iwc_result__"

SITEMAP_URL = "https://iwantclips.com/sitemap/artist/sitemap_artist.xml"
SITEMAP_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sitemap_cache.json")
# The sitemap is static/no-auth and empirically doesn't change often (confirmed
# during investigation) -- a week-long cache keeps this to one real fetch per
# week instead of one per scrape.
SITEMAP_CACHE_MAX_AGE = 7 * 24 * 3600
FUZZY_MATCH_THRESHOLD = 0.90  # same threshold the reference script already uses


def log(msg):
    print(f"time='' level=info msg='[IWantClipsStashDB] {msg}'", flush=True)


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
# pattern as TagChips' JS readConfig/writeConfig, mirrored here in Python
# since the discovery routine (Step 3) needs to read it server-side. ───────

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


# ── Result store (RESULT_TAG pattern, same as Data18StashDB/SubmitToMyStashBox) ──

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
# Always a pre-fill for the user to review/edit -- never auto-committed.

def unescape_title(s):
    # Filesystem-unsafe characters get substituted when clips are saved
    # locally; "_" standing in for an apostrophe is the one confirmed
    # convention so far. Extend this if other substitutions turn up in
    # real files.
    return s.replace("_", "'")


LEADING_COUNTER_PREFIX = re.compile(r"^\d+_(.*)$")


def detect_convention(stem):
    """Two confirmed real-world filename families (see 25-file sample):
    'Performer - Title with spaces' (A) vs 'Performer_-_Title_with_underscores'
    (B), where "_" is a pure space substitute, not an apostrophe escape.
    Returns "A", "B", or None if neither delimiter is present."""
    if " - " in stem:
        return "A"
    if "_-_" in stem:
        return "B"
    return None


def parse_filename(filename, known_names):
    """known_names: a set of normalized performer names (performerStoreMap
    keys + sitemap slugs) used to find the performer/title boundary when
    there's no explicit delimiter."""
    stem = os.path.splitext(os.path.basename(filename))[0]

    # Strip a leading numeric counter prefix (e.g. "2_") before anything else.
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
        # Preserve any LATER "_-_" inside the title as " - " rather than
        # collapsing it to two separate words, then convert remaining
        # underscores (pure word-space substitutes in this convention) to
        # spaces -- never apostrophes, that rule is convention A only.
        title_candidate = right.replace("_-_", " - ").replace("_", " ").strip()
        return {
            "performerCandidate": left.replace("_", " ").strip(),
            "titleCandidate": title_candidate,
            "method": "delimiter",
        }

    # No recognized delimiter -- walk decreasing prefixes against known
    # names. Token separator matches whichever the filename actually uses.
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

    # Nothing recognized -- weakest possible guess (first token as the
    # performer name), still just a pre-fill for the user to correct.
    performer_candidate = tokens[0] if tokens else ""
    title_candidate = unescape_remainder(tokens[1:]) if len(tokens) > 1 else ""
    return {
        "performerCandidate": performer_candidate,
        "titleCandidate": title_candidate,
        "method": "fallback",
    }


def _self_test_parse_filename():
    known_names = {"londonlix", "brattynikki"}

    # Convention A baseline -- must not regress. "_" here means apostrophe,
    # per the original confirmed example.
    r = parse_filename("BrattyNikki - Loser_s Tribute Duty.mp4", known_names)
    assert r == {"performerCandidate": "BrattyNikki", "titleCandidate": "Loser's Tribute Duty", "method": "delimiter"}, r

    # Convention B basic case -- "_" here means space, not apostrophe.
    r = parse_filename("London_Lix_-_Prove_It_CEI.mp4", known_names)
    assert r == {"performerCandidate": "London Lix", "titleCandidate": "Prove It CEI", "method": "delimiter"}, r

    # Convention B with a title-internal "_-_" -- must become " - ", not
    # collapse into two separate words.
    r = parse_filename("London_Lix_-_Aftercare_-_Mesmerize.mp4", known_names)
    assert r == {"performerCandidate": "London Lix", "titleCandidate": "Aftercare - Mesmerize", "method": "delimiter"}, r

    # Leading digit-counter prefix must be stripped before parsing proceeds.
    r = parse_filename("2_Mistress Damazonia - Merciless pegging of a weak bitch.mp4", known_names)
    assert r == {
        "performerCandidate": "Mistress Damazonia",
        "titleCandidate": "Merciless pegging of a weak bitch",
        "method": "delimiter",
    }, r

    print("All parse_filename self-tests passed.")


# ── Sitemap-based store discovery ────────────────────────────────────────────

def parse_sitemap_xml(xml_text):
    performers = {}
    for m in re.finditer(r"<loc>\s*(https?://[^<]*?/store/(\d+)/([^<\s]+))\s*</loc>", xml_text):
        full_url, model_id, slug = m.group(1), m.group(2), m.group(3)
        display_name = slug.replace("-", " ")
        performers[normalize(display_name)] = {
            "modelUsername": slug,
            "storeUrl": full_url,
            "displayName": display_name,
        }
    return performers


def fetch_sitemap_cache(proxy_url="", force=False):
    if not force and os.path.exists(SITEMAP_CACHE_PATH):
        try:
            with open(SITEMAP_CACHE_PATH, "r", encoding="utf-8") as f:
                cache = json.load(f)
            age = time.time() - cache.get("fetchedAt", 0)
            if age < SITEMAP_CACHE_MAX_AGE and cache.get("performers"):
                return cache
        except Exception:
            pass  # corrupt/unreadable cache -- refetch below

    log("Fetching sitemap_artist.xml (cache stale or missing)")
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
        log(f"Using outbound proxy: {proxy_url}")

    resp = session.get(SITEMAP_URL, timeout=30)
    resp.raise_for_status()
    performers = parse_sitemap_xml(resp.text)
    if not performers:
        raise RuntimeError("Sitemap fetch succeeded but no store URLs were parsed -- format may have changed")

    cache = {"fetchedAt": time.time(), "performers": performers}
    with open(SITEMAP_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    log(f"Cached {len(performers)} performer store URLs")
    return cache


def match_performer_store(candidate_name, performer_store_map, sitemap_cache):
    norm = normalize(candidate_name)
    sitemap_performers = sitemap_cache.get("performers", {})

    # 1. Already confirmed for this performer -- always green/one-click.
    # displayName may be absent on entries written before this field existed;
    # fall back to modelUsername so studio-name lookups always get *something*.
    if norm in performer_store_map:
        entry = performer_store_map[norm]
        return {
            "confidence": "confident",
            "source": "performerStoreMap",
            "match": {
                "modelUsername": entry["modelUsername"],
                "storeUrl": entry["storeUrl"],
                "displayName": entry.get("displayName") or entry["modelUsername"],
            },
            "score": 1.0,
            "suggestions": [],
        }

    # 2. Exact normalized hit against the sitemap.
    if norm in sitemap_performers:
        entry = sitemap_performers[norm]
        return {
            "confidence": "confident",
            "source": "sitemap_exact",
            "match": {
                "modelUsername": entry["modelUsername"],
                "storeUrl": entry["storeUrl"],
                "displayName": entry["displayName"],
            },
            "score": 1.0,
            "suggestions": [],
        }

    # 3. Fuzzy match across all sitemap slugs. Only runs on a miss, not per
    # bulk request, so the O(n) scan over ~19k entries is fine here.
    scored = []
    for slug_norm, entry in sitemap_performers.items():
        score = SequenceMatcher(None, norm, slug_norm).ratio()
        if score > 0.55:
            scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    suggestions = [
        {
            "modelUsername": e["modelUsername"],
            "storeUrl": e["storeUrl"],
            "displayName": e["displayName"],
            "score": round(s, 3),
        }
        for s, e in scored[:5]
    ]

    if scored and scored[0][0] >= FUZZY_MATCH_THRESHOLD:
        best_score, best_entry = scored[0]
        return {
            "confidence": "confident",
            "source": "sitemap_fuzzy",
            "match": {
                "modelUsername": best_entry["modelUsername"],
                "storeUrl": best_entry["storeUrl"],
                "displayName": best_entry["displayName"],
            },
            "score": round(best_score, 3),
            "suggestions": suggestions,
        }

    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": suggestions}


# ── Typesense search within a confirmed store ────────────────────────────────
# iwantclips.com's own sitewide/in-store search runs on Typesense (confirmed
# live during investigation: host bajc2td3pou5fs7mp.a1.typesense.net,
# collection alias "prod_content"). The client config, including a short-lived
# (~1hr) scoped search API key, is embedded in every store page's inline
# script -- there is no stable/documented public API for this, so it's
# extracted fresh from a live page on every call, never cached, and any
# extraction failure raises loudly rather than silently degrading.

_TS_API_KEY_RE = re.compile(r"apiKey:\s*'([^']+)'")
_TS_HOST_RE = re.compile(r"host:\s*'([^']+)'")
_TS_PORT_RE = re.compile(r"port:\s*'([^']+)'")
_TS_PROTOCOL_RE = re.compile(r"protocol:\s*'([^']+)'")
_TS_INDEX_RE = re.compile(r'index:\s*"([^"]+)"')


def _make_session(proxy_url=""):
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
        log(f"Using outbound proxy: {proxy_url}")
    return session


def fetch_typesense_client_config(store_url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(store_url, timeout=20)
    resp.raise_for_status()
    page_html = resp.text

    matches = {
        "apiKey": _TS_API_KEY_RE.search(page_html),
        "host": _TS_HOST_RE.search(page_html),
        "port": _TS_PORT_RE.search(page_html),
        "protocol": _TS_PROTOCOL_RE.search(page_html),
        "collection": _TS_INDEX_RE.search(page_html),
    }
    missing = [name for name, m in matches.items() if not m]
    if missing:
        # Fail loudly -- this is an unofficial, reverse-engineered
        # integration point (no public API contract), so a shifted
        # frontend bundle must surface as a clear error, never an empty
        # or silently-wrong result.
        raise RuntimeError(
            "Could not extract Typesense search config from the iwantclips "
            f"store page (missing: {', '.join(missing)}). The site's "
            "frontend may have changed -- this integration needs to be "
            "re-checked, not worked around."
        )

    return {name: m.group(1) for name, m in matches.items()}


def _extract_model_path(store_url):
    """Typesense's model_username field is NOT reliably the same as the
    sitemap/URL-slug -- confirmed live that for multi-word display names
    it can be space-joined (e.g. "Domina Elara") while the URL slug is
    hyphenated (e.g. "Domina-Elara"), causing filter_by=model_username:=
    to silently return zero results. model_path (e.g.
    "store/832517/Domina-Elara"), also present on every Typesense hit,
    was confirmed to exactly match the URL slug in both the broken and
    the previously-working case, so it's built directly from storeUrl
    (already user-verified) instead."""
    m = re.search(r"/store/(\d+)/([^/?#]+)", store_url)
    if not m:
        raise RuntimeError(f"Could not parse a store/<id>/<slug> path out of storeUrl: {store_url}")
    return f"store/{m.group(1)}/{m.group(2)}"


def search_store(store_url, model_username, query_text, proxy_url="", per_page=20):
    # model_username is kept in the signature/task-args contract for
    # interface stability (the JS caller and "Search Store" task both
    # still pass it), but is no longer used for filtering -- see
    # _extract_model_path.
    config = fetch_typesense_client_config(store_url, proxy_url=proxy_url)
    model_path = _extract_model_path(store_url)
    search_url = (
        f"{config['protocol']}://{config['host']}:{config['port']}"
        f"/collections/{config['collection']}/documents/search"
    )
    params = {
        "q": query_text.strip() or "*",
        "query_by": "title",
        "filter_by": f"model_path:={model_path}",
        "per_page": per_page,
    }

    session = _make_session(proxy_url)
    resp = session.get(search_url, params=params,
                        headers={"x-typesense-api-key": config["apiKey"]}, timeout=20)
    resp.raise_for_status()
    body = resp.json()
    if "hits" not in body:
        raise RuntimeError(f"Typesense search returned an unexpected shape: {body}")

    hits = []
    for h in body["hits"]:
        doc = h.get("document", {})
        hits.append({
            "title": doc.get("title", ""),
            "contentUrl": doc.get("content_url", ""),
            "price": doc.get("price"),
            "category": doc.get("category", ""),
            "publishDate": doc.get("publish_date"),
            "description": doc.get("description", ""),
            "thumbnail": doc.get("thumbnail_url") or doc.get("preview_url") or "",
        })
    return {"found": body.get("found", len(hits)), "hits": hits}


# ── Single-clip scraping (ported from the working reference script) ─────────
# The reference script's date extraction fell back to fragile HTML span
# scraping ("Published Date" label lookup); confirmed during Step 4's
# investigation that the JSON-LD VideoObject already carries a clean
# "uploadDate" field, so that's used directly instead -- same data source
# the reference script already parsed, just not duplicated via HTML.

def _clean_ld_json(raw):
    if not raw:
        return raw
    raw = re.sub(r"[\x00-\x1F\x7F]", " ", raw)
    raw = re.sub(r"//.*?\n", " ", raw)
    raw = re.sub(r"/\*.*?\*/", " ", raw, flags=re.DOTALL)
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


def _search_for_key(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = _search_for_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _search_for_key(item, key)
            if found is not None:
                return found
    return None


def _extract_published_date(page_html):
    """Scrapes the page's labeled "Published Date" field. This is the
    canonical source -- confirmed live that the JSON-LD VideoObject's
    "uploadDate" field can be wrong by years for the same clip (verified
    example: JSON-LD said 2014-04-09, the page's own Published Date label
    and Typesense's publish_date both agreed on Feb 2023). Handles both
    date formats the original reference script accounted for."""
    soup = BeautifulSoup(page_html, "html.parser")
    label_span = soup.find("span", string=lambda s: s and "Published Date" in s)
    if not label_span:
        return None
    label_div = label_span.find_parent("div")
    value_container = label_div.find_next_sibling("div") if label_div else None
    value_span = value_container.find("span") if value_container else None
    if not value_span:
        return None
    raw_date = value_span.get_text(strip=True)

    if "/" in raw_date:
        date_part = raw_date.split()[0]
        parts = date_part.split("/")
        if len(parts) == 3:
            month, day, year = parts
            return f"20{year}-{month}-{day}"
        return None

    try:
        return datetime.datetime.strptime(raw_date, "%b %d, %Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def scrape_clip(url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(url, timeout=20)
    resp.raise_for_status()

    objects = _find_json_ld_objects(resp.text)
    if not objects:
        raise RuntimeError(f"No JSON-LD found on clip page: {url}")

    data = {"url": url, "title": None, "date": None, "performers": [], "description": None}

    for obj in objects:
        title = _search_for_key(obj, "name")
        if title:
            data["title"] = html_lib.unescape(title)
            break

    for obj in objects:
        desc = _search_for_key(obj, "description")
        if desc:
            data["description"] = html_lib.unescape(
                desc.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n").strip()
            )
            break

    for obj in objects:
        performers = _search_for_key(obj, "performer")
        if isinstance(performers, list):
            data["performers"] = [
                html_lib.unescape(p.get("name")) for p in performers
                if isinstance(p, dict) and p.get("name")
            ]
            break

    data["date"] = _extract_published_date(resp.text)

    if not data["title"]:
        raise RuntimeError(f"Could not extract clip metadata (no JSON-LD 'name' field) from: {url}")

    return data


# ── Local performer/studio resolution (ported from the reference script,
# using local_gql instead of raw requests, and this file's own normalize) ────

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
            # Round-trip check: write a dummy performerStoreMap entry, read
            # it back, then clean up. Confirms configurePlugin/readConfig
            # actually persist against this plugin's real id.
            current = read_config(stash_url, api_key)
            test_map = dict(current["performerStoreMap"])
            test_map["_configtest"] = {
                "modelUsername": "_configtest",
                "storeUrl": "https://example.invalid/store/0/_configtest",
            }
            write_config(stash_url, api_key, {"performerStoreMap": test_map})
            verify = read_config(stash_url, api_key)
            ok = verify["performerStoreMap"].get("_configtest", {}).get("modelUsername") == "_configtest"

            test_map.pop("_configtest", None)
            write_config(stash_url, api_key, {"performerStoreMap": test_map})

            result = {"ok": ok, "message": "Config round-trip succeeded" if ok else "Config round-trip FAILED"}

        elif mode == "refresh_sitemap":
            settings = read_config(stash_url, api_key)
            cache = fetch_sitemap_cache(proxy_url=settings.get("proxyUrl", ""), force=True)
            result = {"ok": True, "message": f"Cached {len(cache['performers'])} performer store URLs"}

        elif mode == "parse_filename":
            filename = args.get("filename", "")
            settings = read_config(stash_url, api_key)
            cache = fetch_sitemap_cache(proxy_url=settings.get("proxyUrl", ""))
            known_names = set(settings["performerStoreMap"].keys()) | set(cache["performers"].keys())
            parsed = parse_filename(filename, known_names)
            result = {"ok": True, "output": parsed}

        elif mode == "match_performer":
            performer_name = args.get("performer_name", "")
            settings = read_config(stash_url, api_key)
            cache = fetch_sitemap_cache(proxy_url=settings.get("proxyUrl", ""))
            match = match_performer_store(performer_name, settings["performerStoreMap"], cache)
            result = {"ok": True, "output": match}

        elif mode == "search_store":
            store_url = args.get("store_url", "")
            model_username = args.get("model_username", "")
            query_text = args.get("query_text", "")
            if not store_url or not model_username:
                raise RuntimeError("search_store requires both store_url and model_username")
            settings = read_config(stash_url, api_key)
            output = search_store(store_url, model_username, query_text,
                                   proxy_url=settings.get("proxyUrl", ""))
            result = {"ok": True, "output": output}

        elif mode == "scrape_clip":
            url = args.get("url", "")
            # The confirmed store's spaced display name (e.g. "Bratty Nikki"),
            # not the raw slug -- Stash's INCLUDES studio search won't
            # substring-match across a missing space (e.g. "BrattyNikki"
            # against a studio literally named "Bratty Nikki").
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
