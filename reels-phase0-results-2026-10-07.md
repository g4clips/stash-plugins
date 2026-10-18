# Reels — Phase 0 results and spec changes
**Date:** 2026-10-07
**Build tested:** Reels v0.1.0 (commit 2af80db), installed through the plugin source.
**Read with:** `reelsfeed-build-spec-2026-10-06.md`. Where the two differ, this file wins.

## Results (hand-tested)

| Check | iPad, Orion | Android, Edge | Desktop, Firefox 157 |
|---|---|---|---|
| Version label and nav link | pass | pass | pass |
| Swipe feed, autoplay muted (normal and private tab) | pass | pass | n/a |
| H.264 clips | play | play | play |
| HEVC clips (ids 14496, 14490, 14494) | play | play (reported "same as iPad") | fail, "Can't play (code 4)" |
| Sound carries to next clip | intermittent; "Tap for sound" shown when it doesn't | always | not reported |
| Sideways clips | none | none | none |
| Address bar covering clip | no | no | n/a |
| Single tap pause, × button | pass | pass | n/a |
| Arrows/JK, Space, Esc | n/a | n/a | pass |
| Digits, backtick, r swallowed; Ctrl+R still refreshes | n/a | n/a | pass |

Also tested on desktop: `http://192.168.4.100:6969/scene/14496/stream.mp4`
(Stash's live transcode) plays the HEVC clip, taking about 7 seconds to start
a 10-second clip.

## What this settles

- The single-file plugin, route + fixed overlay, DOM nav link and scroll-snap
  feed all work on all three devices. Keep the Phase 0 structure.
- Key handling is correct as built.
- Plain HTTP is not a problem for autoplay.
- Rotation: no sideways clips seen in this sample.

## Spec changes

### 1. HEVC: transcode fallback before tagging (replaces spec section 5 "Unplayable")
HEVC support is per browser: fine on the iPad and Android, absent in desktop
Firefox. 35 of 123 candidates are HEVC, so tagging on first failure would
let one desktop session hide 28% of the pool from every device.

New behaviour on a video error with code 3 or 4:
1. Retry the same clip once with the transcode URL: `paths.stream` + `.mp4`
   (i.e. `/scene/{id}/stream.mp4`). Show a small "Converting…" indicator,
   since start-up takes several seconds.
2. If the transcode plays, do nothing else. Do not tag.
3. Only if the transcode also errors: skip the clip and ADD
   `zzz-reels-unplayable`.
4. Remember per session that this browser cannot play the clip's codec, and
   go straight to the transcode URL for later clips with the same codec.
   `video.canPlayType` may be used as a hint but the error event is the
   authority.

A transcoded clip that loops may re-transcode on each loop. Check this in
the Phase 1 test and report it.

### 2. Sound: a pool of three reused video elements (replaces "one video per slide")
On the iPad, sound only carried to clips whose video element had been
unmuted during a tap. iOS ties permission for sound to the element.

New structure:
- Exactly three `<video>` elements exist for the whole feed (previous,
  current, next). Slides are poster images; the videos are moved into the
  slides that need them and given a new `src`.
- On the first tap, inside the tap handler, call `muted = false` and
  `play()` on all three elements (then pause the two that are not current),
  so every element has been started by a user gesture.
- Keep the existing fallback: if an unmuted play is still refused, play
  muted and show "Tap for sound".

This is expected to fix the iPad but is unverified until tested there.

### 3. Debug label stays, behind a setting
Keep the per-clip label (scene id, codec, size). Add a "Show debug info"
setting, default off.

## Still open
- Android: confirm explicitly that the HEVC clips played in Edge.
- Whether HEVC plays in desktop Chrome or Edge (untested).
