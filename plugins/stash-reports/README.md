# stash-reports — Stash plugin

Library-wide reports on top of what Stash's built-in stats already show,
starting with codec breakdowns: a video/audio codec summary for the whole
library, drill-down to the scenes behind any codec (pair, video-only,
audio-only, or container format), and a one-click "not Firefox-optimal"
report — anything that isn't h264 video + aac audio, which is the combo
that direct-plays cleanest in Firefox.

## Status: scaffolded, untested against a live Stash instance

Like TagChips before it, this was built without a live Stash instance to
run against. The code follows every pattern this project has already
proven out (GraphQL-from-browser, hardcoded dark-theme tokens, the
Settings→Tools DOM-injection recipe) and was exercised with a jsdom smoke
test (`smoke-test.js`, not shipped as part of the plugin — dev-only) that
mocks `/graphql` and drives the actual modal: open → overview renders with
correct aggregate counts → click a codec-pair row → drill-down list shows
the right scenes → back → non-optimal quick report → select-all → bulk tag
→ sort → CSV export → Settings/Tools injection. That covers the UI logic;
it does **not** cover whether the GraphQL field names below match your
Stash version. Next session should install this into a dev instance and
fix from real errors, not just review the diff.

## What it does

- **Settings → Tools entry** opens a full-screen report panel, using the
  same anchor-clone pattern as FindDuplicates/marker-scenes.
- **Overview screen:** total scenes/size/duration, an optimal-vs-not
  compatibility bar (target codec pair configurable — see below), and
  breakdown tables by video+audio codec pair, video codec alone, audio
  codec alone, and container format. Each row is a link into a scene list.
- **Non-optimal quick report:** one button from the overview jumps
  straight to every scene that isn't the target pair (fileless/virtual
  scenes are excluded from this list and from the bulk-tag action below —
  there's nothing to transcode on a marker-scenes virtual scene).
- **Drill-down scene list:** sortable table (title, studio, date,
  resolution, codecs, container, duration, size) with thumbnails and
  direct links to each scene.
- **Bulk action:** select scenes in a drill-down list, tag them all with
  `zzz-needs-transcode` (find-or-create, merges into existing tags — never
  replaces) so you can batch-process them outside Stash later.
- **CSV export** on both the overview breakdown and any drill-down list.

## Design decisions (already made, don't re-litigate without reason)

- **Data model:** one `findScenes` pass, paginated at 500/page, fetching
  every scene's `files[0]` (id, size, duration, format, video_codec,
  audio_codec, width, height) plus title/date/studio/tags/screenshot path.
  Everything — aggregation and every drill-down — is computed client-side
  from that one in-memory array, cached for the life of the modal (use the
  ⟳ Refresh button to re-scan after adding new files). This trades some
  up-front load time for simplicity: no server-side codec filter is
  assumed to exist in `SceneFilterType`, so nothing depends on one.
- **"Primary file" assumption:** a scene can have more than one file (e.g.
  original + proxy). Reports use `files[0]` as *the* file, matching what
  Stash's own scene-card codec badge does. Worth a comment if your library
  makes heavy use of multiple files per scene — the report will be blind
  to anything past the first file.
- **Optimal codec pair is configurable**, not hardcoded: `stash-reports.yml`
  declares `targetVideoCodec` / `targetAudioCodec` STRING settings
  (Settings → Plugins → Stash Reports), read via
  `configuration.plugins["stash-reports"]` — same config-store mechanism
  documented in dev-notes-2026-07-19 #1. Defaults to `h264`/`aac` if unset.
- **Entry point is Settings → Tools only, not a `/stats`-page button.** A
  `/stats` injection was investigated and rejected: `Stats.tsx` (confirmed
  against a shallow clone of stashapp/stash) has no
  `PatchComponent`/`PatchContainerComponent` hook, and the only DOM anchors
  on that page are fragile/ambiguous — three `.stats` divs (one per stat
  group, not unique) and `div.mt-5` (unique but untested as an anchor). The
  Settings→Tools anchor-clone pattern (`a[href="/sceneDuplicateChecker"]`,
  `a[href="/sceneFilenameParser"]`) is already proven elsewhere in this
  repo, so that's the only entry point.
- **Plain-DOM modal, not `patch.after`.** This plugin does async data
  loading (paginated GraphQL) as its core function, so per
  dev-notes-2026-07-26 §5 ("if your plugin calls an async function before
  registering patches, use DOM injection") this follows the
  Data18StashDB/EasyTag skeleton rather than a React tab.
- **Bulk-tag, not bulk-transcode.** This plugin doesn't touch files or
  trigger Stash's own transcode/generate pipeline — it only tags scenes so
  you can drive whatever transcode workflow you already use outside Stash.
  Keeps the plugin read-mostly and low-risk.

## Verification checklist for next session (live instance required)

- [ ] Confirm `VideoFile` field names — `size`, `duration`, `format`,
      `video_codec`, `audio_codec`, `width`, `height` — via
      `{ __type(name: "VideoFile") { fields { name } } }`. These are
      written from training-data recall of the Stash schema, not
      introspected against a real instance.
- [ ] Confirm `findScenes(filter: FindFilterType)` accepts
      `{ page, per_page, sort, direction }` and that `sort: "id"` is a
      valid sort key (may need `sort: "path"` or similar on some
      versions).
- [ ] Confirm `configuration { plugins }` actually reflects
      `settings:`-block STRING values entered in Settings → Plugins →
      Stash Reports (i.e. that the YAML `settings:` mechanism and
      `configuration.plugins.<id>` read path agree — dev-notes-2026-07-19
      says they do, but that was confirmed for `configurePlugin`
      specifically, not the `settings:` UI path).
- [ ] Test with a real library size — the safety-capped pagination loop
      (400 pages × 500/page = 200k scenes) should never trip for a normal
      library, but confirm load time is tolerable for your actual scene
      count. No loading-time optimization (e.g. requesting fewer fields
      for the aggregation pass) has been attempted yet.
- [ ] Confirm the `a[href="/sceneDuplicateChecker"]` and
      `a[href="/sceneFilenameParser"]` anchor selectors are still valid on
      the live Tools page for the current Stash version — this plugin's
      only entry point depends on them.
- [ ] Test with 0 scenes, and with a library that has zero fileless scenes
      (make sure the "excluded from the count below" copy doesn't show up
      when `filelessCount === 0` — it's gated correctly in code, just
      wasn't visually checked).
- [ ] Confirm scene `id` values round-trip correctly through
      `state.selected` (a `Set` of raw `id` strings) — should be fine since
      GraphQL `ID` serializes as a string, but worth a real click-through.
- [ ] Visual pass — table horizontal scroll at narrow viewport widths,
      thumbnail loading with `loading="lazy"` on a long list.

## Files

```
stash-reports.yml   — manifest (JS+CSS only, no Python backend — everything
                       is same-origin GraphQL from the browser, no CORS issue)
stash-reports.js    — all logic: GraphQL helpers, pagination/aggregation,
                       modal skeleton, overview + drill-down rendering,
                       CSV export, bulk tagging, launcher injection
stash-reports.css   — hardcoded dark-theme tokens (Stash CSS vars don't
                       resolve outside the React tree, per project notes §13)
```

## Local dev setup

Same as the other plugins in this repo:

```powershell
New-Item -ItemType Junction `
    -Path C:\Users\admin\.stash\plugins\stash-reports `
    -Target C:\Users\admin\Documents\stash-plugins\plugins\stash-reports
```

Then in Stash: Settings → Plugins → reload plugins (or restart) to pick it up.
