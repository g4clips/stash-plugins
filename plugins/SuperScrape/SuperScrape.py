"""
SuperScrape.py — Plugin backend.

Unifies IWantClipsStashDB and ManyVidsStashDB into one plugin with a
site-adapter architecture, so future sites can be added as additional
adapters without another redesign -- clips4sale is the first proof of that
claim, added as a third adapter with no changes to the iwantclips/manyvids
adapter code, only additive dispatch branches. Data18 stays standalone
(per explicit decision), not touched here.

This is a REORGANIZATION of already-verified logic from the source
plugins, not a rewrite -- every bug fix from their history is carried
over unchanged:
  - alias-matching OR-query in resolve_performer (name INCLUDES OR aliases
    INCLUDES -- a performer whose real name doesn't contain the candidate
    token but whose alias_list does would otherwise never enter the
    candidate set)
  - ManyVids canonical-URL redirect handling (?page=N against the id-only
    URL silently drops the query string on redirect -- resolve the
    slugged URL once per crawl and reuse it)
  - ManyVids vertical-catalog merge (vertical-tagged clips are a genuinely
    separate listing from the main catalog, not a subset -- both must be
    fetched)
  - ManyVids catalog caching with a sliding staleness window (a confirmed-
    fresh cache hit bumps cachedAt forward too, not just a full re-crawl)
  - cover_image as a plain String on SceneUpdateInput (URL or base64 data
    URL, no separate upload/imageCreate step)

clips4sale ARCHITECTURAL NOTE: performer != studio on this site -- a
performer's content can be split across multiple studios (confirmed live:
"Mina Thorne" has clips under both her own studio and a different one).
A performer-name search hit is therefore NEVER allowed to auto-confirm a
store; only sitemap-based studio-identity matching can return a confident
match. Search results are folded into "suggestions" instead (see
discover()), which the existing UI already renders as click-to-prefill,
never auto-confirming chips -- this did NOT need a third confidence state
beyond the existing "confident"/"none".

CONFIG SHAPE (configuration.plugins.SuperScrape) -- single source of
truth, read/written IDENTICALLY by SuperScrape.py and SuperScrape.js.
*** These two readConfig implementations must stay in sync -- any new
field added to one MUST be added to the other in the same change. ***
This is the exact class of bug found in ManyVidsStashDB this session
(JS readConfig() not knowing about a field Python wrote -- storeCatalogCache
-- causing the very next JS-side writeConfig() to silently drop it). Clean
break from IWantClipsStashDB/ManyVidsStashDB's configs -- no migration,
those plugins' configs are left untouched.
    {
        "performerStoreMap": {
            "<normalized performer name>": {
                "site": "iwantclips" | "manyvids" | "clips4sale",
                "modelUsername": "<iwantclips store slug>",       # iwantclips only
                "profileId": "<manyvids numeric profile id>",     # manyvids only
                "studioId": "<clips4sale numeric studio id>",     # clips4sale only
                "storeUrl": "<full store URL>",
                "displayName": "<spaced display name>",
                "lastUsedAt": "<ms epoch>"
            }
        },
        "storeCatalogCache": {
            # manyvids-specific, but lives in the shared config; iwantclips
            # and clips4sale entries simply never populate this key (both
            # have real working search, no local catalog cache needed).
            "<profileId>": {
                "clips": [...], "mainTotal": N, "verticalTotal": N, "cachedAt": <epoch seconds>
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
from urllib.parse import urlparse, quote

import requests
from bs4 import BeautifulSoup

PLUGIN_ID = "SuperScrape"
RESULT_TAG = "__superscrape_result__"

FUZZY_MATCH_THRESHOLD = 0.90  # performer/studio/duplicate-title matching (same value both source plugins used)
TITLE_MATCH_THRESHOLD = 0.50  # manyvids catalog fuzzy search -- see module docstring in the manyvids section
LARGE_RESULT_WARNING = 20
MAX_STORE_PAGES = 60
STORE_CACHE_MAX_AGE_DAYS = 14
STORE_CACHE_MAX_AGE_SECONDS = STORE_CACHE_MAX_AGE_DAYS * 24 * 3600

IWC_SITEMAP_URL = "https://iwantclips.com/sitemap/artist/sitemap_artist.xml"
IWC_SITEMAP_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "iwc_sitemap_cache.json")
IWC_SITEMAP_CACHE_MAX_AGE = 7 * 24 * 3600

SITE_DOMAINS = {
    "iwantclips.com": "iwantclips",
    "manyvids.com": "manyvids",
    "clips4sale.com": "clips4sale",
    "goddesssnow.com": "goddesssnow",
}


def log(msg):
    print(f"time='' level=info msg='[SuperScrape] {msg}'", flush=True)


def detect_site_from_url(url):
    """Site is determined by the domain of a pasted store URL -- no
    separate site-picker UI. Returns None (not a guess) if the domain
    doesn't match a known site, so the caller can surface a clear error."""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return None
    for domain, site in SITE_DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            return site
    return None


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


# ── Plugin config — read-modify-write. See module docstring: this shape
# and SuperScrape.js's readConfig() MUST stay in lockstep. ─────────────────

def read_config(stash_url, api_key):
    data = local_gql(stash_url, api_key, "{ configuration { plugins } }")
    cfg = (data["configuration"]["plugins"] or {}).get(PLUGIN_ID, {})
    return {
        "performerStoreMap": cfg.get("performerStoreMap") or {},
        "storeCatalogCache": cfg.get("storeCatalogCache") or {},
        "proxyUrl": cfg.get("proxyUrl", ""),
    }


def write_config(stash_url, api_key, patch):
    current = read_config(stash_url, api_key)
    merged = {**current, **patch}
    local_gql(stash_url, api_key,
        "mutation Configure($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }",
        {"id": PLUGIN_ID, "input": merged})
    return merged


# ── Result store (RESULT_TAG pattern, same as every prior plugin) ───────────

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


def _make_session(proxy_url=""):
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
        log(f"Using outbound proxy: {proxy_url}")
    return session


# ── Filename -> candidate performer/title parsing ────────────────────────────
# Identical on both source plugins -- ported unchanged.

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
    known_names = {"londonlix", "brattynikki", "latexnchill"}

    r = parse_filename("BrattyNikki - Loser_s Tribute Duty.mp4", known_names)
    assert r == {"performerCandidate": "BrattyNikki", "titleCandidate": "Loser's Tribute Duty", "method": "delimiter"}, r

    r = parse_filename("London_Lix_-_Prove_It_CEI.mp4", known_names)
    assert r == {"performerCandidate": "London Lix", "titleCandidate": "Prove It CEI", "method": "delimiter"}, r

    r = parse_filename("London_Lix_-_Aftercare_-_Mesmerize.mp4", known_names)
    assert r == {"performerCandidate": "London Lix", "titleCandidate": "Aftercare - Mesmerize", "method": "delimiter"}, r

    r = parse_filename("2_Mistress Damazonia - Merciless pegging of a weak bitch.mp4", known_names)
    assert r == {
        "performerCandidate": "Mistress Damazonia",
        "titleCandidate": "Merciless pegging of a weak bitch",
        "method": "delimiter",
    }, r

    r = parse_filename("LATEXnCHILL - Lucky Nylon Feet Lover.mp4", known_names)
    assert r == {"performerCandidate": "LATEXnCHILL", "titleCandidate": "Lucky Nylon Feet Lover", "method": "delimiter"}, r

    print("All parse_filename self-tests passed.")


# ═════════════════════════════════════════════════════════════════════════
# SITE ADAPTER: iwantclips
#
# Interface: discover(candidate_name, config) -> match dict
#            search(store_info, title_candidate, proxy_url) -> {found, hits}
#            extract(clip_url, proxy_url) -> scraped dict (site-specific fields only)
# ═════════════════════════════════════════════════════════════════════════

def iwc_parse_sitemap_xml(xml_text):
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


def iwc_fetch_sitemap_cache(proxy_url="", force=False):
    if not force and os.path.exists(IWC_SITEMAP_CACHE_PATH):
        try:
            with open(IWC_SITEMAP_CACHE_PATH, "r", encoding="utf-8") as f:
                cache = json.load(f)
            age = time.time() - cache.get("fetchedAt", 0)
            if age < IWC_SITEMAP_CACHE_MAX_AGE and cache.get("performers"):
                return cache
        except Exception:
            pass

    log("iwantclips: fetching sitemap_artist.xml (cache stale or missing)")
    session = _make_session(proxy_url)
    resp = session.get(IWC_SITEMAP_URL, timeout=30)
    resp.raise_for_status()
    performers = iwc_parse_sitemap_xml(resp.text)
    if not performers:
        raise RuntimeError("iwantclips sitemap fetch succeeded but no store URLs were parsed -- format may have changed")

    cache = {"fetchedAt": time.time(), "performers": performers}
    with open(IWC_SITEMAP_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    log(f"iwantclips: cached {len(performers)} performer store URLs")
    return cache


def iwc_discover(candidate_name, proxy_url=""):
    """Sitemap-based discovery -- only ever called as a fallback after the
    shared performerStoreMap has already been checked (see discover() at
    the bottom of this file)."""
    norm = normalize(candidate_name)
    cache = iwc_fetch_sitemap_cache(proxy_url=proxy_url)
    sitemap_performers = cache.get("performers", {})

    if norm in sitemap_performers:
        entry = sitemap_performers[norm]
        return {
            "confidence": "confident",
            "source": "iwc_sitemap_exact",
            "match": {"site": "iwantclips", "modelUsername": entry["modelUsername"],
                      "storeUrl": entry["storeUrl"], "displayName": entry["displayName"]},
            "score": 1.0,
            "suggestions": [],
        }

    scored = []
    for slug_norm, entry in sitemap_performers.items():
        score = SequenceMatcher(None, norm, slug_norm).ratio()
        if score > 0.55:
            scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    suggestions = [
        {"site": "iwantclips", "modelUsername": e["modelUsername"], "storeUrl": e["storeUrl"],
         "displayName": e["displayName"], "score": round(s, 3)}
        for s, e in scored[:5]
    ]

    if scored and scored[0][0] >= FUZZY_MATCH_THRESHOLD:
        best_score, best_entry = scored[0]
        return {
            "confidence": "confident",
            "source": "iwc_sitemap_fuzzy",
            "match": {"site": "iwantclips", "modelUsername": best_entry["modelUsername"],
                      "storeUrl": best_entry["storeUrl"], "displayName": best_entry["displayName"]},
            "score": round(best_score, 3),
            "suggestions": suggestions,
        }

    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": suggestions}


_TS_API_KEY_RE = re.compile(r"apiKey:\s*'([^']+)'")
_TS_HOST_RE = re.compile(r"host:\s*'([^']+)'")
_TS_PORT_RE = re.compile(r"port:\s*'([^']+)'")
_TS_PROTOCOL_RE = re.compile(r"protocol:\s*'([^']+)'")
_TS_INDEX_RE = re.compile(r'index:\s*"([^"]+)"')


def _iwc_fetch_typesense_client_config(store_url, proxy_url=""):
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
        raise RuntimeError(
            "Could not extract Typesense search config from the iwantclips "
            f"store page (missing: {', '.join(missing)}). The site's "
            "frontend may have changed -- this integration needs to be re-checked."
        )
    return {name: m.group(1) for name, m in matches.items()}


def _iwc_extract_model_path(store_url):
    """model_username is NOT reliably the same as the sitemap/URL-slug --
    confirmed live that for multi-word display names it can be space-joined
    while the URL slug is hyphenated, causing filter_by=model_username:=
    to silently return zero results. model_path, also present on every
    Typesense hit, was confirmed to exactly match the URL slug, so it's
    built directly from storeUrl (already user-verified) instead."""
    m = re.search(r"/store/(\d+)/([^/?#]+)", store_url)
    if not m:
        raise RuntimeError(f"Could not parse a store/<id>/<slug> path out of storeUrl: {store_url}")
    return f"store/{m.group(1)}/{m.group(2)}"


def iwc_search(store_info, title_candidate, proxy_url="", per_page=20):
    config = _iwc_fetch_typesense_client_config(store_info["storeUrl"], proxy_url=proxy_url)
    model_path = _iwc_extract_model_path(store_info["storeUrl"])
    search_url = (
        f"{config['protocol']}://{config['host']}:{config['port']}"
        f"/collections/{config['collection']}/documents/search"
    )
    params = {
        "q": (title_candidate or "").strip() or "*",
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
            "score": None,  # Typesense already returns hits ranked by relevance, no numeric score surfaced
        })
    return {"found": body.get("found", len(hits)), "totalInStore": None, "largeResultWarning": False, "hits": hits}


def _clean_ld_json(raw):
    if not raw:
        return raw
    raw = re.sub(r"[\x00-\x1F\x7F]", " ", raw)
    raw = re.sub(r"//.*?\n", " ", raw)
    raw = re.sub(r"/\*.*?\*/", " ", raw, flags=re.DOTALL)
    raw = raw.replace("\n", " ").replace("\t", " ")
    return raw.strip()


def _repair_ld_json(raw):
    """Best-effort repair for a confirmed real site-side encoding bug
    (found on iwantclips, shared here since this parser also serves that
    adapter): a literal, unescaped '"' character embedded inside a JSON
    string value (confirmed live: a description containing 'command to
    "cum."' breaks json.loads on an otherwise well-formed JSON-LD block
    -- the strict parser has no way to know that quote isn't meant to end
    the string). Walks the text tracking whether we're inside a string
    value; when a '"' is hit that ISN'T actually closing the string (the
    next non-whitespace character isn't one of : , } ]), it's a literal
    quote the site failed to escape -- escaped here instead of trusted as
    a real string terminator."""
    out = []
    in_string = False
    i, n = 0, len(raw)
    while i < n:
        ch = raw[i]
        if in_string:
            if ch == "\\" and i + 1 < n:
                out.append(ch)
                out.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                j = i + 1
                while j < n and raw[j] in " \t\r\n":
                    j += 1
                if j >= n or raw[j] in ":,}]":
                    in_string = False
                    out.append(ch)
                else:
                    out.append('\\"')
                i += 1
                continue
            out.append(ch)
            i += 1
        else:
            out.append(ch)
            if ch == '"':
                in_string = True
            i += 1
    return "".join(out)


def _find_json_ld_objects(page_html):
    objects = []
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', page_html, re.S):
        raw = _clean_ld_json(m.group(1))
        try:
            objects.append(json.loads(raw))
            continue
        except Exception:
            pass
        # Strict parse failed -- try the repair pass for the known stray-
        # unescaped-quote bug before giving up on this block entirely.
        try:
            objects.append(json.loads(_repair_ld_json(raw)))
            log("Repaired malformed JSON-LD (stray unescaped quote in a string value) on a clip page")
        except Exception:
            pass  # genuinely unparseable, not just the known quote bug -- skip silently as before
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


def _iwc_extract_published_date(page_html):
    """The canonical date source for iwantclips -- confirmed live that the
    JSON-LD VideoObject's "uploadDate" field can be wrong by years for the
    same clip; the page's own "Published Date" label and Typesense's
    publish_date both agreed with each other, disagreeing with JSON-LD."""
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


def iwc_extract(clip_url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(clip_url, timeout=20)
    resp.raise_for_status()

    objects = _find_json_ld_objects(resp.text)
    if not objects:
        raise RuntimeError(f"No JSON-LD found on clip page: {clip_url}")

    data = {"title": None, "date": None, "performers": [], "description": None}

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

    data["date"] = _iwc_extract_published_date(resp.text)

    if not data["title"]:
        raise RuntimeError(f"Could not extract clip metadata (no JSON-LD 'name' field) from: {clip_url}")

    return data


# ═════════════════════════════════════════════════════════════════════════
# SITE ADAPTER: manyvids
#
# No sitemap/directory equivalent exists (confirmed live) -- discover()
# only ever checks the shared performerStoreMap, never returns suggestions.
# No server-side search exists either (q=/search=/keyword=/title=/filter=
# all silently ignored, confirmed live) -- search() is a cached full-
# catalog fetch + local fuzzy title match.
# ═════════════════════════════════════════════════════════════════════════

_NEXT_F_PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,(".*?")\]\)', re.S)
_FLIGHT_LABEL_RE = re.compile(r"^([0-9a-zA-Z_]+):")


def _mv_iter_next_f_payloads(page_html):
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


def _mv_find_all(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            yield obj[key]
        for v in obj.values():
            yield from _mv_find_all(v, key)
    elif isinstance(obj, list):
        for item in obj:
            yield from _mv_find_all(item, key)


def _mv_extract_clips_and_meta(value):
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


def _mv_resolve_canonical_store_url(profile_id, session):
    """A 308 redirect from the id-only URL to the canonical slugged URL
    DROPS any query string -- confirmed live ?page=N silently becomes
    page 1 again if fetched against the id-only URL. Resolved once per
    crawl and reused for ?page=N on every subsequent page; the slug is
    still never stored/trusted as the identifier."""
    resp = session.get(f"https://www.manyvids.com/Profile/{profile_id}/Store/Videos", timeout=20)
    resp.raise_for_status()
    return resp.url, resp.text


def _mv_fetch_store_page(base_store_url, page_num, session, listing="main", first_page_html=None):
    """listing="vertical" is a genuinely separate catalog, not a subset of
    "main" -- confirmed live that vertical-tagged clips don't appear
    anywhere in the main catalog. Both must be fetched and merged."""
    if page_num == 1 and first_page_html is not None:
        page_html = first_page_html
    else:
        resp = session.get(f"{base_store_url}?page={page_num}", timeout=20)
        resp.raise_for_status()
        page_html = resp.text

    for payload in _mv_iter_next_f_payloads(page_html):
        for fb in _mv_find_all(payload, "swrFallback"):
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
                clips, meta = _mv_extract_clips_and_meta(value)
                if clips is not None:
                    return clips, meta or {}
    return [], {}


def _mv_fetch_listing_all_pages(base_store_url, session, listing, first_page_html, max_pages):
    clips_out = []
    page_num = 1
    total_pages = None
    while True:
        clips, meta = _mv_fetch_store_page(base_store_url, page_num, session, listing=listing,
                                            first_page_html=first_page_html if page_num == 1 else None)
        if not clips:
            break
        clips_out.extend(clips)
        if total_pages is None:
            total_pages = meta.get("totalPages")
        log(f"manyvids: fetched {listing} store page {page_num}{f'/{total_pages}' if total_pages else ''} "
            f"({len(clips)} clips, {len(clips_out)} {listing} total so far)")
        page_num += 1
        if total_pages and page_num > total_pages:
            break
        if page_num > max_pages:
            log(f"manyvids: hit max_pages safety cap ({max_pages}) for {listing} listing -- stopping early")
            break
    return clips_out


def _mv_crawl_full_catalog(base_store_url, session, first_page_html, max_pages=MAX_STORE_PAGES):
    all_clips = []
    seen_ids = set()
    for listing in ("main", "vertical"):
        for c in _mv_fetch_listing_all_pages(base_store_url, session, listing, first_page_html, max_pages):
            cid = c.get("id")
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                all_clips.append(c)
    return all_clips


def mv_get_store_clips(profile_id, config, proxy_url="", max_pages=MAX_STORE_PAGES):
    """Cache-aware clip fetch, sliding staleness window. Returns
    (clips, new_cache_entry_or_None) -- caller persists new_cache_entry via
    write_config. A confirmed-fresh cache HIT also returns a refreshed
    entry (cachedAt bumped to now, same clips) so an actively-scraped
    performer's cache never goes stale purely from elapsed time."""
    all_cache = config.get("storeCatalogCache") or {}
    cache = all_cache.get(profile_id)
    log(f"manyvids get_store_clips: looking up cache for store {profile_id!r} "
        f"(cache entry {'found' if cache else 'ABSENT'}; known cache keys: {list(all_cache.keys())})")

    session = _make_session(proxy_url)
    base_store_url, first_page_html = _mv_resolve_canonical_store_url(profile_id, session)
    _, main_meta = _mv_fetch_store_page(base_store_url, 1, session, listing="main", first_page_html=first_page_html)
    _, vertical_meta = _mv_fetch_store_page(base_store_url, 1, session, listing="vertical", first_page_html=first_page_html)
    main_total = main_meta.get("total")
    vertical_total = vertical_meta.get("total")

    now = time.time()
    if cache:
        age = now - cache.get("cachedAt", 0)
        totals_match = cache.get("mainTotal") == main_total and cache.get("verticalTotal") == vertical_total
        log(f"manyvids get_store_clips: store {profile_id} -- cached mainTotal={cache.get('mainTotal')!r}, "
            f"verticalTotal={cache.get('verticalTotal')!r}, cachedAt={cache.get('cachedAt')!r} (age={age/3600:.2f}h) "
            f"vs current mainTotal={main_total!r}, verticalTotal={vertical_total!r} -- totals_match={totals_match}, "
            f"within_max_age={age < STORE_CACHE_MAX_AGE_SECONDS} (max age {STORE_CACHE_MAX_AGE_DAYS}d)")
        if totals_match and age < STORE_CACHE_MAX_AGE_SECONDS:
            log(f"manyvids get_store_clips: DECISION = cache hit, using {len(cache['clips'])} cached clips "
                f"for store {profile_id}, skipping full crawl -- sliding cachedAt forward to now")
            refreshed_entry = {**cache, "cachedAt": now}
            return cache["clips"], refreshed_entry
        reason = "totals mismatched" if not totals_match else f"cache older than {STORE_CACHE_MAX_AGE_DAYS} days"
        log(f"manyvids get_store_clips: DECISION = cache miss/stale ({reason}) for store {profile_id}, doing full re-crawl")
    else:
        log(f"manyvids get_store_clips: DECISION = no cache entry for store {profile_id}, doing full crawl")

    clips = _mv_crawl_full_catalog(base_store_url, session, first_page_html, max_pages)
    new_entry = {"clips": clips, "mainTotal": main_total, "verticalTotal": vertical_total, "cachedAt": now}
    return clips, new_entry


def mv_store_url_for(profile_id):
    return f"https://www.manyvids.com/Profile/{profile_id}/Store/Videos"


def mv_clip_page_url(clip):
    return f"https://www.manyvids.com/Video/{clip.get('id')}/{clip.get('slug')}"


def mv_search(store_info, title_candidate, config, stash_url, api_key, proxy_url=""):
    """Returns (result_dict, new_cache_entry_or_None) -- caller (the
    unified dispatch in main()) is responsible for persisting the cache
    update, same discipline as ManyVidsStashDB's match_clips_in_store."""
    profile_id = store_info["profileId"]
    clips, new_cache_entry = mv_get_store_clips(profile_id, config, proxy_url=proxy_url)

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
            "contentUrl": mv_clip_page_url(c),
            "price": price,
            "category": None,
            "publishDate": c.get("launchDate"),
            "description": c.get("description", ""),
            "thumbnail": thumbnail,
            "score": round(score, 3),
        })

    result = {
        "found": len(hits),
        "totalInStore": len(clips),
        "largeResultWarning": len(hits) > LARGE_RESULT_WARNING,
        "hits": hits,
    }
    return result, new_cache_entry


def mv_extract(clip_url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(clip_url, timeout=20)
    resp.raise_for_status()

    objects = _find_json_ld_objects(resp.text)
    video_obj = next((o for o in objects if o.get("@type") == "VideoObject"), None)
    if not video_obj:
        raise RuntimeError(f"No VideoObject JSON-LD found on clip page: {clip_url}")

    title = html_lib.unescape(video_obj.get("name") or "").strip()
    if not title:
        raise RuntimeError(f"Could not extract clip metadata (no VideoObject 'name' field) from: {clip_url}")

    description = html_lib.unescape((video_obj.get("description") or "").strip())

    upload_date = video_obj.get("uploadDate") or ""
    date = upload_date[:10] if len(upload_date) >= 10 else None

    creator = video_obj.get("creator")
    creator_name = creator.get("name") if isinstance(creator, dict) else None
    performers = [html_lib.unescape(creator_name)] if creator_name else []

    return {"title": title, "date": date, "performers": performers, "description": description}


# ═════════════════════════════════════════════════════════════════════════
# SITE ADAPTER: clips4sale
#
# Confirmed live: fully scrapable via plain requests, no JS/CDP needed. No
# JSON-LD anywhere on the site -- everything comes from a single
# `window.__remixContext = {...};` JSON blob embedded in the raw HTML
# (Remix framework -- different from ManyVids' Next.js RSC streaming
# format; this is simpler, one regex + one json.loads, no partial-payload
# reconstruction). Numeric studio ID is load-bearing (confirmed: wrong id
# redirects away entirely; correct id + garbage/missing slug 200s and
# silently redirects to canonical) -- same discipline as iwantclips/
# manyvids, store the numeric ID only.
#
# ARCHITECTURAL GOTCHA (confirmed live, must be respected everywhere in
# this section): performer != studio here. A performer's content can be
# split across MULTIPLE studios (confirmed: sitewide search for "Mina
# Thorne" surfaces clips from studio 37562 AND a different studio,
# producer 8341). A performer-name search hit must NEVER be treated as a
# confirmed store match -- only sitemap-based studio-identity matching
# (c4s_discover's sitemap path) can return "confidence": "confident".
# Search-derived candidates are folded into "suggestions" instead, which
# the existing UI already renders as click-to-prefill, never auto-
# confirming chips -- no new confidence state needed for this.
# ═════════════════════════════════════════════════════════════════════════

_REMIX_CONTEXT_RE = re.compile(r"window\.__remixContext\s*=\s*(\{.*?\});", re.S)

C4S_SITEMAP_INDEX_URL = "https://www.clips4sale.com/sitemap.xml"
C4S_SITEMAP_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "c4s_sitemap_cache.json")
C4S_SITEMAP_CACHE_MAX_AGE = 7 * 24 * 3600


def c4s_extract_remix_context(page_html):
    """The one parsing primitive every other c4s_* function in this
    section builds on. Confirmed live against both the studio page and a
    clip page -- same blob shape, different loaderData route key."""
    m = _REMIX_CONTEXT_RE.search(page_html)
    if not m:
        raise RuntimeError("Could not find window.__remixContext on the page -- clips4sale's frontend may have changed")
    try:
        return json.loads(m.group(1))
    except Exception as e:
        raise RuntimeError(f"Found window.__remixContext but could not parse it as JSON: {e}")


def _c4s_loader_data_for(remix_context, route_suffix):
    """loaderData keys are full Remix route ids (e.g.
    "routes/($lang).studio.$id_.$studioSlug.$") -- matched by suffix
    since the exact prefix isn't worth hardcoding brittlely."""
    loader_data = remix_context.get("state", {}).get("loaderData", {})
    for key, value in loader_data.items():
        if key.endswith(route_suffix):
            return value
    raise RuntimeError(f"Could not find loaderData route ending in {route_suffix!r} -- page shape may have changed")


def c4s_store_url_for(studio_id, slug=""):
    return f"https://www.clips4sale.com/studio/{studio_id}/{slug}"


# ── Sitemap-based discovery (the TRUSTED path -- see module note above) ────

def c4s_parse_studio_sitemap_xml(xml_text):
    """Each studio appears multiple times (once per hreflang alternate --
    confirmed live: /studio/X/slug, /de/studio/X/slug, /fr/studio/X/slug,
    etc, all for the same studio) -- de-duplicated by numeric id, keeping
    the first (canonical, non-language-prefixed) slug seen."""
    studios = {}
    for m in re.finditer(r"<loc>\s*(https?://[^<]*?/studio/(\d+)/([^<\s/]+))\s*</loc>", xml_text):
        full_url, studio_id, slug = m.group(1), m.group(2), m.group(3)
        if studio_id in studios:
            continue
        display_name = slug.rstrip("-").replace("-", " ")
        studios[studio_id] = {
            "studioId": studio_id,
            "slug": slug,
            "storeUrl": c4s_store_url_for(studio_id, slug),
            "displayName": display_name,
        }
    return studios


def c4s_fetch_sitemap_cache(proxy_url="", force=False):
    if not force and os.path.exists(C4S_SITEMAP_CACHE_PATH):
        try:
            with open(C4S_SITEMAP_CACHE_PATH, "r", encoding="utf-8") as f:
                cache = json.load(f)
            age = time.time() - cache.get("fetchedAt", 0)
            if age < C4S_SITEMAP_CACHE_MAX_AGE and cache.get("studios"):
                return cache
        except Exception:
            pass

    log("clips4sale: fetching studio sitemap shards (cache stale or missing)")
    session = _make_session(proxy_url)
    index_resp = session.get(C4S_SITEMAP_INDEX_URL, timeout=30)
    index_resp.raise_for_status()
    shard_urls = sorted(set(re.findall(r"<loc>\s*(https?://[^<]*?sitemap_studios\d+\.xml)\s*</loc>", index_resp.text)))
    if not shard_urls:
        raise RuntimeError("clips4sale sitemap index fetch succeeded but no sitemap_studios*.xml shards were found -- format may have changed")

    studios = {}
    for shard_url in shard_urls:
        log(f"clips4sale: fetching sitemap shard {shard_url}")
        resp = session.get(shard_url, timeout=60)
        resp.raise_for_status()
        shard_studios = c4s_parse_studio_sitemap_xml(resp.text)
        for sid, entry in shard_studios.items():
            studios.setdefault(sid, entry)

    if not studios:
        raise RuntimeError("clips4sale sitemap shards fetched but no studio URLs were parsed -- format may have changed")

    # Indexed by normalized display name for fuzzy matching, same shape as
    # iwc_fetch_sitemap_cache's "performers" dict.
    by_name = {}
    for entry in studios.values():
        by_name[normalize(entry["displayName"])] = entry

    cache = {"fetchedAt": time.time(), "studios": by_name}
    with open(C4S_SITEMAP_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    log(f"clips4sale: cached {len(by_name)} unique studios across {len(shard_urls)} shard(s)")
    return cache


def c4s_discover(candidate_name, proxy_url=""):
    """Sitemap-based discovery only -- the trusted path. Ported from
    iwc_discover's fuzzy-match structure; never consults performer-name
    search here (that's a separate, suggestions-only path wired in at the
    unified discover() level once search is built in stage 3)."""
    norm = normalize(candidate_name)
    cache = c4s_fetch_sitemap_cache(proxy_url=proxy_url)
    sitemap_studios = cache.get("studios", {})

    if norm in sitemap_studios:
        entry = sitemap_studios[norm]
        return {
            "confidence": "confident",
            "source": "c4s_sitemap_exact",
            "match": {"site": "clips4sale", "studioId": entry["studioId"],
                      "storeUrl": entry["storeUrl"], "displayName": entry["displayName"]},
            "score": 1.0,
            "suggestions": [],
        }

    scored = []
    for slug_norm, entry in sitemap_studios.items():
        score = SequenceMatcher(None, norm, slug_norm).ratio()
        if score > 0.55:
            scored.append((score, entry))
    scored.sort(key=lambda x: x[0], reverse=True)
    suggestions = [
        {"site": "clips4sale", "studioId": e["studioId"], "storeUrl": e["storeUrl"],
         "displayName": e["displayName"], "score": round(s, 3)}
        for s, e in scored[:5]
    ]

    if scored and scored[0][0] >= FUZZY_MATCH_THRESHOLD:
        best_score, best_entry = scored[0]
        return {
            "confidence": "confident",
            "source": "c4s_sitemap_fuzzy",
            "match": {"site": "clips4sale", "studioId": best_entry["studioId"],
                      "storeUrl": best_entry["storeUrl"], "displayName": best_entry["displayName"]},
            "score": round(best_score, 3),
            "suggestions": suggestions,
        }

    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": suggestions}


# ── In-store search -- the PRIMARY "find this clip" mechanism for this
# adapter once a store is confirmed (replaces ManyVids-style full-catalog
# crawl + local fuzzy match: this site has a real, correctly-filtered,
# plain-HTTP search, so there's no need to crawl+cache an entire catalog
# just to find one clip). Confirmed live it works via the site's own
# path-segment URL scheme. ───────────────────────────────────────────────

def _c4s_slug_from_store_url(store_url):
    m = re.search(r"/studio/\d+/([^/?#]+)", store_url)
    return m.group(1) if m else ""


def c4s_search(store_info, title_candidate, proxy_url="", limit=24):
    """IMPORTANT CORRECTION vs. the original investigation: this is NOT a
    reliable literal full-text title search. Confirmed live with a more
    thorough test than the investigation's single spot-check ("get
    pegged", which happened to also be a literal category/keyword tag on
    that clip): a real multi-word title fragment pulled straight from an
    actual clip's own title ("Jerking With Consequences") returned that
    clip nowhere in the results -- top hits were completely unrelated
    titles, with no error. The endpoint appears to match against
    category/keyword tags rather than clip titles, and silently falls
    back to something like the default browse order when no keyword
    matches, rather than returning zero results. Trusting the site's
    ranking directly (as originally built) would have silently
    surfaced wrong clips as top suggestions.

    Fixed by treating the site's response as a candidate pool ONLY, then
    applying the same local fuzzy title-matching discipline already
    proven in the manyvids adapter (TITLE_MATCH_THRESHOLD) to verify each
    candidate's title actually resembles the query before trusting it --
    still far cheaper than manyvids' full-catalog crawl (still just this
    one page-1 request, not up to sixty), just no longer blindly trusting
    the site's own relevance ordering."""
    studio_id = store_info["studioId"]
    slug = _c4s_slug_from_store_url(store_info.get("storeUrl") or "") or store_info.get("slug", "")

    query = (title_candidate or "").strip()
    base = f"https://www.clips4sale.com/studio/{studio_id}/{slug}/Cat0-AllCategories/Page1/C4SSort-recommended/Limit{limit}"
    url = f"{base}/search/{quote(query)}" if query else base

    session = _make_session(proxy_url)
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    ctx = c4s_extract_remix_context(resp.text)
    studio_data = _c4s_loader_data_for(ctx, ".studio.$id_.$studioSlug.$")
    clips = studio_data.get("clips") or []

    norm_query = normalize(query)
    hits = []
    for c in clips:
        title = html_lib.unescape(c.get("title") or "")
        score = SequenceMatcher(None, norm_query, normalize(title)).ratio() if query else None
        if query and score < TITLE_MATCH_THRESHOLD:
            continue
        hits.append({
            "title": title,
            "contentUrl": f"https://www.clips4sale.com{c.get('bannerLink') or c.get('link') or ''}",
            "price": c.get("price"),
            "category": None,
            "publishDate": None,
            "description": "",
            "thumbnail": c.get("previewLink") or "",
            "score": round(score, 3) if score is not None else None,
        })
    if query:
        hits.sort(key=lambda h: h["score"] or 0, reverse=True)

    # clipsCount is UNRELIABLE when a search query is active -- confirmed
    # live it always reports the studio's unfiltered total, never the
    # filtered count. Only trust it (as an informational total) on the
    # unfiltered/no-query request; omit it entirely when searching rather
    # than surface a misleading number.
    total_in_store = None if query else studio_data.get("clipsCount")

    return {
        "found": len(hits),
        "totalInStore": total_in_store,
        "largeResultWarning": len(hits) > LARGE_RESULT_WARNING,
        "hits": hits,
    }


# ── Sitewide search -- SUGGESTIONS ONLY during discovery (see module note
# at the top of this section: performer != studio here, so a search hit
# must never auto-confirm a store). Used to supplement c4s_discover's
# sitemap-fuzzy suggestions with additional candidates when a performer's
# name doesn't cleanly match a studio slug. ────────────────────────────────

def c4s_sitewide_search_suggestions(candidate_name, proxy_url="", max_suggestions=5):
    query = (candidate_name or "").strip()
    if not query:
        return []
    url = f"https://www.clips4sale.com/clips/search/{quote(query)}/category/0/clipsPage/1"
    session = _make_session(proxy_url)
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    ctx = c4s_extract_remix_context(resp.text)
    search_data = _c4s_loader_data_for(ctx, ".clips.search.$")
    clips = search_data.get("clips") or []

    seen_studio_ids = set()
    suggestions = []
    for c in clips:
        studio = c.get("studio") or {}
        studio_id = studio.get("id") or c.get("producer")
        if not studio_id or studio_id in seen_studio_ids:
            continue
        seen_studio_ids.add(studio_id)
        # Confirmed live: each search-result clip carries a full studio
        # dict (id/name/slug), not just the bare "producer" id -- name
        # comes back wrapped in <em> highlight tags around the matched
        # query terms, stripped here since this is a display label, not
        # something matched against again.
        raw_name = studio.get("name") or f"Studio {studio_id}"
        display_name = re.sub(r"</?em>", "", raw_name)
        slug = studio.get("slug", "")
        suggestions.append({
            "site": "clips4sale",
            "studioId": str(studio_id),
            "storeUrl": c4s_store_url_for(studio_id, slug),
            "displayName": display_name,
            "score": None,
        })
        if len(suggestions) >= max_suggestions:
            break
    return suggestions


# ── Clip extraction ────────────────────────────────────────────────────────

_C4S_DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}/\d{2}\s+\d{1,2}:\d{2}\s*[AaPp][Mm]$")


def c4s_parse_date(date_display):
    """Format confirmed live: "M/D/YY H:MM AM/PM" (US, 2-digit year, e.g.
    "4/15/14 1:56 AM") -- does not match either existing adapter's date
    format, needs its own parser. Confirmed against both a same-day clip
    and a real 2014 clip that this is a genuine per-clip publish date,
    not a render-time artifact."""
    if not date_display or not _C4S_DATE_RE.match(date_display.strip()):
        return None
    try:
        return datetime.datetime.strptime(date_display.strip(), "%m/%d/%y %I:%M %p").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _c4s_strip_html(html_text):
    if not html_text:
        return ""
    return html_lib.unescape(BeautifulSoup(html_text, "html.parser").get_text(separator="\n").strip())


def _c4s_best_thumbnail(clip):
    if clip.get("cdn_previewlg_link"):
        return clip["cdn_previewlg_link"]
    src_set = clip.get("srcSet") or ""
    # "url1 304w, url2 350w, url3 534w" -- take the entry with the largest
    # width descriptor, same "biggest available" intent as the fallback
    # already used for ManyVids' responsive image handling, just a
    # different source format (srcset syntax vs a single explicit field).
    candidates = []
    for part in src_set.split(","):
        part = part.strip()
        m = re.match(r"(\S+)\s+(\d+)w", part)
        if m:
            candidates.append((int(m.group(2)), m.group(1)))
    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]
    return clip.get("previewLink") or ""


def c4s_extract(clip_url, proxy_url=""):
    session = _make_session(proxy_url)
    resp = session.get(clip_url, timeout=20)
    resp.raise_for_status()

    ctx = c4s_extract_remix_context(resp.text)
    clip_data = _c4s_loader_data_for(ctx, ".$id_.$clipId.$clipSlug")
    clip = clip_data.get("clip") or {}

    title = html_lib.unescape(clip.get("title") or "").strip()
    if not title:
        raise RuntimeError(f"Could not extract clip metadata (no clip title) from: {clip_url}")

    description = _c4s_strip_html(clip.get("description_sanitized") or clip.get("description") or "")
    date = c4s_parse_date(clip.get("dateDisplay") or clip.get("date_display"))

    # performers CAN BE NULL (confirmed live on a recently-posted clip) --
    # falls back to the studio name, same fallback pattern already used
    # in the manyvids adapter for its single-owner-studio case.
    raw_performers = clip.get("performers")
    if raw_performers:
        performers = [html_lib.unescape(p.get("stage_name") or p.get("stageName") or "") for p in raw_performers if p]
        performers = [p for p in performers if p]
    else:
        performers = []
    if not performers:
        studio_name = ((clip.get("studio") or {}).get("name")) or clip.get("studioTitle") or ""
        studio_name = re.sub(r"</?em>", "", html_lib.unescape(studio_name)).strip()
        if studio_name:
            performers = [studio_name]

    return {
        "title": title,
        "date": date,
        "performers": performers,
        "description": description,
        "thumbnail": _c4s_best_thumbnail(clip),
    }


# ── Full-catalog crawl -- FALLBACK ONLY. In-store search (c4s_search) is
# the primary "find this clip" mechanism for this adapter; this is only
# needed if sitemap discovery fails to confirm a store AND no search
# suggestion gets confirmed either, yet the user still wants to browse a
# pasted store's entire catalog. Path-segment pagination, confirmed live
# that Page2 returns genuinely different real clips from Page1 -- no
# redirect-drops-the-query-string trap here (unlike manyvids) since the
# page number is a path segment, not a query string, so it survives the
# same slug-canonicalization redirect that fixes up a wrong/missing slug. ──

def c4s_fetch_page(studio_id, slug, page_num, proxy_url="", limit=24):
    url = f"https://www.clips4sale.com/studio/{studio_id}/{slug}/Cat0-AllCategories/Page{page_num}/C4SSort-added_at/Limit{limit}"
    session = _make_session(proxy_url)
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    ctx = c4s_extract_remix_context(resp.text)
    studio_data = _c4s_loader_data_for(ctx, ".studio.$id_.$studioSlug.$")
    return studio_data.get("clips") or [], studio_data.get("clipsCount")


def c4s_crawl_full_catalog(studio_id, slug, proxy_url="", max_pages=MAX_STORE_PAGES, limit=24):
    all_clips = []
    seen_ids = set()
    page_num = 1
    total = None
    while True:
        clips, total_count = c4s_fetch_page(studio_id, slug, page_num, proxy_url=proxy_url, limit=limit)
        if not clips:
            break
        for c in clips:
            cid = c.get("clipId")
            if cid and cid not in seen_ids:
                seen_ids.add(cid)
                all_clips.append(c)
        if total is None:
            total = total_count
        log(f"clips4sale: fetched store page {page_num} ({len(clips)} clips, {len(all_clips)} total so far"
            f"{f'/{total}' if total else ''})")
        page_num += 1
        if total and len(all_clips) >= total:
            break
        if page_num > max_pages:
            log(f"clips4sale: hit max_pages safety cap ({max_pages}) -- stopping early")
            break
    return all_clips


# ═════════════════════════════════════════════════════════════════════════
# SITE ADAPTER: goddesssnow
#
# Confirmed live: goddesssnow.com/vod/ is a genuinely single-performer
# personal storefront, not a marketplace -- a custom/legacy PHP template
# (no WordPress/WooCommerce/Squarespace, no generator meta tag), fully
# scrapable via plain requests. No JSON-LD anywhere on the site (0 blocks
# checked) -- a fourth distinct data shape from all three prior adapters:
# plain server-rendered HTML plus small inline JSON blobs for price tiers
# (`id="packageinfo_<id>" data-title="..." data-redirect="...">
# {"rent":[...],"buy":[...]}`), correlated POSITIONALLY with the
# surrounding title/date/duration/thumbnail markup for the same catalog
# row -- there's no id repeated near that markup to correlate by key, so
# _gs_parse_listing_items windows the HTML from one packageinfo block to
# the next rather than matching text across the page.
#
# No sitemap, no studio-identity ambiguity, no marketplace collision:
# confirmed live no other performer has their own store/section anywhere
# on the site, so unlike iwantclips/clips4sale this adapter never needs a
# fetched directory to check candidate names against. It DOES still fuzzy-
# match against a curated list of her own name variants (see
# GS_KNOWN_NAME_VARIANTS) rather than being truly unconditional, so an
# unrelated performer's filename doesn't silently get routed here.
# HOWEVER: some individual clips are collabs with guest performers
# (confirmed live: "Featuring Goddess Nyx and Natalie Carnot!" as the
# first line of a real clip's own description) -- gs_extract must not
# hardcode performers to just her, see _gs_guest_performers below.
#
# Search (search.php?query=...) returns real, topically relevant,
# paginated results -- but its own ranking is NOT trustworthy (confirmed
# live: the exact real title "Seductrix's New Powers" ranked #6 of its
# own page-1 results, several less-relevant same-franchise titles
# outranked it). Same fix as clips4sale needed: page 1 is a candidate
# pool only, re-scored locally with the same SequenceMatcher/
# TITLE_MATCH_THRESHOLD discipline already proven in c4s_search.
#
# URL identifier: DIFFERENT from all three prior adapters -- the SLUG
# itself is load-bearing (https://goddesssnow.com/vod/scenes/<Slug>_vids.html,
# the _vids suffix is optional, confirmed live) and a garbage slug 404s
# outright; there is no redirect-to-canonical-from-numeric-id behavior to
# resolve here (unlike iwantclips/manyvids/clips4sale), so this adapter
# never needs a "resolve canonical URL" step -- the slug from a search/
# listing hit is used as-is.
#
# date/duration are NOT reliably present on the clip page itself (the
# only date/duration spans found there, confirmed live, belong to an
# unrelated "related content" carousel, not the clip in question) -- they
# come from whichever search/listing row produced this clip's URL,
# threaded through via extract()'s optional `hint` dict. This is the
# first adapter where extract() isn't fully self-sufficient from the URL
# alone -- see gs_extract's docstring and the dispatch wrapper below.
# ═════════════════════════════════════════════════════════════════════════

GS_STORE_URL = "https://goddesssnow.com/vod/"
GS_SEARCH_URL = "https://goddesssnow.com/vod/search.php"
GS_UPDATES_PAGE_URL = "https://goddesssnow.com/vod/updates/page_{page}.html"
GS_DISPLAY_NAME = "Goddess Alexandra Snow"
GS_MAX_PAGES = 150  # confirmed live catalog is ~115 pages -- MAX_STORE_PAGES (60) would truncate a real full crawl

# Curated, not fetched -- there is no sitemap/directory to check against
# (confirmed live: single-performer site, see module note above).
GS_KNOWN_NAME_VARIANTS = ["Alexandra Snow", "Goddess Alexandra Snow", "Goddess Snow", "Domina Snow"]


def gs_discover(candidate_name):
    """Near-unconditional discover -- no sitemap, no studio-identity
    ambiguity, no multi-site collision handling needed beyond what
    discover() already does generically (see module docstring): this
    adapter only ever resolves to this one fixed site. Still fuzzy-
    matched against known name variants rather than truly unconditional,
    so an unrelated performer's filename doesn't silently get routed
    here."""
    norm = normalize(candidate_name)
    known_norms = {normalize(n) for n in GS_KNOWN_NAME_VARIANTS}
    score = 1.0 if norm in known_norms else max(
        (SequenceMatcher(None, norm, kn).ratio() for kn in known_norms), default=0.0
    )

    if score >= FUZZY_MATCH_THRESHOLD:
        return {
            "confidence": "confident",
            "source": "gs_fixed",
            "match": {"site": "goddesssnow", "storeUrl": GS_STORE_URL, "displayName": GS_DISPLAY_NAME},
            "score": round(score, 3),
            "suggestions": [],
        }
    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": []}


_GS_PACKAGEINFO_RE = re.compile(
    r'id="packageinfo_(\d+)"[^>]*data-title="([^"]*)"[^>]*data-redirect="([^"]*)"[^>]*>(\{.*?\})</div>', re.S
)
_GS_TITLE_ROW_RE = re.compile(
    r'update-title" href="[^"]+"><h4>[^<]*</h4>.*?class="date">([^<]+)<.*?class="duration">\s*([^<]*)<', re.S
)
_GS_THUMB_RE = re.compile(r'src0_4x="([^"]+)"')
_GS_DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def gs_parse_date(date_display):
    """Format confirmed live: "MM/DD/YYYY" (e.g. "07/03/2026")."""
    m = _GS_DATE_RE.match((date_display or "").strip())
    if not m:
        return None
    month, day, year = m.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def _gs_price_from_json(price_json_text):
    try:
        data = json.loads(price_json_text)
    except Exception:
        return None
    for key in ("buy", "rent"):
        tiers = data.get(key) or []
        if tiers:
            return tiers[0].get("FullPrice")
    return None


def _gs_parse_listing_items(page_html):
    """The one parsing primitive every goddesssnow listing/search page
    shares (confirmed live identical shape on both search.php results and
    /vod/updates/page_N.html catalog pages). Windowed POSITIONALLY per
    item -- from one packageinfo_<id> block to the next -- rather than
    correlated by matching title text across the page, since the item's
    own numeric id isn't repeated anywhere near the title/date/duration
    markup to key off of directly. Returns a full "hit" shape (title/
    contentUrl/price/thumbnail/publishDate/duration) straight from the
    listing/search page -- no per-item extra request needed just to
    browse or search; only the eventual extract() call needs the clip
    page itself, for the description."""
    matches = list(_GS_PACKAGEINFO_RE.finditer(page_html))
    items = []
    for i, m in enumerate(matches):
        window_start = m.start()
        window_end = matches[i + 1].start() if i + 1 < len(matches) else len(page_html)
        window = page_html[window_start:window_end]

        title = html_lib.unescape(m.group(2))
        content_url = m.group(3)
        price = _gs_price_from_json(m.group(4))

        thumb_m = _GS_THUMB_RE.search(window)
        thumbnail = thumb_m.group(1) if thumb_m else ""
        if thumbnail.startswith("/"):
            thumbnail = "https://goddesssnow.com" + thumbnail

        row_m = _GS_TITLE_ROW_RE.search(window)
        date_display = row_m.group(1) if row_m else None
        duration = row_m.group(2).replace("&nbsp;", " ").strip() if row_m else None

        items.append({
            "title": title,
            "contentUrl": content_url,
            "price": price,
            "category": None,
            "publishDate": gs_parse_date(date_display),
            "description": "",
            "thumbnail": thumbnail,
            "duration": duration,
            "score": None,
        })
    return items


def gs_search(store_info, title_candidate, proxy_url=""):
    """IMPORTANT CORRECTION, same class of fix as clips4sale needed:
    confirmed live search.php's own result ordering is not trustworthy
    (exact real title "Seductrix's New Powers" ranked #6 of its own
    page-1 results, several less-relevant same-franchise titles
    outranked it). Page 1 (24 results) is treated as a candidate pool
    only, then re-scored locally with the same SequenceMatcher/
    TITLE_MATCH_THRESHOLD discipline already proven in c4s_search --
    reused pattern, not rebuilt. An empty query browses the landing page
    (/vod/, newest first) instead of hitting search.php, same "no query ->
    browse" fallback c4s_search uses."""
    query = (title_candidate or "").strip()
    session = _make_session(proxy_url)
    if query:
        resp = session.get(GS_SEARCH_URL, params={"query": query}, timeout=20)
    else:
        resp = session.get(GS_STORE_URL, timeout=20)
    resp.raise_for_status()

    items = _gs_parse_listing_items(resp.text)

    norm_query = normalize(query)
    hits = []
    for item in items:
        score = SequenceMatcher(None, norm_query, normalize(item["title"])).ratio() if query else None
        if query and score < TITLE_MATCH_THRESHOLD:
            continue
        hits.append({**item, "score": round(score, 3) if score is not None else None})
    if query:
        hits.sort(key=lambda h: h["score"] or 0, reverse=True)

    return {
        "found": len(hits),
        "totalInStore": None,
        "largeResultWarning": len(hits) > LARGE_RESULT_WARNING,
        "hits": hits,
    }


_GS_MODELS_RE = re.compile(r'class="update_models">(.*?)</span>', re.S)
_GS_FEATURING_RE = re.compile(r"^Featuring\s+(.+?)[!.\n]", re.I)


def _gs_structured_performers(page_html):
    """The site DOES have a real structured performer list after all
    (found during build, correcting the original investigation, which
    only checked JSON-LD/description text and missed this) -- a single
    `class="update_models">Featuring: <a>Name</a> , <a>Name2</a></span>`
    block, confirmed live to appear exactly once per clip page (not
    subject to the carousel-ordering ambiguity that broke the first price-
    parsing attempt, see gs_extract's price-sourcing note) and to
    correctly list every tagged performer, solo or collab."""
    m = _GS_MODELS_RE.search(page_html)
    if not m:
        return []
    names = re.findall(r"<a[^>]*>([^<]*)</a>", m.group(1))
    return [html_lib.unescape(n).strip() for n in names if n.strip()]


def _gs_guest_performers(description):
    """Confirmed live the structured update_models list can still be
    INCOMPLETE -- a real collab clip's description opened "Featuring
    Goddess Nyx and Natalie Carnot!" but its own update_models block only
    listed Alexandra Snow and Goddess Nyx, silently omitting Natalie
    Carnot (not tagged in the site's own model database, evidently).  So
    this text-parsed signal is kept as a supplement to
    _gs_structured_performers, not replaced by it -- it's necessarily
    best-effort (free-form prose, not a structured field): no match
    simply means no additional guests detected, not an error."""
    m = _GS_FEATURING_RE.match((description or "").strip())
    if not m:
        return []
    parts = re.split(r",\s*| and ", m.group(1))
    return [p.strip() for p in parts if p.strip()]


def gs_extract(clip_url, proxy_url="", hint=None):
    """The first adapter where extract() isn't self-sufficient from the
    URL alone (see module note above): date and duration are only
    reliably available from the search/listing row that found this clip,
    not the clip page itself, so they're threaded through via the
    optional `hint` dict -- whatever search/listing hit produced
    clip_url. Degrades gracefully if hint is absent/incomplete: date/
    duration simply come back missing rather than raising, same as any
    other optional field elsewhere in this shared shape."""
    hint = hint or {}
    session = _make_session(proxy_url)
    resp = session.get(clip_url, timeout=20)
    resp.raise_for_status()
    page_html = resp.text

    title_block_m = re.search(r'class="title_bar">(.*?)</div>', page_html, re.S)
    title_span_m = re.search(r"<span>([^<]*)</span>", title_block_m.group(1)) if title_block_m else None
    title = html_lib.unescape(title_span_m.group(1)).strip() if title_span_m else ""
    if not title:
        raise RuntimeError(f"Could not extract clip metadata (no title_bar span found) from: {clip_url}")

    desc_m = re.search(r'class="update_description">\s*(.*?)\s*</span>', page_html, re.S)
    description = html_lib.unescape(desc_m.group(1)).strip() if desc_m else ""

    performers = _gs_structured_performers(page_html) or [GS_DISPLAY_NAME]
    seen_norms = {normalize(p) for p in performers}
    for guest in _gs_guest_performers(description):
        if normalize(guest) not in seen_norms:
            performers.append(guest)
            seen_norms.add(normalize(guest))

    # PRICE SOURCING NOTE (confirmed live, corrected from the original
    # investigation): the clip page can carry a "recommended/related
    # items" carousel whose own price blocks are NOT reliably positioned
    # after the clip's own -- confirmed live fetching the exact same URL
    # twice, the clip's own price block appeared first one time and not
    # at all in the visible packageinfo blocks the next (template
    # variance between clip types, see date/duration note below). Taking
    # "the first data-redirect block on the page" silently returned a
    # DIFFERENT item's price (17.99 for a carousel neighbor instead of
    # 12.99 for the actual clip) -- exactly the kind of bug this
    # adapter's build discipline is meant to catch. The search/listing
    # hint's price (parsed the same way, but scoped to one unambiguous
    # catalog row) is reliable and used as the primary source instead,
    # matching date/duration; a title-anchored (not positional) match on
    # the clip page itself is kept as a best-effort fallback only when no
    # hint is available.
    price = hint.get("price")
    if price is None:
        price_m = re.search(
            r'data-title="' + re.escape(title) + r'" data-redirect="[^"]*">(\{.*?\})</div>', page_html, re.S
        )
        price = _gs_price_from_json(price_m.group(1)) if price_m else None

    thumb_m = re.search(r'<meta property="og:image" content="([^"]*)"', page_html)
    thumbnail = html_lib.unescape(thumb_m.group(1)) if thumb_m else ""

    # DATE/DURATION SOURCING NOTE (confirmed live, reinforces the original
    # investigation rather than overturning it): the clip page's own
    # date/duration markup is template-dependent, not uniform -- some
    # clip pages expose a plain update_date div with no duration
    # counterpart nearby, others expose a nested release-date/duration
    # pair inside a differently-named wrapper. The search/listing row's
    # date+duration markup is confirmed uniform across every catalog row
    # checked, so it remains the sole source here rather than adding
    # fragile per-template clip-page parsing on top.
    return {
        "title": title,
        "date": hint.get("publishDate"),
        "performers": performers,
        "description": description,
        "thumbnail": thumbnail,
        "price": price,
        "duration": hint.get("duration"),
    }


# ── Full-catalog crawl -- FALLBACK ONLY, same role/discipline as every
# prior adapter's crawl (c4s_crawl_full_catalog, _mv_crawl_full_catalog):
# in-store search (gs_search) is the primary "find this clip" mechanism;
# this exists for browsing/verification, not wired into the task
# dispatcher any more than c4s's crawl currently is. Path-segment
# pagination (/vod/updates/page_N.html), confirmed live page 2 returns
# genuinely different real items from page 1 -- no query-string-drop
# redirect trap here either (same as clips4sale, unlike manyvids). ────────

def gs_crawl_full_catalog(proxy_url="", max_pages=GS_MAX_PAGES):
    session = _make_session(proxy_url)
    all_items = []
    seen_urls = set()
    page_num = 1
    while True:
        url = GS_STORE_URL if page_num == 1 else GS_UPDATES_PAGE_URL.format(page=page_num)
        resp = session.get(url, timeout=20)
        if resp.status_code == 404:
            break
        resp.raise_for_status()
        items = _gs_parse_listing_items(resp.text)
        if not items:
            break
        new_count = 0
        for item in items:
            if item["contentUrl"] not in seen_urls:
                seen_urls.add(item["contentUrl"])
                all_items.append(item)
                new_count += 1
        log(f"goddesssnow: fetched catalog page {page_num} ({len(items)} items, {new_count} new, "
            f"{len(all_items)} total so far)")
        if new_count == 0:
            break
        page_num += 1
        if page_num > max_pages:
            log(f"goddesssnow: hit max_pages safety cap ({max_pages}) -- stopping early")
            break
    return all_items


# ═════════════════════════════════════════════════════════════════════════
# Unified dispatch -- routes to the correct site adapter. This is the ONLY
# place that needs to change to add a future site (e.g. Data18, EvilAngel):
# add a branch here plus a new "SITE ADAPTER: X" section above.
# ═════════════════════════════════════════════════════════════════════════

def discover(candidate_name, config, proxy_url=""):
    """Checks the shared performerStoreMap first (site-agnostic -- works
    regardless of which adapter originally confirmed the entry, and also
    doubles as the persisted answer to a prior multi-site collision, see
    below), then checks EVERY sitemap-backed site's own fuzzy-match
    (iwantclips, clips4sale -- manyvids has no directory at all,
    confirmed live, see module docstring for the manyvids adapter).

    MULTI-SITE COLLISION (confirmed live: "Mina Thorne" matches both
    iwantclips' and clips4sale's sitemaps confidently): both sites are
    ALWAYS checked, never short-circuited on the first confident hit --
    which site happens to run first in code is not a real decision.
      - Exactly one site confident -> behaves exactly as before, that
        match returned directly.
      - Zero sites confident -> falls through to the existing suggestions
        merge (sitemap-fuzzy suggestions from both sites, plus
        clips4sale's sitewide-search suggestions -- a performer's content
        can span multiple clips4sale studios, so a search hit is only
        ever a suggestion, never auto-confirmed).
      - MORE THAN ONE site confident -> never auto-picks either. Instead
        returns confidence "none" with source "multi_site_match" and
        each site's confident match promoted into "suggestions" (reusing
        the exact same click-to-prefill chip UX already built for the
        performer!=studio case -- no new UI concept needed). Whichever
        suggestion the user then confirms gets written into
        performerStoreMap exactly like any other confirmed store
        (existing behavior, unchanged) -- which is also exactly why the
        performerStoreMap check at the top of this function is already
        sufficient to skip straight past this whole collision check on
        every subsequent call for the same performer, without any new
        config field or persistence code needed.

    A match/suggestion always carries an explicit "site" field so the
    caller never has to guess which adapter governs it."""
    norm = normalize(candidate_name)
    performer_store_map = config.get("performerStoreMap") or {}

    if norm in performer_store_map:
        entry = performer_store_map[norm]
        return {
            "confidence": "confident",
            "source": "performerStoreMap",
            "match": {**entry, "displayName": entry.get("displayName") or entry.get("modelUsername") or entry.get("profileId") or entry.get("studioId")},
            "score": 1.0,
            "suggestions": [],
        }

    iwc_result = iwc_discover(candidate_name, proxy_url=proxy_url)
    c4s_result = c4s_discover(candidate_name, proxy_url=proxy_url)
    gs_result = gs_discover(candidate_name)

    confident_results = [r for r in (iwc_result, c4s_result, gs_result) if r["confidence"] == "confident"]

    if len(confident_results) == 1:
        return confident_results[0]

    if len(confident_results) > 1:
        log(f"discover: {candidate_name!r} confidently matched {len(confident_results)} sites "
            f"({[r['match']['site'] for r in confident_results]}) -- surfacing as a choice, not auto-picking")
        suggestions = [{**r["match"], "score": r["score"]} for r in confident_results]
        return {"confidence": "none", "source": "multi_site_match", "match": None, "score": None, "suggestions": suggestions}

    suggestions = (list(iwc_result.get("suggestions") or []) + list(c4s_result.get("suggestions") or [])
                   + list(gs_result.get("suggestions") or []))
    try:
        suggestions += c4s_sitewide_search_suggestions(candidate_name, proxy_url=proxy_url)
    except Exception as e:
        log(f"clips4sale sitewide-search suggestions failed (non-fatal, sitemap suggestions still used): {e}")

    return {"confidence": "none", "source": None, "match": None, "score": None, "suggestions": suggestions}


def search(store_info, title_candidate, config, stash_url, api_key, proxy_url=""):
    site = store_info.get("site")
    if site == "iwantclips":
        result = iwc_search(store_info, title_candidate, proxy_url=proxy_url)
        return result, None
    if site == "manyvids":
        return mv_search(store_info, title_candidate, config, stash_url, api_key, proxy_url=proxy_url)
    if site == "clips4sale":
        result = c4s_search(store_info, title_candidate, proxy_url=proxy_url)
        return result, None
    if site == "goddesssnow":
        result = gs_search(store_info, title_candidate, proxy_url=proxy_url)
        return result, None
    raise RuntimeError(f"Unknown site {site!r} on store info -- cannot search")


def extract(clip_url, site, hit, proxy_url=""):
    """Wraps each adapter's site-specific extraction, then packages the
    result into the SHARED external shape (title, date, description,
    performers, thumbnail, contentUrl). IWC's and MV's own scraping never
    discovers a usable thumbnail directly (IWC never did; MV's JSON-LD
    'contentUrl' is a raw CDN video FILE link, not a bookmarkable page, so
    it's deliberately never used) -- for those two, thumbnail is carried
    through from the confirmed search hit instead, the same place both
    plugins already sourced them from before this unification. clips4sale
    DOES reliably expose a real thumbnail directly on the clip page
    itself (cdn_previewlg_link / srcSet) -- preferred over the hit's when
    the adapter provides one, since it's the more authoritative source
    when available, falling back to the hit's otherwise."""
    if site == "iwantclips":
        scraped = iwc_extract(clip_url, proxy_url=proxy_url)
    elif site == "manyvids":
        scraped = mv_extract(clip_url, proxy_url=proxy_url)
    elif site == "clips4sale":
        scraped = c4s_extract(clip_url, proxy_url=proxy_url)
    elif site == "goddesssnow":
        # The only adapter that needs the hit -- see gs_extract's docstring
        # and the module note in the goddesssnow adapter section above.
        scraped = gs_extract(clip_url, proxy_url=proxy_url, hint=hit)
    else:
        raise RuntimeError(f"Unknown site {site!r} -- cannot extract")

    return {
        **scraped,
        "thumbnail": scraped.get("thumbnail") or (hit or {}).get("thumbnail") or "",
        "contentUrl": clip_url,
    }


# ── Local performer/studio resolution (identical on both source plugins,
# including the alias-matching OR-query fix) ─────────────────────────────

def _query_token(name):
    m = re.search(r"[A-Za-z]+", name)
    return m.group(0) if m else name


def resolve_performer(name, stash_url, api_key):
    clean_name = name.strip()
    norm = normalize(clean_name)
    token = _query_token(clean_name)

    def query(search_value):
        # Must search both name AND aliases -- a performer whose real name
        # doesn't contain the candidate token but whose alias_list does
        # (confirmed live: "LatexnChill" candidate / real name "Lexi Chill"
        # / alias "latexnchill") would otherwise never even enter the
        # results set for the alias-matching logic below to consider.
        data = local_gql(stash_url, api_key, """
            query PerformerByNameOrAlias($value: String!) {
                findPerformers(performer_filter: {
                    name: { value: $value, modifier: INCLUDES }
                    OR: { aliases: { value: $value, modifier: INCLUDES } }
                }) {
                    performers { id name alias_list disambiguation }
                }
            }
        """, {"value": search_value})
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

    # Ported from Data18StashDB's resolve_studio, confirmed live this
    # session to handle the exact real case that broke the old
    # INCLUDES-based query: findStudios(filter: { q }) is Stash's
    # relevance-ranked general search (covers name AND aliases server-
    # side), given the FULL name -- no client-side token truncation.
    # Confirmed live: q="Goddess Alexandra Snow" returns ONLY the
    # correct studio (id 6, "Alexandra Snow", alias "Goddess Alexandra
    # Snow") -- the irrelevant "Goddess Lindsey"/"Urlilgoddess" that an
    # INCLUDES query on a truncated "Goddess" token used to pull in
    # never appear here at all.
    data = local_gql(stash_url, api_key, """
        query StudioSearch($q: String) {
            findStudios(filter: { q: $q, per_page: 10 }) {
                studios { id name aliases }
            }
        }
    """, {"q": clean_name})
    studios = data["findStudios"]["studios"]

    for s in studios:
        if normalize(s["name"]) == norm:
            return {"name": name, "localId": s["id"], "found": True, "matchType": "exact"}

    # Alias tier (ported from Data18 -- SuperScrape's resolve_studio
    # never checked studio aliases at all before this change, which is
    # exactly why it couldn't find "Alexandra Snow" via her registered
    # "Goddess Alexandra Snow" alias even after today's earlier fuzzy-
    # tier fix).
    for s in studios:
        if any(normalize(a) == norm for a in (s.get("aliases") or [])):
            return {"name": name, "localId": s["id"], "found": True, "matchType": "alias"}

    # Fuzzy tier kept as a last resort -- deliberate difference from
    # Data18's version, not an oversight. q: already returns a small,
    # server-side-relevant candidate pool (not the old over-broad
    # token-truncated set), so a fuzzy check here is safe and adds a
    # small extra safety net for near-miss spellings without
    # reintroducing the original bug (which was caused by an irrelevant
    # candidate pool, not by having a fuzzy tier per se).
    best, best_score = None, 0
    for s in studios:
        score = SequenceMatcher(None, norm, normalize(s["name"])).ratio()
        if score > best_score:
            best_score, best = score, s
    if best and best_score >= FUZZY_MATCH_THRESHOLD:
        return {"name": name, "localId": best["id"], "found": True, "matchType": "fuzzy", "score": round(best_score, 3)}

    return {"name": name, "localId": None, "found": False}


# ── Duplicate detection (Data18-style warning step, adapted for a
# no-stash-id-concept world) ─────────────────────────────────────────────
# Two independent methods, either sufficient to flag a possible duplicate:
#   1. performer + title fuzzy match against local scenes sharing at least
#      one resolved performer (same FUZZY_MATCH_THRESHOLD used elsewhere).
#   2. phash match -- confirmed live via introspection that SceneFilterType
#      has a direct `phash: StringCriterionInput` field, verified against
#      a real scene's own fingerprint (matches itself, self excluded by id
#      in code, not by the query).

def find_duplicate_scenes(scraped_title, performer_ids, current_scene_id, current_phashes, stash_url, api_key):
    dupes = {}

    if performer_ids and scraped_title:
        data = local_gql(stash_url, api_key, """
            query DupesByPerformer($ids: [ID!]) {
                findScenes(scene_filter: { performers: { value: $ids, modifier: INCLUDES } }, filter: { per_page: 50 }) {
                    scenes { id title date paths { screenshot } files { size } performers { name } }
                }
            }
        """, {"ids": performer_ids})
        norm_title = normalize(scraped_title)
        for s in data["findScenes"]["scenes"]:
            if s["id"] == current_scene_id:
                continue
            score = SequenceMatcher(None, norm_title, normalize(s.get("title") or "")).ratio()
            if score >= FUZZY_MATCH_THRESHOLD:
                dupes[s["id"]] = {**s, "matchReason": f"title match ({round(score, 2)})"}

    for ph in (current_phashes or []):
        if not ph:
            continue
        data = local_gql(stash_url, api_key, """
            query DupesByPhash($value: String!) {
                findScenes(scene_filter: { phash: { value: $value, modifier: EQUALS } }, filter: { per_page: 10 }) {
                    scenes { id title date paths { screenshot } files { size } performers { name } }
                }
            }
        """, {"value": ph})
        for s in data["findScenes"]["scenes"]:
            if s["id"] == current_scene_id:
                continue
            dupes.setdefault(s["id"], {**s, "matchReason": "identical file (phash)"})

    return list(dupes.values())


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
            test_map["_configtest"] = {"site": "iwantclips", "modelUsername": "_configtest",
                                        "storeUrl": "https://example.invalid/store/0/_configtest"}
            write_config(stash_url, api_key, {"performerStoreMap": test_map})
            verify = read_config(stash_url, api_key)
            ok = verify["performerStoreMap"].get("_configtest", {}).get("modelUsername") == "_configtest"

            test_map.pop("_configtest", None)
            write_config(stash_url, api_key, {"performerStoreMap": test_map})

            result = {"ok": ok, "message": "Config round-trip succeeded" if ok else "Config round-trip FAILED"}

        elif mode == "parse_filename":
            filename = args.get("filename", "")
            settings = read_config(stash_url, api_key)
            known_names = set(settings["performerStoreMap"].keys())
            parsed = parse_filename(filename, known_names)
            result = {"ok": True, "output": parsed}

        elif mode == "discover_store":
            performer_name = args.get("performer_name", "")
            settings = read_config(stash_url, api_key)
            match = discover(performer_name, settings, proxy_url=settings.get("proxyUrl", ""))
            result = {"ok": True, "output": match}

        elif mode == "detect_site":
            url = args.get("url", "")
            site = detect_site_from_url(url)
            if not site:
                raise RuntimeError(
                    f"That URL's domain doesn't match a known site ({', '.join(SITE_DOMAINS.keys())}): {url}"
                )
            result = {"ok": True, "output": {"site": site}}

        elif mode == "search_store":
            store_info = json.loads(args.get("store_info", "{}"))
            title_candidate = args.get("title_candidate", "")
            if not store_info.get("site"):
                raise RuntimeError("search_store requires store_info with a 'site' field")
            settings = read_config(stash_url, api_key)
            output, new_cache_entry = search(store_info, title_candidate, settings, stash_url, api_key,
                                              proxy_url=settings.get("proxyUrl", ""))
            if new_cache_entry is not None:
                profile_id = store_info.get("profileId")
                cache = dict(settings.get("storeCatalogCache") or {})
                cache[profile_id] = new_cache_entry
                write_config(stash_url, api_key, {"storeCatalogCache": cache})
            result = {"ok": True, "output": output}

        elif mode == "scrape_clip":
            url = args.get("url", "")
            site = args.get("site", "")
            studio_name = args.get("studio_name", "")
            hit = json.loads(args.get("hit", "{}"))
            if not url or not site:
                raise RuntimeError("scrape_clip requires url and site")
            settings = read_config(stash_url, api_key)
            scraped = extract(url, site, hit, proxy_url=settings.get("proxyUrl", ""))
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

        elif mode == "check_duplicates":
            scraped_title = args.get("scraped_title", "")
            performer_ids = json.loads(args.get("performer_ids", "[]"))
            current_scene_id = args.get("current_scene_id", "")
            current_phashes = json.loads(args.get("current_phashes", "[]"))
            dupes = find_duplicate_scenes(scraped_title, performer_ids, current_scene_id,
                                           current_phashes, stash_url, api_key)
            result = {"ok": True, "output": {"duplicates": dupes}}

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
