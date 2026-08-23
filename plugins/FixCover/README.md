# FixCover — Stash plugin

Adds **"Set Cover to First Frame"** to a scene page's ⋮ operations menu, and
**"Set Cover to First Frame (Bulk)"** to the scene list's multi-select actions
menu. Both regenerate the scene's cover from time 0, replacing Stash's
default auto-generated cover (picked from roughly 20% into the video) with
the actual first frame.

## Status: verified live against 192.168.4.100:6969

Every open question from the original scaffold was checked against the real
running instance this session — schema introspection, both menu injections,
and end-to-end mutation calls with server-side confirmation. See "Live
verification log" below for the full trail. Not yet done: installing the
packaged plugin files themselves via Settings → Plugins (everything so far
was verified by injecting equivalent code directly into the page console —
see "What's left" at the bottom).

## Design decisions (confirmed correct against the live schema)

- **Mutation discovery is runtime, not hardcoded.** `FixCover.js` introspects
  `__schema.mutationType.fields` on first use, looks for a field name
  matching `/screenshot|cover/i`, and reads its actual arg names and return
  type off the schema (`discoverScreenshotMutation()`). Confirmed live: the
  real mutation is exactly `sceneGenerateScreenshot(id: ID!, at: Float):
  String!`.
- **The `at` argument is always called with `0`.** First frame is `0`
  whether the arg is seconds or a fraction — confirmed unnecessary to
  disambiguate further.
- **Sync vs. async detection, and what we learned it got wrong initially:**
  the original heuristic assumed a non-`Boolean` return type meant "async,
  poll `findJob`". Live testing showed `sceneGenerateScreenshot` returns
  `String!` (the literal value `"todo"`, not a job id) but is actually
  **synchronous** — `jobQueue` stays empty and the scene's screenshot URL
  timestamp changes immediately. `waitForJob()` was fixed to check `findJob`
  immediately (no upfront sleep) and only fall into the polling loop if a
  real job is actually found — otherwise it returns right away instead of
  forcing a wasted ~1s wait per scene, which would have added up fast across
  a bulk run.
- **`sceneGenerateScreenshot` does not validate the scene id.** Calling it
  with a nonexistent id (tested with `999999999`) still returns `"todo"`
  successfully — no GraphQL error. This means the bulk action's per-scene
  `try`/`catch` and end-of-batch failure summary are real, exercised code
  paths, but in practice they'll only trigger on a genuine network/GraphQL
  transport failure, not a bad scene id — Stash itself won't complain about
  one. Worth knowing if a "0 failures" bulk run over a mix of good/bad ids
  looks surprising later.
- **Bulk runs sequentially, not in parallel.** One scene's failure is
  recorded, not thrown, and the loop continues.
- **Menu injection uses a persistent (non-time-boxed) `MutationObserver`**,
  since Stash's Dropdown menus (react-bootstrap) only mount to the DOM the
  first time a user opens them.
- **No config store, no persisted settings, no Python backend.**

## Live verification log

Everything below was checked directly against `192.168.4.100:6969` this
session (via `curl` against `/graphql` and via injecting equivalent JS into
the live page through browser automation — not by installing the packaged
plugin files yet).

1. **Schema introspection** — confirmed the real mutation:
   ```graphql
   { __schema { mutationType { fields { name args { name } type { name } } } } }
   ```
   → `sceneGenerateScreenshot(id: ID!, at: Float): String!`. No `Boolean`
   return, contrary to the original guess.

2. **Single-scene call** — `mutation { sceneGenerateScreenshot(id: "38", at:
   0) }` via `curl` returned `{"sceneGenerateScreenshot":"todo"}`. `{
   jobQueue { id status } }` was empty both before and after. A follow-up
   `findScenes` query showed the scene's `paths.screenshot` URL's cache-bust
   timestamp had changed — confirming the regeneration is synchronous and
   actually happened.

3. **Scene page ⋮ menu, live DOM** — opened scene `38`'s Operations menu and
   inspected it directly:
   - Menu: `.dropdown-menu.show`, class `"bg-secondary text-white
     dropdown-menu show"`.
   - Toggle: sibling `<button class="dropdown-toggle btn btn-secondary"
     title="Operations">` containing an inline `<svg class="... 
     fa-ellipsis-vertical ...">`.
   - Items: 7 `<a class="dropdown-item" role="button">` elements, no
     `.dropdown-divider` — Rescan / Generate… / Generate thumbnail from
     current / Generate default thumbnail / Submit to Stash-Box / Merge... /
     Delete, in that order.
   - `FixCover.js`'s actual selectors (`findOpenSceneOperationsMenu`,
     `insertMenuItem`) were exercised as real page-injected code: opening
     the menu showed **"Set Cover to First Frame"** correctly inserted right
     before **Delete**. Clicking it (via both a real click dispatch and a
     scripted `.click()`) fired the handler, showed the "Setting cover…" →
     "Cover updated" toast sequence, and a follow-up `curl` confirmed the
     scene's screenshot timestamp changed again.

4. **Scene list bulk menu, live DOM** — selected 2–3 scene cards and opened
   the list toolbar's "..." menu:
   - This menu carries a stable, distinct class:
     `.scene-list-operations-dropdown` (in addition to `.dropdown-menu
     show`) — no heuristics needed, unlike the scene-page menu.
   - It's the list's general operations menu (Play / Select All / Select
     None / Invert Selection / Play Random / Generate… / Identify… /
     Merge… / Export / Export all…), not something that only exists once
     scenes are selected — it's always present in the toolbar.
   - Selected-scene checkboxes are `<input class="card-check">` inside a
     `.scene-card` container; the scene id is not in a data attribute — it's
     parsed from that card's `<a href="/scenes/<id>...">`.
   - `FixCover.js`'s actual selectors (`findOpenBulkOperationsMenu`,
     `getSelectedSceneIds`) were exercised as real page-injected code:
     **"Set Cover to First Frame (Bulk)"** appeared correctly right before
     **Export**. Selected 3 scenes (`18982`, `18799`, `18983`), clicked it,
     got a "Done — Set cover to first frame on 3 scene(s)." toast, and a
     follow-up `findScenes` query confirmed all three (and only those
     three) scenes' screenshot timestamps changed.

5. **Failure path** — confirmed via `curl` that `sceneGenerateScreenshot`
   doesn't error on a bogus scene id (see "Design decisions" above). The
   `try`/`catch`-per-scene and failure-summary code itself is straightforward
   and was not separately forced to fail, since there's no live way to make
   this particular mutation actually error short of a transport-level
   failure.

## What's left

- **Install the packaged plugin** (`FixCover.yml` + `.js` + `.css`) into the
  dev instance via the usual Settings → Plugins flow and re-confirm both
  menu items appear/work from the real installed plugin rather than a
  console-injected equivalent — the logic is identical, but this hasn't
  been done yet.
- **Menu-injection timing**: confirm the persistent `MutationObserver` picks
  up both menus after a fresh full page load (not just after injecting the
  script mid-session, as was done here) and after SPA navigation between
  scenes.
- Everything else from the original verification checklist is done — see
  "Live verification log" above.

## Local dev setup

This plugin uses **Model B (GitHub Pages install/update)** — see
[`PLUGIN-DEV-GUIDE.md` §15](../../PLUGIN-DEV-GUIDE.md#model-b-github-pages-installupdate)
for the full canonical instructions. In short: push to `main`, then click
**Update** on this plugin in Stash's **Settings → Plugins → Available
Plugins** (pushing alone does not update a running instance). Confirm via
`{ plugins { id version } }` that the commit-hash suffix matches your new
`HEAD` before trusting a "live" test.

## Files

```
FixCover.yml   — manifest (JS+CSS only, no Python exec)
FixCover.js    — gql helper, mutation discovery, findJob polling, toasts,
                 menu-injection observers
FixCover.css   — hardcoded dark-theme tokens for the toast stack (Stash
                 CSS vars unreliable outside the main React tree)
```
