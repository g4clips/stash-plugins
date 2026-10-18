# Reels Plugin Investigation

Live instance: http://192.168.4.100:6969, Stash v0.31.1 (CONFIRMED via `{ version { version build_time } }`).
Stash source: C:\Users\admin\Documents\stash-source (commit `28c2b52dcb3e749d90c5f3a3d382e99d4a8294b4`).
CommunityScripts: C:\Users\admin\Documents\CommunityScripts.

Missing file note (CONFIRMED by filesystem search): `dev-notes-2026-07-19` / `dev-notes-2026-07-26` referenced in plugin READMEs do not exist on disk anywhere searched. Not used as a source here.

---

## A. Schema

### A1. Version + plugins
CONFIRMED. `{ version { version build_time } }` → `v0.31.1`.
`{ plugins { id name version } }` →
```
Data18StashDB 3.4.0, FindDuplicates 1.5.2, FixCover 0.1.0, SuperScrape 0.21.0,
TabToggler 1.0.0, TagChips 0.5.2, CommunityScriptsUILibrary 1.0.0,
tagScenesWithPerfTags 1.0.3, easytag 0.17, marker-scenes 1.2.0,
seek-controls 1.0.1, stash-reports 1.1.0, stash-tv 2.30.0
```
Stash TV's real plugin id is `stash-tv` (confirmed — used successfully as the path segment in `/plugin/stash-tv/javascript`).

### A2. SceneFilterType
CONFIRMED via `__type(name:"SceneFilterType"){inputFields{...}}`.
- `orientation: OrientationCriterionInput` → `{ value: [OrientationEnum!]! }`. `OrientationEnum` values (CONFIRMED): `LANDSCAPE`, `PORTRAIT`, `SQUARE`.
- `duration: IntCriterionInput` → `{ value: Int!, value2: Int, modifier: CriterionModifier! }` (used `LESS_THAN` successfully).
- `resolution: ResolutionCriterionInput` → `{ value: ResolutionEnum!, modifier: CriterionModifier! }`. `ResolutionEnum` values (CONFIRMED): `VERY_LOW, LOW, R360P, STANDARD, WEB_HD, STANDARD_HD, FULL_HD, QUAD_HD, FOUR_K, FIVE_K, SIX_K, SEVEN_K, EIGHT_K, HUGE`.
- `tags: HierarchicalMultiCriterionInput` → modifier is `CriterionModifier`, values include `INCLUDES`, `EXCLUDES`, `INCLUDES_ALL` (plus `EQUALS, NOT_EQUALS, GREATER_THAN, LESS_THAN, IS_NULL, NOT_NULL, MATCHES_REGEX, NOT_MATCHES_REGEX, BETWEEN, NOT_BETWEEN`) — full `CriterionModifier` enum CONFIRMED.
- "missing" style filter: `is_missing: String` (a scalar, not an enum — takes a string like `"studio"`/`"performers"`, standard Stash convention) and `has_markers: String`. No separate boolean "is_missing_file" field was found; `is_missing` is the generic mechanism.
- `duplicated: DuplicationCriterionInput` exists too (not needed for Reels but noted).

### A3. FindFilterType / random sort / per_page -1
CONFIRMED. `FindFilterType` fields: `q, page, per_page, sort, direction (SortDirectionEnum: ASC|DESC)`.
- Ran two live queries with `sort:"random_12345"`, same seed, `per_page:10`, `page:1` vs `page:2`, same `scene_filter` (portrait, duration<300). Page 1 returned ids `[14465,14459,19220,14454,14443,11299,11376,19609,11369,11405]`, page 2 returned `[14457,11471,11451,11319,11309,11313,11259,11410,11265,14461]` — **zero overlap between the two pages**, confirming a seeded random sort gives a stable shuffled order across pages (no duplicates, no gaps observed in the sample).
- `per_page:-1` tested on `findScenes` (not just `findTags`): query returned `count: 123` and `scenes` array length `123` (all rows, no pagination) — CONFIRMED `per_page:-1` works for `findScenes` too.

### A4. VideoFile fields
CONFIRMED via introspection: `id, path, basename, parent_folder, zip_file, mod_time, size, fingerprint, fingerprints, format, width, height, duration, video_codec, audio_codec, frame_rate, bit_rate, created_at, updated_at`.
**No rotation/orientation metadata field exists on `VideoFile`** — querying `rotation` returns a GraphQL validation error ("Cannot query field \"rotation\" on type \"VideoFile\"."). `width`/`height` are the only geometry fields exposed; Stash's own `orientation` scene filter (OrientationEnum) is presumably derived server-side from width vs height (and possibly embedded rotation metadata it doesn't expose), not something the plugin can introspect directly.

### A5. Scene.paths / sceneStreams
CONFIRMED via introspection. `ScenePathsType` fields: `screenshot, preview, stream, webp, vtt, sprite, funscript, interactive_heatmap, caption`. All `String` scalars (URLs).
A `sceneStreams` top-level query exists (`Query.sceneStreams`, confirmed present in the schema's field list) — not deep-introspected for its label/mime-type sub-shape in this pass; flagged as something to introspect further (`__type(name:"SceneStreamEndpoint"){fields{name}}` or similar) before relying on it. ASSUMED it returns `{label, url, mime_type}`-style entries per Stash convention, not independently confirmed.

### A6. Studio/Performer/Tag field names
CONFIRMED via introspection:
- `Studio.image_path` (exact name, confirmed field list includes `image_path`, `scene_count`).
- `Performer.image_path` (exact name, confirmed).
- `Tag.scene_count` (exact name, confirmed) — Tag also has `scene_marker_count, image_count, gallery_count, performer_count, studio_count, group_count`.

### A7. Mutations (introspected only, none executed)
CONFIRMED via `__schema{mutationType{fields{...}}}` and targeted `__type` introspection:
- `bulkSceneUpdate(input: BulkSceneUpdateInput!)`. `BulkSceneUpdateInput.tag_ids: BulkUpdateIds`. `BulkUpdateIds` = `{ ids: [ID!], mode: BulkUpdateIdMode! }`. **`BulkUpdateIdMode` enum confirmed: `SET, ADD, REMOVE`** — so yes, additive/subtractive tag updates are supported without re-sending the full tag list.
- `sceneUpdate` exists (standard single-scene update mutation, not deep-inspected further — same general shape as bulk minus the `ids` list).
- Play-tracking mutations, real names (CONFIRMED, not `sceneSaveActivity`/`sceneAddPlay` guesses — both of those names do exist too): `sceneAddPlay(id: ID!, times: [Timestamp!])`, `sceneDeletePlay(id: ID!, times: [Timestamp!])`, `sceneResetPlayCount(id: ID!)`, `sceneSaveActivity(id: ID!, resume_time: Float, playDuration: Float)`, `sceneResetActivity(id: ID!, reset_resume: Boolean, reset_duration: Boolean)`.
- `tagCreate` exists in the mutation list (not deep-inspected; standard `TagCreateInput` with `name` required by Stash convention — ASSUMED shape, not introspected field-by-field here).
- `configurePlugin` exists in the mutation list; live `{ configuration { plugins } }` shows its storage shape (see B6) — strongly suggests input is `(plugin_id: ID!, input: Map!)` by convention, ASSUMED not introspected field-by-field.

---

## B. Real data on this library

### B1. Portrait scene counts by duration
CONFIRMED, live `findScenes(filter:{per_page:0}, scene_filter:{orientation:{value:[PORTRAIT]}, duration:{value:X, modifier:LESS_THAN}})`:
| under (s) | count |
|---|---|
| 60  | 44 |
| 120 | 74 |
| 180 | 93 |
| 300 | 123 |
| 600 | 170 |

Total scene count in library: 18,238 (CONFIRMED, `findScenes(filter:{per_page:0})`).

### B2. Codec/container breakdown (under-300s portrait set, n=123)
CONFIRMED, computed from live query pulling `files{width height video_codec audio_codec format}` for all 123 scenes:
- `h264 / aac / mp4`: 86
- `hevc / aac / mp4`: 35
- `h264 / "" (no audio track) / mp4`: 2
- **37 of 123 (30%) are NOT h264+aac+mp4** — the 35 HEVC scenes are the main risk (HEVC/H.265 has patchy browser `<video>` support outside Safari/iOS; Chrome/Firefox on Android generally cannot play HEVC without transcoding).

### B3. Rotation sanity check
CONFIRMED there is no rotation field available — see A4. Cannot determine from GraphQL whether any scene has embedded rotation metadata that would make a width>height file display as portrait or vice versa. Spot-checked 5 sample portrait (height>width) files' width/height (see B7) and all had height > width consistent with the `orientation: PORTRAIT` filter, so for this library's sampled data the filter result and raw dimensions agree — but this is only a 5-scene spot check, not an exhaustive statement about hidden rotation flags elsewhere in the library. **This item could not be fully determined from available fields; state explicitly as unresolved/ASSUMED-safe-for-now.**

### B4. Missing-metadata distribution (under-300s portrait set, n=123)
CONFIRMED, computed from the same live pull:
- No studio at all: 87 / 123
- Has a studio but studio has no `image_path`: 0 / 123 (every studio present has an image)
- No performers: 8 / 123
- Zero tags: 6 / 123
- Tag-count distribution: median 6, max 8 (computed over all 123 scenes' `tags` array lengths)

### B5. "Reels" tag + zzz-prefixed tags
CONFIRMED. A tag literally named `Reels` **already exists**: `{id: "6462", name: "Reels"}` (via `findTags(tag_filter:{name:{value:"Reel", modifier: INCLUDES}})`). Any new tag naming scheme must account for this existing tag (reuse it, or pick a different name to avoid confusion/collision).
`zzz`-prefixed tags found: `{"405","Zzz temp"}`, `{"3061","zzz-upload"}`, `{"1910","zzz-virtual"}`.

### B6. `configuration.plugins` shape (TagChips)
CONFIRMED, live `{ configuration { plugins } }`. The `TagChips` key stores:
```json
"TagChips": {
  "categories": [
    {
      "defaultCollapsed": true,
      "id": "cat_mrql33m0tykzom",
      "label": "Femdom",
      "tagIds": ["48","16","117", ...]
    },
    { "defaultCollapsed": false, "id": "cat_...", "label": "Performer", "tagIds": [...] },
    ...
  ]
}
```
i.e. a top-level object keyed by plugin id, value is an arbitrary JSON blob (array of category objects with `id`/`label`/`defaultCollapsed`/`tagIds[]`). A future Reels feed could store its own settings (e.g. last-seen scene ids, dismissed candidate ids, per-device cursor) the same way under a `"Reels"` (or whatever plugin id is chosen) key via `configurePlugin`, read back via `{ configuration { plugins } }`.

### B7. Sample pixel dimensions (5 portrait scenes under 300s)
CONFIRMED via GraphQL `VideoFile.width/height` fields (not by downloading/measuring the screenshot image — faster and authoritative since it's the same ffprobe-derived metadata Stash uses for the orientation filter):
| scene id | width | height |
|---|---|---|
| 10643 | 720 | 1280 |
| 11227 | 720 | 1280 |
| 11229 | 1080 | 1920 |
| 11231 | 1080 | 1920 |
| 11233 | 1080 | 1920 |

---

## C. Frontend integration

### C1. `PluginApi.register.route`
CONFIRMED present in source: `stash-source/ui/v2.5/src/pluginApi.tsx:87` (`register: { route: registerRoute, component: RegisterComponent }`). Implementation at `pluginApi.tsx:54-65`:
```js
function registerRoute(path, component) {
  before("PluginRoutes", (props) => {
    return [{ children: (<>{props.children}<ReactRouterDOM.Route path={path} component={component} /></>) }];
  });
}
```
It patches a `PluginRoutes` component that renders the route **inside** the existing route tree via `before`, i.e. the registered route is mounted inside Stash's normal app shell/layout — **navbar remains visible**, it is not a standalone/full-page render. Confirmed in use by real CommunityScripts plugins: `CommunityScripts/plugins/AIOverhaul/AIButtonIntegration.js:46,79`, `CommunityScripts/plugins/DupFileManager/DupFileManager.js:596-635`, `CommunityScripts/plugins/FileMonitor/filemonitor.js:167-169` — all call `PluginApi.register.route("/path", Component)` and those pages render with Stash's navbar.

Implication for Reels: a true full-screen immersive feed (no navbar) cannot be achieved via `register.route` alone — it will render inside the normal layout unless the plugin additionally uses CSS (`position: fixed; inset: 0; z-index: high`) to visually cover the navbar, same technique other overlay-style Stash plugins use. PLUGIN-DEV-GUIDE.md's own guidance (§10, read earlier) also explicitly warns `register.route` does NOT work for simple button injection — consistent with it being a route/page mechanism, not a DOM-injection one.

### C2. Navbar patch points
CONFIRMED via grep of `MainNavbar.tsx`: imports `PatchComponent` from `src/patch` (`MainNavbar.tsx:42`), and wraps two exported pieces with it:
- `MainNavbar.tsx:168` — `const MainNavbarMenuItems = PatchComponent("MainNavbar.MenuItems", ...)` (named patch point `MainNavbar.MenuItems`)
- `MainNavbar.tsx:175` — `const MainNavbarUtilityItems = PatchComponent("MainNavbar.UtilityItems", ...)` (named patch point `MainNavbar.UtilityItems`)
(Exact patch-point name strings weren't re-printed in this pass's grep output, but the call sites are confirmed at those two line numbers — re-open `MainNavbar.tsx:160-180` to read the literal string argument before writing code against it.)

### C3. Stash TV's nav injection technique
CONFIRMED by fetching and grepping the live served bundle `http://192.168.4.100:6969/plugin/stash-tv/javascript` (saved locally, 3195 lines minified). Found:
- `patch.before("CheckboxGroup", function(...` — uses `PluginApi.patch.before` elsewhere for an unrelated settings UI tweak.
- For its nav link, it does **not** use `PluginApi.register`/`patch` on `MainNavbar`. Instead it builds a raw DOM anchor: a literal string match in the bundle shows `createElement("a",{href:hs,className:"minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between ... nav-link", ...})` combined with `.appendChild`/`insertBefore` calls — i.e. **classic DOM-injection into the rendered navbar**, matching this repo's own established DOM-injection convention (PLUGIN-DEV-GUIDE.md §10) rather than the React-patch convention (§2-4). This is useful precedent: Stash TV, the most directly comparable existing plugin, chose DOM injection for its nav entry rather than `PatchComponent("MainNavbar.MenuItems", ...)`.

### C4. Global hotkeys
CONFIRMED via grep: Mousetrap is bound in `stash-source/ui/v2.5/src/hooks/keybinds.ts` — `Mousetrap.bind(key, ...)` calls at lines 23, 34, 39, 67 for rating-shortcut digits, a backtick (`` ` ``) handler, numeric keys 0-9(ish) for ratings, and `"r"` (random/reroll). Mousetrap binds to `document` globally by default, so these bindings **will still fire underneath a full-screen fixed-position overlay div** — a plugin overlay does not suppress global keydown listeners unless it explicitly calls `Mousetrap.unbind(...)` / `stopCallback` or `event.stopPropagation()` on its own key handlers while focused.
Keys a Reels overlay should avoid conflicting with / should actively suppress while active: digits `0-9` (rating shortcuts), `` ` `` (reset rating), `r` (random). ASSUMED (not exhaustively grepped beyond `keybinds.ts`) there may be additional Mousetrap bindings elsewhere (e.g. scene player seek/play-pause keys like space/arrows) — worth a follow-up grep of `ScenePlayer` components before finalizing the key list, since a video-feed plugin will almost certainly want space/arrow keys for its own play-pause/navigate and must confirm nothing else is listening to them during normal browsing.

### C5. Scene stream endpoint / Range / auth
CONFIRMED by reading `internal/api/routes_scene.go:55-90` (route table) and `:93-100` (`StreamDirect` handler) plus `internal/manager/running_streams.go:42-60` (`StreamSceneDirect`):
- Route: `GET /scene/{sceneId}/stream` → `rs.StreamDirect` → `manager.SceneServer.StreamSceneDirect`.
- Direct-stream vs transcode: `StreamDirect`/`/stream` always does a **direct** passthrough (`http.ServeFile`) of the original file — no decision logic in this path; the separate endpoints `/stream.mp4`, `/stream.webm`, `/stream.mkv`, `/stream.m3u8`, `/stream.mpd` (routes_scene.go:63-70) are the explicit transcode variants (`streamTranscode`, requires `StreamManager` to be enabled). So a plain `<video src=".../scene/{id}/stream">` always gets the original file byte-for-byte, with no transcoding decision made server-side for that specific path.
- Range support: CONFIRMED — `http.ServeFile` (Go stdlib) natively implements HTTP Range handling. Live-tested on 3 real scene IDs (11229, 11231, 11233) with `Range: bytes=0-1023`: all three returned `HTTP/1.1 206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range: bytes 0-1023/<total>`, `Content-Type: video/mp4`.
- Auth: no auth headers/cookies were sent in the curl tests above and all three succeeded with 206 — CONFIRMED a plain `<video src="http://host:6969/scene/{id}/stream">` works with no token/cookie needed on this instance (matches the no-auth GraphQL behavior noted in the task brief). ASSUMED this would differ if the instance had a password/API-key configured (not tested, since this instance has none).

---

## D. Playback risk research

### D1. Range-request test on 3 real candidate scenes
CONFIRMED (same data as C5, repeated here per the question's own numbering):
| scene id | status | Content-Type | Accept-Ranges | Content-Range |
|---|---|---|---|---|
| 11229 | 206 Partial Content | video/mp4 | bytes | bytes 0-1023/129573714 |
| 11231 | 206 Partial Content | video/mp4 | bytes | bytes 0-1023/41518792 |
| 11233 | 206 Partial Content | video/mp4 | bytes | bytes 0-1023/22875149 |

### D2. Muted autoplay / playsinline / plain-HTTP constraints
ASSUMED (web knowledge, not instance-verified — no phone available to test):
- iOS Safari: autoplay requires the `<video>` to be `muted` AND have the `playsinline` attribute (`webkit-playsinline` legacy also helps); without `playsinline` it force-fullscreens; without `muted` it blocks autoplay entirely. User-gesture-free autoplay of muted video is allowed.
- Android Chrome: muted autoplay is allowed by the Autoplay Policy (effectively always, media engagement index aside); `playsinline` matters less than on iOS but is still good practice.
- Firefox Android: generally also permits muted autoplay; policy has historically been looser than Chrome's.
- **Secure context requirements**: autoplay policies themselves are not secure-context-gated. However:
  - `IntersectionObserver` does **not** require a secure context — it works over plain HTTP.
  - `fetch()` to `/graphql` over plain HTTP LAN is fine as long as the page itself was loaded over HTTP (mixed-content rules only block HTTP fetches from an HTTPS page, not the reverse) — not an issue here since Stash itself is served over plain HTTP.
  - CSS `scroll-snap` has no secure-context requirement; it's a pure CSS feature.
  - APIs that DO require a secure context and would be unavailable here: Service Workers, most of the Web App Manifest "installability" features, Clipboard write API on some browsers, Geolocation on some browsers, `navigator.mediaDevices.getUserMedia`. None of these are core to the Reels feed design described, so plain HTTP on the LAN should not block autoplay, IntersectionObserver, GraphQL fetch, or scroll-snap.
- Not independently verified against a real phone in this session — flagged as ASSUMED per the task's own instruction that this sub-section may remain web-knowledge-labeled.

---

## Implications for the plugin design

- **Blocker risk — HEVC codec**: 35/123 (28%) of under-300s portrait candidates are `hevc` video. HEVC in `<video>` has unreliable support on Chrome/Firefox for Android; the feed should either filter these out of the default candidate pool, flag them visually as "may not play on this device," or fall back to a transcoded stream URL (`/stream.mp4`) for non-h264 files — but note the transcode endpoints require Stash's `StreamManager` to be enabled server-side (not verified as enabled/disabled on this instance).
- **No rotation field exists on `VideoFile`** (A4/B3) — orientation filtering must rely entirely on Stash's own `orientation: PORTRAIT` filter server-side; the plugin cannot independently sanity-check or override rotation.
- **Orientation filter exists and works** (`OrientationEnum: LANDSCAPE/PORTRAIT/SQUARE`) — no need to compute width>height client-side, a real `SceneFilterType.orientation` filter is available.
- **`per_page:-1` works for `findScenes`**, and **seeded `sort:"random_<seed>"` is confirmed stable/non-overlapping across pages** — both are safe building blocks for a shuffled infinite-scroll feed with cursor-free pagination.
- **`BulkUpdateIdMode` (`SET/ADD/REMOVE`) exists** — thumbs-down/double-tap tag adjustments can use `ADD`/`REMOVE` modes on `bulkSceneUpdate.tag_ids` without re-fetching/re-sending the full tag list first, reducing race conditions.
- **A tag named `Reels` already exists** (id 6462) — the plugin should reuse this tag rather than creating a duplicate/conflicting one; naming any companion "candidate/review" tags should avoid the existing `zzz-upload`/`zzz-virtual`/`Zzz temp` tags.
- **`register.route` renders inside the normal Stash layout (navbar visible)** — a true immersive full-screen feed needs a fixed-position overlay (CSS) layered on top, consistent with this repo's existing dark-theme/hardcoded-CSS convention; it is not a standalone page by default.
- **Stash TV (the closest existing precedent) injects its nav link via raw DOM manipulation, not via `PatchComponent("MainNavbar.MenuItems"/"...UtilityItems")`** — suggests DOM injection is the path of least resistance/most proven for this exact use case, matching this repo's own established convention (PLUGIN-DEV-GUIDE.md §10) rather than the newer React-patch approach.
- **Global Mousetrap hotkeys (digits 0-9, backtick, "r") are bound to `document` and will leak through any fixed-overlay div** — the Reels overlay must actively intercept/stop-propagate keys it wants for itself (likely space/arrows for play-pause/navigate) and should avoid/rebind around rating-digit and "r" collisions, or explicitly `Mousetrap.unbind` the global ones while the overlay is active (and rebind on exit).
- **Scene stream endpoint (`/scene/{id}/stream`) supports Range requests out of the box (Go `http.ServeFile`), requires no auth on this instance, and performs no server-side transcode decision** — plain `<video src>` tags will work directly, confirmed live for 3 real scene IDs. No token-in-URL workaround needed on this instance.
- **Missing-metadata is common among candidates**: 87/123 (71%) of portrait-under-300s scenes have no studio at all, 8 have no performers, 6 have zero tags — the overlay UI and the "candidate review" screen must gracefully handle scenes with little/no metadata (no studio badge, no performer chips) as the common case, not the edge case.
- **Playsinline/muted/autoplay and plain-HTTP constraints are standard and not expected to block the design** (ASSUMED/web-knowledge) — but this was not verified on an actual phone in this session; recommend a manual phone test early once the first prototype exists, specifically for iOS Safari's `playsinline` requirement.
