# TagChips — Stash plugin

Click-to-toggle tag chips + preset "groups" of tags, in a new **Tags** tab on
the Scene page — so you can watch/scrub the scene and tag it at the same time.

## Status: scaffolded, untested

This was scaffolded outside a live Stash instance. Treat `TagChips.js` as a
solid first draft that follows the patterns proven in our other plugins
(Data18StashDB, FindDuplicates, marker-scenes, seek-controls) but has **not
yet been run against real Stash**. Next Claude Code session should install it
into a dev instance and iterate from real errors, not just review the diff.

## Design decisions (already made, don't re-litigate without reason)

- **Placement:** new tab on the Scene page via `PluginApi.patch.after`
  (`ScenePage.Tabs` + `ScenePage.TabContent`), *not* a floating modal —
  the user wants to keep interacting with the video player while tagging,
  and a modal would sit on top of / block it. (The "Manage Tags" editor
  *is* a modal, since it's an occasional CRUD operation, not the primary
  tagging flow.)
- **Apply mode:** real-time. Each chip click fires a `sceneUpdate` mutation
  immediately (optimistic UI, revert + red flash on failure). No queue/apply
  step.
- **Groups and categories are stored in Stash's plugin config store**, at
  `configuration.plugins.TagChips`, via the `configurePlugin(plugin_id,
  input: Map!)` mutation. Confirmed empirically (twice, against a live
  v0.31.1 instance) that this store accepts arbitrary undeclared JSON keys,
  round-trips nested structures losslessly, and survives `reloadPlugins`.
  The one gotcha: `configurePlugin` *replaces* the whole per-plugin config
  rather than merging, so all reads/writes go through the `readConfig()` /
  `writeConfig(patch)` helpers in TagChips.js, which do a read-modify-write.
  No other code should call `configurePlugin` directly.
  - `groups`: `[{ id, label, memberTagIds }]`. Clicking a group chip adds
    all its member tags to the scene (adds only — never removes tags on
    group-apply, to keep it non-destructive).
  - `categories`: `[{ id, label, tagIds }]`. Array order = display order.
    A tag belongs to at most one category; "Uncategorized" is not stored,
    it's computed at render time as whatever isn't claimed by any category.
  - Earlier versions stored groups as fake tags named `zzz-group:<name>`.
    That scheme is retired — no migration was done, so any such tags left
    over in a library are now just ordinary (harmless) tags.
- **No Python backend needed.** All operations are local GraphQL mutations
  reachable directly from the browser plugin — same-origin, no CORS issue.

## Open questions / things to decide together next session

1. **Tag universe size.** `fetchAllTags()` currently does one
   `findTags(filter: { per_page: -1 })` call. If the library has hundreds+
   of tags this grid could get unwieldy — may want:
   - a "favorites"/"recently used" section pinned at top, or
   - restricting the main grid to tags with a certain parent/category,
   - and/or making the search filter more prominent (currently below groups).
2. **Group edit UX.** Right now the "edit" link sits next to each group chip
   at all times. Consider hiding management behind a single "Manage groups"
   toggle to keep the primary grid cleaner.
3. **Chip grid sort order.** Currently alphabetical from GraphQL `sort: name`.
   Might want usage-frequency sort instead (would need a `scene_count` field
   on Tag — check schema).
4. **Should group-apply also let you *remove* the group's tags in one click**
   (toggle behavior), or should removal always be per-chip? Left as add-only
   for now since that's the safer default.

## Verification checklist for next session

- [x] `ScenePage.Tabs` / `ScenePage.TabContent` patch points confirmed
      correct against v0.31.1 (matches `marker-scenes.js`'s already-working
      usage of the same pattern).
- [x] `findTags(filter: { per_page: -1 })` confirmed valid — `PerPageAll`
      sentinel in stash's Go source, verified live against v0.31.1.
- [x] `SceneUpdateInput.tag_ids` confirmed **replace** (not merge) both in
      source (`RelationshipUpdateModeSet`) and empirically via a live
      toggle/apply-group/toggle-off sequence on a real scene.
- [x] Group create/update/destroy mutations verified end-to-end against a
      live instance, including a malformed-description group tag (round-
      trips as a plain string, ready to exercise the catch fallback).
- [ ] Test with 0 groups, 0 tags (empty states already coded, but unverified
      — needs a visual pass, see below).
- [ ] Visual pass — chip grid density/wrapping, tab renders, empty states.
      **Not yet done** — no browser-automation tool was available this
      session. Plugin is live at C:\Users\<you>\.stash\plugins\tag-helper
      on the local dev instance (127.0.0.1:9999); open any scene and check
      the "Tag Chips" tab manually.

## Local dev setup

This plugin uses **Model B (GitHub Pages install/update)** — see
[`PLUGIN-DEV-GUIDE.md` §15](../../PLUGIN-DEV-GUIDE.md#model-b-github-pages-installupdate)
for the full canonical instructions. In short: push to `main`, then click
**Update** on this plugin in Stash's **Settings → Plugins → Available
Plugins** (pushing alone does not update a running instance). Confirm via
`{ plugins { id version } }` that the commit-hash suffix matches your new
`HEAD` before trusting a "live" test.

Add this plugin's folder to the `stash-plugins` repo under `plugins/TagChips/`
alongside the existing plugins, with its own `config.ini.example` /
`.gitignore` if credentials are ever needed (not currently — no external
scraping, no API keys).

## Files

```
TagChips.yml   — manifest (JS+CSS only, no Python exec)
TagChips.js    — all logic: GraphQL helpers, Chip/GroupEditor/TagChipsPanel
                 components, PluginApi.patch.after wiring
TagChips.css   — hardcoded dark-theme tokens (Stash CSS vars unreliable
                 outside the main React tree per project notes §13)
```
