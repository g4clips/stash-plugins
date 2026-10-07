(function () {
  if (window._reelsPluginLoaded) {
    return;
  }
  window._reelsPluginLoaded = true;

  var REELS_VERSION = "0.1.0";
  var MAX_SCENES = 10;
  var CANDIDATE_COUNT = 40;
  var MAX_DURATION_SECONDS = 300;
  var MIN_HEVC_TARGET = 3;

  var SUPPRESSED_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "`", "r"];

  function waitForPluginApi(callback, attempts) {
    attempts = attempts || 0;
    if (window.PluginApi) {
      callback(window.PluginApi);
    } else if (attempts < 50) {
      setTimeout(function () {
        waitForPluginApi(callback, attempts + 1);
      }, 200);
    } else {
      console.error("Reels: PluginApi never became available.");
    }
  }

  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.errors) {
          throw new Error(data.errors[0].message);
        }
        return data.data;
      });
  }

  var SCENES_QUERY =
    "query ReelsPhase0($max_duration: Int!, $max_count: Int!) {" +
    "  findScenes(" +
    "    filter: { per_page: $max_count, sort: \"created_at\", direction: DESC }" +
    "    scene_filter: {" +
    "      orientation: { value: [PORTRAIT] }" +
    "      duration: { value: $max_duration, modifier: LESS_THAN }" +
    "    }" +
    "  ) {" +
    "    scenes {" +
    "      id" +
    "      paths { screenshot stream }" +
    "      files { width height video_codec audio_codec }" +
    "    }" +
    "  }" +
    "}";

  function fetchCandidates() {
    return gql(SCENES_QUERY, {
      max_duration: MAX_DURATION_SECONDS,
      max_count: CANDIDATE_COUNT,
    }).then(function (data) {
      return data.findScenes.scenes;
    });
  }

  function sceneFile(scene) {
    return scene.files && scene.files[0] ? scene.files[0] : null;
  }

  function isHevc(scene) {
    var f = sceneFile(scene);
    return !!f && typeof f.video_codec === "string" && f.video_codec.toLowerCase() === "hevc";
  }

  // Picks MAX_SCENES scenes from the candidate pool, trying to include at
  // least MIN_HEVC_TARGET HEVC clips (if that many exist) so Phase 0's
  // hand-test can actually exercise the HEVC playback risk on the phone.
  function pickScenes(candidates) {
    var hevc = candidates.filter(isHevc);
    var others = candidates.filter(function (s) {
      return !isHevc(s);
    });

    var hevcTarget = Math.min(MIN_HEVC_TARGET, hevc.length);
    var picked = hevc.slice(0, hevcTarget);

    var remaining = MAX_SCENES - picked.length;
    picked = picked.concat(others.slice(0, remaining));

    if (picked.length < MAX_SCENES) {
      var extraHevc = hevc.slice(hevcTarget, hevcTarget + (MAX_SCENES - picked.length));
      picked = picked.concat(extraHevc);
    }

    return picked.slice(0, MAX_SCENES);
  }

  // Finds the React Router history object by walking the fiber tree.
  // See PLUGIN-DEV-GUIDE.md §7.
  function getReactHistory() {
    var root = document.querySelector("#root");
    if (!root) return null;
    var fiber =
      root._reactRootContainer && root._reactRootContainer._internalRoot
        ? root._reactRootContainer._internalRoot.current
        : null;
    if (!fiber) return null;

    var history = null;
    function walk(node, depth) {
      if (!node || depth > 100 || history) return;
      try {
        if (
          node.memoizedProps &&
          node.memoizedProps.history &&
          typeof node.memoizedProps.history.push === "function"
        ) {
          history = node.memoizedProps.history;
        }
      } catch (e) {}
      walk(node.child, depth + 1);
      walk(node.sibling, depth + 1);
    }
    walk(fiber, 0);
    return history;
  }

  function navigateTo(path) {
    var history = getReactHistory();
    if (history) {
      history.push(path);
    } else {
      window.location.href = path;
    }
  }

  // --- Navbar link injection -------------------------------------------

  function injectNavLink() {
    if (document.getElementById("reels-nav-link")) return true;

    var anchor =
      document.querySelector('.top-nav a[href="/scenes"]') ||
      document.querySelector('.top-nav a[href="/tags"]');
    if (!anchor) return false;

    var itemContainer = anchor.closest(".col-4");
    if (!itemContainer || !itemContainer.parentElement) return false;

    var wrapper = document.createElement("div");
    wrapper.className = "col-4 col-sm-3 col-md-2 col-lg-auto";

    var link = document.createElement("a");
    link.id = "reels-nav-link";
    link.href = "/reels";
    link.className = "reels-nav-link";
    link.textContent = "Reels";
    link.addEventListener("click", function (e) {
      e.preventDefault();
      navigateTo("/reels");
    });

    wrapper.appendChild(link);
    itemContainer.parentElement.appendChild(wrapper);
    return true;
  }

  function startNavLinkObserver() {
    injectNavLink();
    var observer = new MutationObserver(function () {
      injectNavLink();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Feed overlay -------------------------------------------------------

  function buildSlide(scene) {
    var slide = {
      scene: scene,
      el: document.createElement("div"),
      video: document.createElement("video"),
      needsSoundRetry: false,
      debugLabel: null,
      errorLabel: null,
      tapHint: null,
    };
    slide.el.className = "reels-slide";

    slide.video.muted = true;
    slide.video.playsInline = true;
    slide.video.loop = true;
    slide.video.setAttribute("poster", scene.paths.screenshot || "");

    slide.video.addEventListener("error", function () {
      var err = slide.video.error;
      var code = err ? err.code : "?";
      console.error("Reels: video error on scene " + scene.id, code, err);
      showError(slide, code);
    });

    slide.el.appendChild(slide.video);

    var file = sceneFile(scene);
    var debugLabel = document.createElement("div");
    debugLabel.className = "reels-debug-label";
    debugLabel.textContent =
      "id:" +
      scene.id +
      " " +
      (file ? file.video_codec || "?" : "?") +
      " " +
      (file ? file.width + "x" + file.height : "?x?");
    slide.el.appendChild(debugLabel);
    slide.debugLabel = debugLabel;

    return slide;
  }

  function showError(slide, code) {
    if (slide.errorLabel) return;
    var label = document.createElement("div");
    label.className = "reels-error-label";
    label.textContent = "Can't play (code " + code + ")";
    slide.el.appendChild(label);
    slide.errorLabel = label;
  }

  function showTapForSound(slide) {
    slide.needsSoundRetry = true;
    if (slide.tapHint) return;
    var hint = document.createElement("div");
    hint.className = "reels-tap-hint";
    hint.textContent = "Tap for sound";
    slide.el.appendChild(hint);
    slide.tapHint = hint;
  }

  function hideTapForSound(slide) {
    slide.needsSoundRetry = false;
    if (slide.tapHint) {
      slide.tapHint.remove();
      slide.tapHint = null;
    }
  }

  // Keeps only the current slide and its immediate neighbours holding a
  // video `src`; everything else shows the poster image only.
  function updateActiveWindow(state) {
    state.slides.forEach(function (slide, i) {
      var distance = Math.abs(i - state.currentIndex);
      if (distance <= 1) {
        if (!slide.video.hasAttribute("src")) {
          slide.video.src = slide.scene.paths.stream;
        }
        slide.video.preload = i === state.currentIndex ? "auto" : "metadata";
      } else if (slide.video.hasAttribute("src")) {
        slide.video.pause();
        slide.video.removeAttribute("src");
        slide.video.preload = "metadata";
        slide.video.load();
      }
    });
  }

  function attemptPlayWithSound(slide, state) {
    slide.video.muted = false;
    var playPromise = slide.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(function (err) {
        if (err && err.name === "NotAllowedError" && slide === state.slides[state.currentIndex]) {
          console.warn("Reels: unmuted play rejected, falling back to muted.", err);
          slide.video.muted = true;
          var retry = slide.video.play();
          if (retry && typeof retry.catch === "function") {
            retry.catch(function (err2) {
              console.warn("Reels: fallback muted play also rejected.", err2);
            });
          }
          showTapForSound(slide);
        } else {
          console.warn("Reels: unmuted play rejected.", err);
        }
      });
    }
  }

  function playSlide(slide, state) {
    if (!slide.video.hasAttribute("src")) return;
    hideTapForSound(slide);
    if (state.unmuted) {
      attemptPlayWithSound(slide, state);
    } else {
      slide.video.muted = true;
      var playPromise = slide.video.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(function (err) {
          console.warn("Reels: muted play rejected.", err);
        });
      }
    }
  }

  function pauseSlide(slide) {
    slide.video.pause();
    try {
      slide.video.currentTime = 0;
    } catch (e) {}
  }

  function mountReelsOverlay(root) {
    var state = {
      unmuted: false,
      slides: [],
      currentIndex: 0,
      observer: null,
      keyHandler: null,
      disposed: false,
    };

    root.className = "reels-overlay";
    document.documentElement.classList.add("reels-html-lock");

    var versionBadge = document.createElement("div");
    versionBadge.className = "reels-version";
    versionBadge.textContent = "Reels v" + REELS_VERSION;
    root.appendChild(versionBadge);

    var closeButton = document.createElement("button");
    closeButton.className = "reels-close";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", function () {
      navigateTo("/");
    });
    root.appendChild(closeButton);

    var feed = document.createElement("div");
    feed.className = "reels-feed";
    root.appendChild(feed);

    fetchCandidates()
      .then(function (candidates) {
        if (state.disposed) return;

        var chosen = pickScenes(candidates);
        chosen.forEach(function (scene) {
          var slide = buildSlide(scene);
          feed.appendChild(slide.el);
          state.slides.push(slide);
          attachTapHandler(slide, state);
        });

        updateActiveWindow(state);

        state.observer = new IntersectionObserver(
          function (entries) {
            entries.forEach(function (entry) {
              var index = state.slides.findIndex(function (s) {
                return s.el === entry.target;
              });
              if (index === -1) return;

              if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
                if (state.currentIndex !== index) {
                  state.currentIndex = index;
                  updateActiveWindow(state);
                }
                playSlide(state.slides[index], state);
              } else {
                pauseSlide(state.slides[index]);
              }
            });
          },
          { threshold: [0, 0.6] }
        );

        state.slides.forEach(function (slide) {
          state.observer.observe(slide.el);
        });
      })
      .catch(function (err) {
        console.error("Reels: failed to load scenes.", err);
      });

    state.keyHandler = function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }

      var key = e.key;
      var lowerKey = typeof key === "string" ? key.toLowerCase() : key;

      if (SUPPRESSED_KEYS.indexOf(lowerKey) !== -1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      if (lowerKey === "arrowdown" || lowerKey === "j") {
        e.preventDefault();
        e.stopImmediatePropagation();
        scrollToIndex(feed, state.currentIndex + 1);
      } else if (lowerKey === "arrowup" || lowerKey === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        scrollToIndex(feed, state.currentIndex - 1);
      } else if (key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleCurrentPlayback(state);
      } else if (lowerKey === "escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateTo("/");
      }
    };
    document.addEventListener("keydown", state.keyHandler, true);

    return function unmount() {
      state.disposed = true;
      if (state.observer) {
        state.observer.disconnect();
      }
      document.removeEventListener("keydown", state.keyHandler, true);
      document.documentElement.classList.remove("reels-html-lock");
      state.slides.forEach(function (slide) {
        slide.video.pause();
        slide.video.removeAttribute("src");
        slide.video.load();
      });
    };
  }

  function scrollToIndex(feed, index) {
    var slides = feed.querySelectorAll(".reels-slide");
    if (index < 0 || index >= slides.length) return;
    slides[index].scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleCurrentPlayback(state) {
    var slide = state.slides[state.currentIndex];
    if (!slide) return;
    if (slide.video.paused) {
      slide.video.play().catch(function () {});
    } else {
      slide.video.pause();
    }
  }

  function attachTapHandler(slide, state) {
    var startX = 0;
    var startY = 0;
    var startTime = 0;
    var MOVE_THRESHOLD = 10;

    slide.el.addEventListener("pointerdown", function (e) {
      startX = e.clientX;
      startY = e.clientY;
      startTime = Date.now();
    });

    slide.el.addEventListener("pointerup", function (e) {
      var dx = Math.abs(e.clientX - startX);
      var dy = Math.abs(e.clientY - startY);
      var elapsed = Date.now() - startTime;
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD || elapsed > 600) {
        return; // scroll/swipe, not a tap
      }

      if (!state.unmuted) {
        state.unmuted = true;
        state.slides.forEach(function (s) {
          if (s.video.hasAttribute("src")) {
            s.video.muted = false;
          }
        });
        attemptPlayWithSound(slide, state);
        return;
      }

      if (slide.needsSoundRetry) {
        hideTapForSound(slide);
        attemptPlayWithSound(slide, state);
        return;
      }

      if (slide.video.paused) {
        slide.video.play().catch(function () {});
      } else {
        slide.video.pause();
      }
    });
  }

  // --- Route registration --------------------------------------------

  function ReelsPage() {
    var React = window.PluginApi.React;
    var containerRef = React.useRef(null);

    React.useEffect(function () {
      var unmount;
      if (containerRef.current) {
        unmount = mountReelsOverlay(containerRef.current);
      }
      return function () {
        if (unmount) unmount();
      };
    }, []);

    return React.createElement("div", { ref: containerRef });
  }

  waitForPluginApi(function (PluginApi) {
    startNavLinkObserver();
    PluginApi.register.route("/reels", ReelsPage);
  });
})();
