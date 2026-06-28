// seek-controls.js
// Adds 1-second seeking to the Stash video player.
// Ctrl+Left = back 1 second, Ctrl+Right = forward 1 second
// (Stash already uses Ctrl+Arrow for 60s seek, so we use Ctrl+Shift+Arrow for 1s)

(function () {
  "use strict";

  const PLUGIN_ID = "seek-controls";

  function getCurrentPlayer() {
    return document.querySelector("video-js")?.player ?? null;
  }

  function seek(seconds) {
    const player = getCurrentPlayer();
    if (!player) return;
    const newTime = Math.max(0, player.currentTime() + seconds);
    player.currentTime(Math.min(newTime, player.duration()));
  }

  function isScenePage() {
    return /^\/scenes\/\d+/.test(window.location.pathname);
  }

  document.addEventListener("keydown", (e) => {
    if (!isScenePage()) return;

    // Ignore if focus is in an input, textarea, or contenteditable
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable) return;

    // Ctrl+Shift+Right = +1 second
    // Ctrl+Shift+Left  = -1 second
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        e.stopPropagation();
        seek(1);
        console.log(`[${PLUGIN_ID}] Seeked +1s`);
      } else if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        e.stopPropagation();
        seek(-1);
        console.log(`[${PLUGIN_ID}] Seeked -1s`);
      }
    }
  }, true); // useCapture=true so we intercept before Video.js

  console.log(`[${PLUGIN_ID}] Loaded — Z = back 1s, X = forward 1s.`);

})();
