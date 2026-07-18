"""
SubmitToMyStashBox.py — Plugin backend.

Submits a single scene (given scene_id) to a configured destination
stash-box as a CREATE edit and immediately applies it (auto-approve).
Result is stored in a __stmsb_result__ Stash tag for the JS to read
(same RESULT_TAG pattern as Data18StashDB.py).

Dependencies:
    pip install requests
"""

import json
import sys

import requests

RESULT_TAG = "__stmsb_result__"
VALID_FP_ALGOS = {"PHASH", "OSHASH"}


def log_info(msg):
    print(f"time='' level=info msg='[SubmitToMyStashBox] {msg}'", flush=True)


def log(msg):
    print(f"[SubmitToMyStashBox] {msg}", file=sys.stderr, flush=True)


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


def dest_gql(url, api_key, query, variables=None):
    headers = {"Content-Type": "application/json", "ApiKey": api_key}
    resp = requests.post(url, json={"query": query, "variables": variables or {}},
                          headers=headers, timeout=20)
    resp.raise_for_status()
    body = resp.json()
    if "errors" in body:
        raise RuntimeError(body["errors"][0]["message"])
    return body["data"]


# ── Result store (RESULT_TAG pattern) ────────────────────────────────────────

def store_result(local_url, local_api_key, result):
    encoded = json.dumps(result)
    data = local_gql(local_url, local_api_key,
        f'query{{findTags(filter:{{q:"{RESULT_TAG}",per_page:1}}){{tags{{id name}}}}}}')
    tags = [t for t in data["findTags"]["tags"] if t["name"] == RESULT_TAG]
    if tags:
        local_gql(local_url, local_api_key,
            "mutation U($i:TagUpdateInput!){tagUpdate(input:$i){id}}",
            {"i": {"id": tags[0]["id"], "description": encoded}})
    else:
        local_gql(local_url, local_api_key,
            "mutation C($i:TagCreateInput!){tagCreate(input:$i){id}}",
            {"i": {"name": RESULT_TAG, "description": encoded}})
    log_info("Result stored")


FIND_SCENE_QUERY = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id
    title
    details
    date
    urls
    tags { id name stash_ids { endpoint stash_id } }
    files { duration fingerprints { type value } }
    studio { id name stash_ids { endpoint stash_id } }
    performers { id name stash_ids { endpoint stash_id } }
  }
}
"""

SCENE_EDIT_MUTATION = "mutation SceneEdit($input: SceneEditInput!) { sceneEdit(input: $input) { id } }"
APPLY_EDIT_MUTATION = "mutation ApplyEdit($input: ApplyEditInput!) { applyEdit(input: $input) { id } }"
IMAGE_UPLOAD_MUTATION = "mutation ImageUpload($file: Upload!) { imageCreate(input: { file: $file }) { id } }"
UPDATE_SCENE_MUTATION = "mutation UpdateScene($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id organized } }"


def submit_scene(local_url, local_api_key, dest_url, dest_api_key, dest_site_id, scene_id):
    data = local_gql(local_url, local_api_key, FIND_SCENE_QUERY, {"id": scene_id})
    scene = data.get("findScene")
    if not scene:
        raise RuntimeError(f"Scene {scene_id} not found")

    # Performers — every performer must already have a destination stash_id
    performer_entities = []
    for p in scene.get("performers", []):
        dest_pid = next((s["stash_id"] for s in p.get("stash_ids", [])
                          if s["endpoint"] == dest_url), None)
        if not dest_pid:
            raise RuntimeError(f"Performer '{p['name']}' missing destination stash_id")
        performer_entities.append({"performer_id": dest_pid, "as": None})

    # Tags — every tag must already have a destination stash_id
    tag_ids = []
    for tag in scene.get("tags", []):
        dest_tid = next((s["stash_id"] for s in tag.get("stash_ids", [])
                          if s["endpoint"] == dest_url), None)
        if not dest_tid:
            raise RuntimeError(f"Tag '{tag['name']}' missing destination stash_id")
        tag_ids.append(dest_tid)

    # Fingerprints
    fingerprint_entities = []
    for f in scene.get("files", []):
        try:
            duration = int(f.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0
        for fp in f.get("fingerprints", []):
            algo = fp["type"].strip().upper()
            if algo not in VALID_FP_ALGOS:
                continue
            fingerprint_entities.append({"hash": fp["value"], "algorithm": algo, "duration": duration})

    # Studio — optional, no error if missing
    studio = scene.get("studio")
    dest_studio_uuid = None
    if studio and studio.get("stash_ids"):
        dest_studio_uuid = next((s["stash_id"] for s in studio["stash_ids"]
                                  if s["endpoint"] == dest_url), None)

    # Cover image
    log_info("Fetching scene cover...")
    base = local_url.rsplit("/", 1)[0]
    image_ids = []
    for cover_url in (f"{base}/scene/{scene_id}/screenshot", f"{base}/scene/{scene_id}/image"):
        resp = requests.get(cover_url, headers={"ApiKey": local_api_key} if local_api_key else {})
        if resp.status_code == 200 and resp.content:
            upload_ops = {"query": IMAGE_UPLOAD_MUTATION, "variables": {"file": None}}
            upload_map = {"0": ["variables.file"]}
            upload_resp = requests.post(
                dest_url,
                data={"operations": json.dumps(upload_ops), "map": json.dumps(upload_map)},
                files={"0": ("image.jpg", resp.content, "image/jpeg")},
                headers={"ApiKey": dest_api_key},
                timeout=30,
            )
            upload_resp.raise_for_status()
            upload_json = upload_resp.json()
            if "errors" in upload_json:
                raise RuntimeError(upload_json["errors"][0]["message"])
            image_ids.append(upload_json["data"]["imageCreate"]["id"])
            log_info(f"Uploaded cover image -> {image_ids[0]}")
            break

    # SceneEdit (CREATE) -> applyEdit
    urls = [{"url": u, "site_id": dest_site_id} for u in (scene.get("urls") or [])]
    scene_edit_input = {
        "edit": {"operation": "CREATE", "comment": "Imported from Stash", "bot": True},
        "details": {
            "title": scene.get("title"),
            "details": scene.get("details"),
            "date": scene.get("date"),
            "urls": urls,
            "studio_id": dest_studio_uuid,
            "performers": performer_entities,
            "tag_ids": tag_ids,
            "fingerprints": fingerprint_entities,
            "image_ids": image_ids,
        },
    }
    edit_data = dest_gql(dest_url, dest_api_key, SCENE_EDIT_MUTATION, {"input": scene_edit_input})
    edit_id = edit_data["sceneEdit"]["id"]
    log_info(f"SceneEdit created -> {edit_id}")

    dest_gql(dest_url, dest_api_key, APPLY_EDIT_MUTATION, {"input": {"id": edit_id}})
    log_info("Edit applied")

    # Unset organized flag on success — unconditional now (the reference script
    # gated this on "updated today" because it ran as a daily batch; this runs
    # per-scene on demand, so that gate no longer applies)
    local_gql(local_url, local_api_key, UPDATE_SCENE_MUTATION,
              {"input": {"id": scene_id, "organized": False}})
    log_info(f"Organized flag cleared for scene {scene_id}")

    return "Submitted and approved. Organized flag cleared."


def main():
    raw = sys.stdin.read().strip()
    plugin_input = json.loads(raw) if raw else {}
    args = plugin_input.get("args", {})
    scene_id = args.get("scene_id")

    local_url, local_api_key = get_stash_connection(plugin_input)

    settings = {"destUrl": "", "destApiKey": "", "destSiteId": ""}
    try:
        cfg = local_gql(local_url, local_api_key, "{ configuration { plugins } }")
        plugin_cfg = (cfg["configuration"]["plugins"] or {}).get("SubmitToMyStashBox", {})
        settings.update(plugin_cfg)
    except Exception as e:
        log(f"Could not read plugin settings: {e}")

    try:
        if not scene_id:
            raise RuntimeError("No scene_id provided")
        if not settings["destUrl"] or not settings["destApiKey"] or not settings["destSiteId"]:
            raise RuntimeError("Destination stash-box is not configured (destUrl/destApiKey/destSiteId)")

        message = submit_scene(local_url, local_api_key, settings["destUrl"],
                                settings["destApiKey"], settings["destSiteId"], scene_id)
        result = {"ok": True, "message": message}
    except requests.HTTPError as e:
        log(f"HTTP error: {e}")
        result = {"ok": False, "error": f"HTTP {e.response.status_code}: {e.response.url}"}
    except Exception as e:
        log(f"Error: {e}")
        result = {"ok": False, "error": str(e)}

    store_result(local_url, local_api_key, result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
