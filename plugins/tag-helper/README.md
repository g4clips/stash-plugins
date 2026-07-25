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
  - `groups`: `[{ id, label, memberTagIds, performerId, performerLabel,
    studioId, studioLabel }]`. `performerId`/`studioId` (and their cached
    `*Label`, so the Groups list and confirmation prompt don't need an
    extra fetch) are optional — groups saved before this field existed
    simply have them `undefined`/`null`, which every read site already
    treats as "no performer/studio on this group". Clicking a group chip:
    - adds all its member tags to the scene (add only, never removes —
      unchanged from before),
    - adds its performer to the scene's performers, if set (add only,
      same non-destructive rule as tags),
    - **sets** the scene's studio to the group's studio, if set — studio
      is a single-value field on Scene, so this necessarily *replaces*
      any existing studio. If the scene already has a different studio,
      the user is asked to confirm before the mutation fires.
  - `categories`: `[{ id, label, tagIds }]`. Array order = display order.
    A tag belongs to at most one category; "Uncategorized" is not stored,
    it's computed at render time as whatever isn't claimed by any category.
  - `sortMode`: `"usage"` (default) or `"alpha"`. Controls the sort of tags
    *within* each section of the scene-tab grid (categories keep their own
    stored order regardless of sortMode). `"usage"` — sort by `scene_count`
    descending — matches this plugin's original, undeclared default, so
    unset/legacy config keeps behaving exactly as before.
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
3. ~~**Chip grid sort order.**~~ Resolved: the scene-tab grid was actually
   already sorting by `scene_count` descending within each section (not
   alphabetical, despite the GraphQL fetch using `sort: name` — that only
   sets the order handed to `buildCategorizedSections`, which immediately
   re-sorts). A `SortToggle` now lets the user pick "Most used" (the prior
   default, kept as default) vs. "A–Z", persisted per-user as `sortMode` in
   plugin config.
4. **Should group-apply also let you *remove* the group's tags in one click**
   (toggle behavior), or should removal always be per-chip? Left as add-only
   for now since that's the safer default. (Performer/studio groups follow
   the same add-only rule for tags/performer; studio is necessarily
   replace-only since it's a single-value field — see below.)

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
- [ ] `sortMode` toggle — confirm "Most used"/"A–Z" persists across a page
      reload and matches prior (undeclared) default behavior.
- [ ] `findPerformers(filter: { q, per_page })` / `findStudios(filter: { q,
      per_page })` field names — copied from `Data18StashDB.js` /
      `SuperScrape.py` in this repo (both already verified live elsewhere),
      but not yet exercised from *this* plugin against a live instance.
- [ ] Performer/studio group create/edit/apply — end-to-end: pick a
      performer and/or studio in the group editor, save, then apply the
      group chip on a scene and confirm `performer_ids`/`studio_id` land
      correctly, including the replace-studio confirmation prompt when the
      scene already has a different studio.

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
