#!/usr/bin/env python3
"""
Data18StashDB.py — Plugin backend (simplified)

Two modes:
  scrape_movie  - fetch data18.com/movies/ page, return scene list
  scrape_scene  - fetch data18.com/scenes/ page AND search StashDB,
                  return { scraped, candidates } in one shot

Result is stored in a __d18_result__ Stash tag for the JS to read.

Dependencies:
    pip install requests beautifulsoup4
"""

import json
import re
import sys
from datetime import datetime

import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
import requests
from bs4 import BeautifulSoup

# ── Configuration ─────────────────────────────────────────────────────────────
# Credentials are loaded from config.ini in the same directory as this script.
# Copy config.ini.example to config.ini and fill in your values.
# config.ini is gitignored and never committed.

import configparser as _configparser
from pathlib import Path as _Path

def _load_config():
    cfg = _configparser.ConfigParser()
    ini_path = _Path(__file__).parent / "config.ini"
    if not ini_path.exists():
        raise FileNotFoundError(
            f"config.ini not found at {ini_path}\n"
            "Copy config.ini.example to config.ini and fill in your StashDB API key."
        )
    cfg.read(ini_path, encoding="utf-8")
    return cfg

_cfg = _load_config()
STASHDB_URL     = _cfg.get("StashDB", "url",     fallback="https://stashdb.org/graphql")
STASHDB_API_KEY = _cfg.get("StashDB", "api_key", fallback="")
# ──────────────────────────────────────────────────────────────────────────────


def log(msg):
    print(f"time='' level=info msg='[Data18StashDB] {msg}'", flush=True)


# ── Plugin settings (populated in main() from Stash's own config) ─────────
settings = {}


# ── Sessions ───────────────────────────────────────────────────────────────────

def data18_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:79.0) Gecko/20100101 Firefox/79.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
    })
    s.cookies.set("data_user_captcha", "1", domain=".data18.com", path="/")
    s.verify = False

    proxy_url = settings.get("proxyUrl", "").strip()
    if proxy_url:
        s.proxies = {"http": proxy_url, "https": proxy_url}
        log(f"Using outbound proxy: {proxy_url}")

    return s


def stashdb_gql(query, variables=None):
    resp = requests.post(
        STASHDB_URL,
        json={"query": query, "variables": variables or {}},
        headers={"Content-Type": "application/json", "ApiKey": STASHDB_API_KEY},
        timeout=20,
    )
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise RuntimeError(body["errors"][0]["message"])
    return body["data"]


def local_gql(stash_url, api_key, query, variables=None):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["ApiKey"] = api_key
    resp = requests.post(stash_url,
        json={"query": query, "variables": variables or {}},
        headers=headers, timeout=15)
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise RuntimeError(body["errors"][0]["message"])
    return body["data"]


# ── Date parsing ───────────────────────────────────────────────────────────────

DATE_FORMATS = [
    (r"([A-Za-z]+ \d{1,2},?\s*\d{4})", "%B %d %Y"),
    (r"(\d{4}-\d{2}-\d{2})",            "%Y-%m-%d"),
    (r"(\d{1,2}/\d{1,2}/\d{4})",        "%m/%d/%Y"),
    (r"(\d{1,2} [A-Za-z]+ \d{4})",      "%d %B %Y"),
]

def parse_date(text):
    if not text:
        return None
    for pattern, fmt in DATE_FORMATS:
        m = re.search(pattern, text)
        if m:
            raw = re.sub(r"[,.]", "", m.group(1))
            raw = re.sub(r"\s+", " ", raw).strip()
            try:
                return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
    return None


# ── Data18 scrapers ────────────────────────────────────────────────────────────

def scrape_movie(url):
    session = data18_session()
    log(f"Fetching movie: {url}")
    resp = session.get(url, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    # Movie title from <title> tag, strip " | DATA18" suffix
    title_tag = soup.find("title")
    movie_title = ""
    if title_tag:
        raw = title_tag.get_text(strip=True)
        movie_title = re.sub(r"\s*\(\d{4}\)(?:\sPorn)?\sMovie\s\|\sDATA18.*$", "", raw, flags=re.I).strip()
        movie_title = re.sub(r"\s+#1$", "", movie_title).strip()

    # Cover image from <a id="enlargecover" data-featherlight="...">
    movie_image = ""
    cover_a = soup.find("a", id="enlargecover")
    if cover_a:
        movie_image = cover_a.get("data-featherlight", "")

    # Scene list lives in #indexscenes — target it specifically to avoid
    # duplicates from the sidebar (#relatedscenes has the same links)
    index_div = soup.find("div", id="indexscenes")
    if not index_div:
        raise ValueError("Could not find scene list (#indexscenes) on this movie page.")

    # Each scene is a direct child div with style containing "height: 150px"
    # Structure per scene block:
    #   <div style="...height: 150px...">
    #     <div>  <- thumbnail column
    #       <a href="/scenes/NNNNNNN"><img data-src="...thumbnail..."></a>
    #     </div>
    #     <div>  <- info column
    #       <b>Scene #N</b>
    #       <p>Length: ...</p>
    #       <p>Performer1, Performer2</p>
    #     </div>
    #   </div>
    # Match only the outer scene container divs — exclude the inner thumbnail
    # divs which also have height:150px but additionally have "float: left"
    all_150 = index_div.find_all("div", style=re.compile(r"height:\s*150px"))
    scene_blocks = [d for d in all_150 if "float" not in (d.get("style") or "")]
    log(f"Found {len(scene_blocks)} scene blocks in #indexscenes")

    if not scene_blocks:
        raise ValueError("No scene blocks found inside #indexscenes.")

    scenes = []
    for idx, block in enumerate(scene_blocks):
        # Scene URL from the first <a href="/scenes/NNN"> in the block
        scene_url = ""
        scene_a = block.find("a", href=re.compile(r"/scenes/\d+"))
        if scene_a:
            href = scene_a.get("href", "")
            scene_url = (href if href.startswith("http") else
                         "https://www.data18.com" + href)

        # Thumbnail: img uses data-src (lazy loaded)
        image = ""
        img = block.find("img")
        if img:
            src = img.get("data-src") or img.get("src", "")
            if src and src != "https://cdn.dt18.com/images/pixel.jpg":
                image = src if src.startswith("http") else f"https:{src}"

        # CDN thumbnail fallback using scene ID
        if not image and scene_url:
            m = re.search(r"/scenes/(\d+)", scene_url)
            if m:
                sid = m.group(1)
                if len(sid) >= 6:
                    image = f"https://cdn.dt18.com/media/t/3/scenes/{sid[:-6] or '0'}/{sid[-6:]}.jpg"
                else:
                    image = f"https://cdn.dt18.com/media/t/3/scenes/0/{sid}.jpg"

        # Scene title: <b>Scene #N</b>
        title = ""
        b_tag = block.find("b")
        if b_tag:
            title = b_tag.get_text(strip=True)  # e.g. "Scene #1"

        # Performers: second <p> tag in the info column contains "Name1, Name2"
        performers = []
        p_tags = block.find_all("p")
        for p in p_tags:
            text = p.get_text(strip=True)
            # Skip length/timecode lines
            if re.search(r"\d{2}:\d{2}:\d{2}", text):
                continue
            if text:
                # Split on comma for multiple performers
                names = [n.strip() for n in text.split(",") if n.strip()]
                performers = names
                break

        scenes.append({
            "sceneIndex": idx + 1,
            "sceneUrl":   scene_url,
            "title":      title or f"Scene {idx + 1}",
            "performers": performers,
            "date":       "",   # not on movie page; scraped individually if needed
            "image":      image,
        })

    return {"movieTitle": movie_title, "movieImage": movie_image, "scenes": scenes}


def scrape_scene(url):
    session = data18_session()
    log(f"Fetching scene: {url}")
    resp = session.get(url, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    result = {"url": url}

    h1 = soup.find("h1", itemprop="name") or soup.find("h1")
    if h1:
        result["title"] = h1.get_text(strip=True)
    else:
        pt = soup.title.string if soup.title else ""
        result["title"] = re.sub(r"\s*[|\-–]\s*DATA18.*$", "", pt, flags=re.I).strip()

    performers, seen = [], set()
    cast_div = None
    for h3 in soup.find_all("h3"):
        if re.search(r"Pornstars|Cast", h3.get_text(), re.I):
            cast_div = h3.find_parent("div")
            break
    if cast_div:
        for a in cast_div.find_all("a", class_="bold gen"):
            name = a.get_text(strip=True)
            if name and name not in seen:
                seen.add(name); performers.append(name)
    if not performers:
        for tag in soup.find_all("span", itemprop="actor"):
            ns = tag.find(itemprop="name")
            name = (ns or tag).get_text(strip=True)
            if name and name not in seen:
                seen.add(name); performers.append(name)
    result["performers"] = performers

    studio_tag = (soup.find("span", itemprop="productionCompany")
                  or soup.find("a", itemprop="productionCompany"))
    if not studio_tag:
        for b in soup.find_all("b"):
            if re.search(r"Studio|Network", b.get_text(strip=True), re.I):
                # Try next sibling <a> first, then look for any <a> in the parent
                a = b.find_next_sibling("a")
                if not a:
                    parent = b.parent
                    if parent:
                        a = parent.find("a", href=re.compile(r"/studios/"))
                if a:
                    studio_tag = a; break
    result["studio"] = studio_tag.get_text(strip=True) if studio_tag else ""

    date_tag = soup.find(itemprop="datePublished")
    if date_tag:
        result["date"] = parse_date(date_tag.get("content") or date_tag.get_text()) or ""
    else:
        result["date"] = parse_date(soup.get_text(separator=" ")) or ""

    for b in soup.find_all("b"):
        if re.search(r"^Story$|Movie Description", b.get_text(strip=True), re.I):
            parent = b.find_parent("div") or b.parent
            text = re.sub(r"^Story\s*-?\s*", "",
                          parent.get_text(separator=" ", strip=True)).strip()
            result["description"] = re.sub(r"\s+", " ", text)
            break
    else:
        desc = soup.find(itemprop="description")
        result["description"] = re.sub(r"\s+", " ",
            desc.get_text(separator=" ")).strip() if desc else ""

    tags = []
    for b in soup.find_all("b"):
        if "Categories" in b.get_text():
            for a in b.find_next_siblings("a"):
                name = a.get_text(strip=True)
                if name: tags.append(name)
            break
    result["tags"] = tags

    img = (soup.find("img", id="playpriimage")
           or soup.find("img", itemprop="image")
           or soup.select_one("#player-wrap img, div.player img"))
    if img:
        src = img.get("src") or img.get("data-src", "")
        result["image"] = src if src.startswith("http") else (f"https:{src}" if src else "")
    else:
        result["image"] = ""

    return result


# ── StashDB search ─────────────────────────────────────────────────────────────

def build_query(scraped):
    """Build a StashDB search query from scraped scene data.
    Order: studio first, then performers — gives StashDB the best chance
    of finding the right scene.
    """
    studio = scraped.get("studio", "")
    performers = (scraped.get("performers") or [])[:2]
    parts = []
    if studio:
        parts.append(studio)
    parts.extend(performers)
    return " ".join(parts) or scraped.get("title", "")


def search_stashdb(query):
    log(f"Searching StashDB: {query!r}")
    data = stashdb_gql("""
        query SearchScenes($term: String!) {
            searchScene(term: $term, limit: 10) {
                id title date details
                urls { url }
                images { url }
                studio { name }
                performers { performer { name } as }
                tags { name }
            }
        }
    """, {"term": query})

    results = []
    for s in data.get("searchScene", []):
        results.append({
            "remote_site_id": s.get("id", ""),
            "title":    s.get("title", ""),
            "date":     s.get("date", ""),
            "details":  s.get("details", ""),
            "urls":     [u["url"] for u in (s.get("urls") or [])],
            "image":    s["images"][0]["url"] if s.get("images") else "",
            "studio":   {"name": s["studio"]["name"]} if s.get("studio") else None,
            "performers": [{"name": p.get("as") or p["performer"]["name"]}
                           for p in (s.get("performers") or [])],
            "tags":     [{"name": t["name"]} for t in (s.get("tags") or [])],
        })
    return results


# ── Local Stash resolution with alias support ─────────────────────────────────

def resolve_performers(stash_url, api_key, names):
    """
    For each performer name from StashDB, find the matching local Stash performer.
    Checks name and alias_list (case-insensitive).
    Returns list of { name, localId, found } dicts.
    """
    results = []
    for name in names:
        data = local_gql(stash_url, api_key, """
            query F($q: String) {
                findPerformers(filter: { q: $q, per_page: 10 }) {
                    performers { id name alias_list }
                }
            }
        """, {"q": name})
        performers = data["findPerformers"]["performers"]
        name_lower = name.lower()
        found = None
        # Exact name match first
        for p in performers:
            if p["name"].lower() == name_lower:
                found = p; break
        # Then alias match
        if not found:
            for p in performers:
                if any(a.lower() == name_lower for a in (p.get("alias_list") or [])):
                    found = p; break
        results.append({
            "name":    name,
            "localId": found["id"] if found else None,
            "found":   bool(found),
        })
    return results


def resolve_studio(stash_url, api_key, name):
    """
    Find a matching local Stash studio by name or alias.
    Returns { name, localId, found }.
    """
    if not name:
        return {"name": "", "localId": None, "found": False}

    data = local_gql(stash_url, api_key, """
        query F($q: String) {
            findStudios(filter: { q: $q, per_page: 10 }) {
                studios { id name aliases }
            }
        }
    """, {"q": name})
    studios  = data["findStudios"]["studios"]
    name_lower = name.lower()
    found = None
    for s in studios:
        if s["name"].lower() == name_lower:
            found = s; break
    if not found:
        for s in studios:
            if any(a.lower() == name_lower for a in (s.get("aliases") or [])):
                found = s; break
    return {
        "name":    name,
        "localId": found["id"] if found else None,
        "found":   bool(found),
    }


def resolve_tags(stash_url, api_key, tag_names):
    """
    For each tag name from StashDB, find the matching local Stash tag.
    Checks name and aliases (case-insensitive).
    Returns list of { name, localId, found } dicts.
    """
    results = []
    for name in tag_names:
        data = local_gql(stash_url, api_key, """
            query F($q: String) {
                findTags(filter: { q: $q, per_page: 10 }) {
                    tags { id name aliases }
                }
            }
        """, {"q": name})
        tags = data["findTags"]["tags"]
        name_lower = name.lower()
        found = None
        for t in tags:
            if t["name"].lower() == name_lower:
                found = t; break
        if not found:
            for t in tags:
                if any(a.lower() == name_lower for a in (t.get("aliases") or [])):
                    found = t; break
        results.append({
            "name":    name,
            "localId": found["id"] if found else None,
            "found":   bool(found),
        })
    return results


# ── Result store ───────────────────────────────────────────────────────────────

RESULT_TAG = "__d18_result__"

def store_result(stash_url, api_key, result):
    encoded = json.dumps(result)
    data = local_gql(stash_url, api_key,
        'query{findTags(filter:{q:"__d18_result__",per_page:1}){tags{id name}}}')
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


# ── Main ───────────────────────────────────────────────────────────────────────

def get_stash_connection(plugin_input):
    sc   = plugin_input.get("server_connection", {})
    host = sc.get("Host", "localhost")
    # Stash sometimes passes 0.0.0.0 which is invalid on Windows
    if host in ("0.0.0.0", "", None):
        host = "localhost"
    url = f"{sc.get('Scheme','http')}://{host}:{sc.get('Port',9999)}/graphql"
    return url, sc.get("ApiKey", "")


def main():
    raw = sys.stdin.read().strip()
    try:
        plugin_input = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        plugin_input = {}

    args = plugin_input.get("args", {})
    mode = args.get("mode", "")
    url  = args.get("url", "").strip()
    stash_url, api_key = get_stash_connection(plugin_input)

    global settings
    try:
        cfg = local_gql(stash_url, api_key, "{ configuration { plugins } }")
        settings = (cfg["configuration"]["plugins"] or {}).get("Data18StashDB", {})
    except Exception as e:
        log(f"Could not read plugin settings: {e}")

    try:
        if mode == "scrape_movie":
            result = {"output": scrape_movie(url)}

        elif mode == "scrape_scene":
            # Scrape scene AND search StashDB in one task
            scraped    = scrape_scene(url)
            # Allow JS to pass a custom query override (for re-search)
            query      = args.get("query_override", "").strip() or build_query(scraped)
            candidates = search_stashdb(query)

            # Resolve each candidate's performers, studio, and tags against
            # local Stash (including aliases) so the JS picker can show
            # match status and pre-check the right items
            for candidate in candidates:
                perf_names = [p["name"] for p in (candidate.get("performers") or [])]
                tag_names  = [t["name"] for t in (candidate.get("tags") or [])]
                studio_name = (candidate.get("studio") or {}).get("name", "")

                candidate["resolved_performers"] = resolve_performers(stash_url, api_key, perf_names)
                candidate["resolved_studio"]     = resolve_studio(stash_url, api_key, studio_name)
                candidate["resolved_tags"]        = resolve_tags(stash_url, api_key, tag_names)

            result = {"output": {"scraped": scraped, "candidates": candidates, "query": query}}

        else:
            result = {"error": f"Unknown mode: {mode!r}"}

    except requests.HTTPError as e:
        result = {"error": f"HTTP {e.response.status_code}: {e.response.url}"}
    except Exception as e:
        print(f"[Data18StashDB] Error: {e}", file=sys.stderr, flush=True)
        result = {"error": str(e)}

    store_result(stash_url, api_key, result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
