# Reels — build specification
**Date:** 2026-10-06
**Status:** specified, not built. Based on the design conversation and
`REELS-INVESTIGATION.md` (live Stash v0.31.1 at `192.168.4.100:6969`).

An Instagram-Reels-style feed inside Stash: a full-screen vertical swipe feed
of short portrait scenes, usable on a phone and on a desktop.

Labels used below: **CONFIRMED** = verified in the investigation.
**UNTESTED** = written here, must be checked live before relying on it.

---

## 1. Decisions already made (don't re-litigate without reason)

- **Build our own, single-file JS plugin.** No build step, no Python. Stash TV
  was tried on the phone and rejected (broken swipes, overlapping controls, no
  setup screen). It is reference only.
- **Plugin id and name `Reels`** (manifest `Reels.yml`, plus `Reels.js`,
  `Reels.css`). Distinct from the existing `StashReels` and `stash-tv` ids.
  The plugin and the `Reels` tag share a name; they are separate things.
- **Released through the normal workflow only:** commit, GitHub builds the
  plugin source, install/update from Stash's Plugins page. Never copy files
  into the Stash plugins directory.
- **Pool = scenes tagged `Reels`.** That tag already exists (id 6462,
  CONFIRMED) and is currently empty. Look it up by name at runtime; never hardcode the id.
- **Scenes enter the pool through a review grid**, not swipe-training.
- **Start screen is a cover grid** with category chips. Tapping a cover starts
  the feed at that clip.
- **One positive action: like.** There is no separate favourite.
- **Dislike tags for deletion. The plugin never deletes files.**
- **Plain `<video>` elements**, not Stash's ScenePlayer. No scrub bar, no cast
  button.
- **Loop by default, muted until first tap.**
- **Config store, not fake tags, for plugin data** (per 2026-07-19 notes §1).
- **Later, not v1:** marker segments, images/galleries, filtering the feed by
  tapping a performer/studio/tag, implicit signals (opt-in), HTTPS.

---

## 2. Tags

All looked up by name at start; created if missing (except `Reels`, which
exists).

| Tag | Meaning | Set by |
|---|---|---|
| `Reels` | In the feed pool | Review grid |
| `Reels-liked` | Liked; drives the "Liked" chip | Double-tap |
| `zzz-reels-rejected` | Reviewed and declined; never offered again | Review grid |
| `zzz-reels-delete` | Disliked; user deletes later in Stash | Thumbs-down |
| `zzz-reels-unplayable` | Failed to decode; review later | Feed, automatically |

Existing zzz tags to avoid colliding with (CONFIRMED): `Zzz temp`,
`zzz-upload`, `zzz-virtual`.

All tag changes use `bulkSceneUpdate` with `tag_ids: { ids, mode: ADD | REMOVE }`
(CONFIRMED the mode enum exists). Never send a scene's full tag list.

---

## 3. Queries

Field and filter names are CONFIRMED; the assembled queries are UNTESTED.

**Candidates (review grid):**
```graphql
query Candidates($max: Int!, $exclude: [ID!]) {
  findScenes(
    filter: { per_page: -1, sort: "created_at", direction: DESC }
    scene_filter: {
      orientation: { value: [PORTRAIT] }
      duration: { value: $max, modifier: LESS_THAN }
      tags: { value: $exclude, modifier: EXCLUDES }
    }
  ) { count scenes { id title paths { screenshot } files { duration video_codec } } }
}
```
`$exclude` = ids of `Reels`, `zzz-reels-rejected`, `zzz-reels-delete`,
`zzz-reels-unplayable`.

**Pool (start grid and feed share one fetch):**
```graphql
query Pool($reels: [ID!], $exclude: [ID!]) {
  findScenes(
    filter: { per_page: -1 }
    scene_filter: {
      tags: { value: $reels, modifier: INCLUDES_ALL, excludes: $exclude }
    }
  ) {
    count
    scenes {
      id title
      paths { screenshot stream }
      files { width height duration video_codec audio_codec }
      performers { id name }
      studio { id name image_path }
      tags { id name scene_count }
    }
  }
}
```
- UNTESTED: whether `HierarchicalMultiCriterionInput` has an `excludes` field
  on this version. If not, filter the unplayable/delete tags client-side.
- The pool is small (123 candidates under 300s, 170 under 600s, CONFIRMED),
  so fetch it all once and do ordering, chips and scoring client-side. If the
  pool ever exceeds ~1,000, switch to paged `sort: "random_<seed>"`
  (CONFIRMED stable across pages).

**Categories:** read `configuration { plugins }` → `TagChips.categories`,
shape `[{ id, label, defaultCollapsed, tagIds: [] }]` (CONFIRMED). Read-only;
Reels never writes to TagChips' config.

---

## 4. Screens

### 4.1 Entry
- `PluginApi.register.route("/reels", Component)`, registered at the very end
  of the IIFE (per 2026-07-26 notes). The route renders inside Stash's layout
  (CONFIRMED), so the component mounts one `position: fixed; inset: 0` layer
  with a high z-index that covers the navbar.
- The React component is a thin shell: it renders one empty div and everything
  inside is plain DOM, built in an effect and torn down on unmount.
- Nav link "Reels" added by DOM injection into the top navbar and the mobile
  hamburger menu, with a persistent (not time-boxed) observer. This is the
  technique Stash TV uses (CONFIRMED); copy its class names from the live
  bundle.
- Hardcoded dark-theme colours (Stash CSS variables don't resolve reliably in
  injected DOM).

### 4.2 Start screen
- **Chips row (horizontal scroll):** All, Liked, then one chip per TagChips
  category. A category chip keeps reels having at least one tag in that
  category. Hide chips with zero matching reels.
- **Cover grid:** `paths.screenshot`, CSS-cropped to 9:16 with
  `object-fit: cover`. Three columns on a phone, more on desktop. Lazy-load
  images. Small heart badge on liked clips.
- **Shuffle button:** starts the feed without a picked clip.
- **New candidates banner:** shown only when the candidates query returns
  more than zero. Opens the review grid.
- **Gear icon:** settings (section 7). Shows the plugin version.
- **Empty state:** if the pool is empty, go straight to the review grid.
- Returning from the feed restores the grid's scroll position and chip.

### 4.3 Review grid
- Every candidate as a cover with duration badge, all pre-selected.
- Tap toggles selection. Long-press (or hover on desktop) plays a muted
  preview in place.
- **Confirm:** selected scenes get `Reels`; unselected get
  `zzz-reels-rejected`. Two bulk mutations total.
- A count line: "118 will be added, 5 rejected".

### 4.4 Feed
- Container: `scroll-snap-type: y mandatory`, `overscroll-behavior: none`
  (stops pull-to-refresh), `height: 100dvh`.
- One slide per clip, `scroll-snap-align: start; scroll-snap-stop: always`.
- Only the current slide and one neighbour each side hold a `<video>` with a
  `src`. Others show the cover image only.
- `<video muted playsinline loop preload="auto">`, `object-fit: contain` by
  default.
- `IntersectionObserver` (threshold ~0.6) decides which slide is current:
  play it, pause and rewind the others.
- Source is `paths.stream`, which is always the original file with Range
  support and no auth on this instance (CONFIRMED).

**Overlay (plain DOM over the video):**
- Bottom left: performer names, each a link to `/performers/{id}`. Omitted if
  none (8 of 123 have none).
- Top right: studio image at ~50% opacity, link to `/studios/{id}`. Nothing
  shown when there is no studio. This is the common case (87 of 123).
- Bottom: tags as `#hashtags`, sorted by `scene_count` descending, clipped to
  two lines, then `…` which expands the full list on tap.
- Hidden from hashtags: `Reels`, `Reels-liked`, anything starting `zzz`.
- Bottom right: thumbs-down button. Above it: mute/unmute.
- Top left: back arrow to the start screen.
- Links leave the feed with a normal client-side navigation.

**Touch:**
| Gesture | Action |
|---|---|
| Swipe up / down | Next / previous (native scroll-snap) |
| First tap anywhere | Unmute (sound stays on for the session) |
| Single tap | Pause / play |
| Double tap | Like, with a heart animation. Double-tap on a liked clip does nothing. |
| Long press | 2x speed while held |

- A tap only counts if the finger moved less than ~10px. Single tap waits
  ~250ms to rule out a double tap.
- First-run hint card listing the gestures, shown once, then never.

**Desktop keys** (capture phase, `stopImmediatePropagation`, only while the
feed is mounted, so Stash's Mousetrap bindings never fire):
| Key | Action |
|---|---|
| ↓ / J, ↑ / K | Next / previous |
| Space | Pause / play |
| L | Like |
| D | Dislike |
| U | Undo |
| M | Mute |
| Esc | Back to start screen |

Mouse wheel scrolls one clip per notch. Swallow digits, backtick and `r`
(Stash's rating/random shortcuts, CONFIRMED) so they do nothing.

---

## 5. Actions

- **Like:** ADD `Reels-liked`; adjust scores +1 (section 6).
- **Unlike:** from the start grid only (tap the heart badge). REMOVE
  `Reels-liked`; reverse the score.
- **Dislike:** REMOVE `Reels` and `Reels-liked`, ADD `zzz-reels-delete`;
  scores −1; remove the slide; advance. Show a 5-second "Marked for deletion.
  Undo" toast.
- **Undo:** reverses the last like or dislike exactly (tags and scores). One
  level only.
- **Play counting:** if the setting is on, call `sceneAddPlay(id)` once per
  clip per session after 3 seconds of playback. Off by default.
- **Unplayable:** on a `<video>` error with code `MEDIA_ERR_DECODE` or
  `MEDIA_ERR_SRC_NOT_SUPPORTED`, skip to the next clip and ADD
  `zzz-reels-unplayable`. A stall (no `playing` event within 8s) only skips;
  it does not tag, because that may be the network.

---

## 6. Feed ordering ("more like this")

State in the config store:
```json
{
  "settings": { "...": "section 7" },
  "scores": { "performers": {"12": 3}, "studios": {"5": -1}, "tags": {"48": 2} },
  "cycle": { "seen": ["14465", "14459"] },
  "hintShown": true
}
```

- **Scoring a clip:**
  `s = 2 × mean(performer scores) + 1 × studio score + 1 × mean(tag scores)`.
  Missing parts count as 0. Weight `w = clamp(1 + 0.5 × s, 0.2, 5)`.
- **Like / dislike** adds +1 / −1 to every performer, the studio and every
  tag on that clip (excluding the hidden tags).
- **Picking the next clip:** from the clips in the active chip that are not
  in `cycle.seen`, pick at random in proportion to `w`. One pick in five
  ignores weights entirely.
- **Cycle rule:** when every clip in the pool has been seen, clear
  `cycle.seen` and start again. Liked clips therefore repeat, but never
  before everything else has had its turn.
- **Seed boost:** when the feed starts from a tapped cover, the next five
  picks multiply `w` by `1 + (shared performers × 1.0) + (shared tags × 0.25)`
  relative to that clip.
- **Writes:** one `readConfig()` / `writeConfig(patch)` pair that always
  re-reads before writing and shallow-merges, because `configurePlugin`
  replaces the whole object (CONFIRMED in notes). Scores are written on each
  action; `cycle.seen` is written every 5 clips and on leaving the feed.

---

## 7. Settings

Stored under `settings` in the config store and edited from the gear screen.

| Setting | Default |
|---|---|
| Max duration (seconds) | 300 |
| Orientation | Portrait only (option: portrait + square) |
| End of clip | Loop (option: auto-advance) |
| Fit | Contain (option: fill/crop) |
| Count plays in Stash | Off |
| Tag unplayable clips | On |
| Show nav link | On |

Also on this screen: "Reset recommendations" (clears `scores` and `cycle`),
and the plugin version string.

---

## 8. Build phases

Each phase ends with a hand test on the phone before the next starts.

**Phase 0 — spike (the smallest thing that answers the risky questions)**
Route, nav link, a visible version string, fixed overlay, the first 10 portrait clips under 300s in a scroll-snap
feed with autoplay, tap-to-unmute and pause. No tags, no overlay text.
Hand-test list:
- [ ] Swiping down never reloads the page; swiping up never pauses.
- [ ] Clips autoplay muted over plain HTTP, in a normal tab and a private tab.
- [ ] First tap unmutes and sound persists to the next clip.
- [ ] HEVC clips play on the phone. Note any that don't.
- [ ] Any clip that plays sideways (rotation metadata is not exposed).
- [ ] The browser's address bar doesn't cover the bottom of the clip.
- [ ] On desktop, digits, backtick and `r` do nothing while the feed is open.
- [ ] Leaving `/reels` restores the normal Stash UI completely.

**Phase 1 — pool and browsing**
Tag lookup/creation, review grid, start screen with chips and cover grid,
feed with full overlay, nav link, settings screen, first-run hint.

**Phase 2 — actions and ordering**
Like, dislike, undo, unplayable handling, scores, cycle rule, seed boost,
play counting.

**Phase 3 — later**
Marker segments, images and galleries, feed filtered by performer/studio/tag,
implicit signals as an opt-in, HTTPS and add-to-home-screen.

---

## 9. Verify before writing code against it

- [ ] `tags` filter: does `excludes` exist on this version?
- [ ] Actual pixel size of `paths.screenshot` for portrait scenes. The
      investigation measured the video files, not the cover images.
- [ ] `tagCreate` and `configurePlugin` input shapes by introspection (the
      investigation assumed them).
- [ ] Other global key listeners beyond `hooks/keybinds.ts`, especially
      space and arrows.
- [ ] The exact navbar and hamburger-menu selectors, read from the live DOM
      and from Stash TV's bundle.
- [ ] Whether a registered route survives a hard refresh at `/reels`.
- [ ] Two devices writing the config at once (phone and desktop) don't lose
      each other's scores.

## 10. Open questions

1. **Unlike from inside the feed.** Currently only from the start grid.

Settled: default limit is 300s. Unplayable clips are hidden on every device
by tag, and reviewed individually later.

## 11. Working rules for the build session

- Read `CLAUDE.md` and `PLUGIN-DEV-GUIDE.md` first. The dated dev-notes files
  were not found on the build machine; copy them into the repo if they exist
  elsewhere.
- Show the full diff and stop. The human runs every git command.
- Follow the repo's existing release process for the other plugins,
  including how versions are bumped. Every commit meant for testing needs a
  new version or Stash will not offer the update.
- The settings screen's version string is part of Phase 0, so the phone can
  confirm it is running the new build.
- During development, test mutations on two or three named scenes only.
- Confirm the served file is current before debugging behaviour:
  `fetch("/plugin/Reels/javascript").then(r => r.text()).then(t => console.log(t.length))`.
