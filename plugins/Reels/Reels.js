(function () {
  if (window._reelsPluginLoaded) {
    return;
  }
  window._reelsPluginLoaded = true;

  var REELS_VERSION = "0.3.3";
  var PLUGIN_ID = "Reels";
  var CANDIDATE_MAX_COUNT = 500;
  var CURRENT_HINT_VERSION = 2;
  var SEEN_AFTER_MS = 2000;
  var PLAY_COUNT_AFTER_MS = 3000;
  var LONG_PRESS_MS = 450;
  var DOUBLE_TAP_MS = 250;
  var UNDO_TOAST_MS = 5000;

  var DEFAULT_SETTINGS = {
    maxDuration: 300,
    orientation: "portrait", // "portrait" | "portrait_square"
    endOfClip: "loop", // "loop" | "advance"
    fit: "contain", // "contain" | "fill" | "crop"
    landscapeClips: "blur", // "blur" | "crop" | "hide"
    countPlays: false,
    tagUnplayable: true,
    showNavLink: true,
    showDebugInfo: false,
  };

  var TAG_NAMES = {
    pool: "Reels",
    liked: "Reels-liked",
    rejected: "zzz-reels-rejected",
    deleted: "zzz-reels-delete",
    unplayable: "zzz-reels-unplayable",
  };

  var HIDDEN_HASHTAG_PREFIXES = ["zzz"];
  var HIDDEN_HASHTAG_NAMES = [TAG_NAMES.pool, TAG_NAMES.liked];

  var SUPPRESSED_KEYS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "`", "r"];

  // Lives for the whole page (every route), set once at plugin load and
  // whenever the settings screen saves a new value. The nav link observer
  // below reads this on every DOM mutation, so it must never be torn down
  // when the /reels route itself unmounts.
  var navLinkEnabled = true;

  function logErr(err) {
    console.error("Reels:", err);
  }

  // --- PluginApi bootstrap --------------------------------------------

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

  // --- GraphQL -----------------------------------------------------------

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

  var ALL_TAGS_QUERY =
    "query ReelsAllTags { findTags(filter: { per_page: -1 }) { tags { id name scene_count } } }";

  var TAG_CREATE_MUTATION =
    "mutation ReelsTagCreate($name: String!) { tagCreate(input: { name: $name }) { id name } }";

  var CANDIDATES_QUERY =
    "query ReelsCandidates($max_duration: Int!, $max_count: Int!, $exclude: [ID!], $orientation: OrientationCriterionInput) {" +
    "  findScenes(" +
    "    filter: { per_page: $max_count, sort: \"created_at\", direction: DESC }" +
    "    scene_filter: {" +
    "      orientation: $orientation" +
    "      duration: { value: $max_duration, modifier: LESS_THAN }" +
    "      tags: { value: $exclude, modifier: EXCLUDES }" +
    "    }" +
    "  ) {" +
    "    count" +
    "    scenes { id title paths { screenshot stream } files { duration video_codec } }" +
    "  }" +
    "}";

  var POOL_QUERY =
    "query ReelsPool($reels: [ID!], $exclude: [ID!]) {" +
    "  findScenes(" +
    "    filter: { per_page: -1 }" +
    "    scene_filter: {" +
    "      tags: { value: $reels, modifier: INCLUDES_ALL, excludes: $exclude }" +
    "    }" +
    "  ) {" +
    "    count" +
    "    scenes {" +
    "      id title" +
    "      paths { screenshot stream }" +
    "      files { width height duration video_codec audio_codec }" +
    "      performers { id name }" +
    "      studio { id name image_path }" +
    "      tags { id name }" +
    "    }" +
    "  }" +
    "}";

  var SCENE_REFRESH_QUERY =
    "query ReelsSceneRefresh($id: ID!) {" +
    "  findScene(id: $id) {" +
    "    id title" +
    "    paths { screenshot stream }" +
    "    files { width height duration video_codec audio_codec }" +
    "    performers { id name }" +
    "    studio { id name image_path }" +
    "    tags { id name }" +
    "  }" +
    "}";

  var CONFIGURATION_QUERY =
    "query ReelsConfiguration { configuration { plugins } }";

  var CONFIGURE_PLUGIN_MUTATION =
    "mutation ReelsConfigurePlugin($plugin_id: ID!, $input: Map!) {" +
    "  configurePlugin(plugin_id: $plugin_id, input: $input)" +
    "}";

  var BULK_SCENE_UPDATE_MUTATION =
    "mutation ReelsBulkSceneUpdate($ids: [ID!]!, $tag_ids: [ID!]!, $mode: BulkUpdateIdMode!) {" +
    "  bulkSceneUpdate(input: { ids: $ids, tag_ids: { ids: $tag_ids, mode: $mode } }) { id }" +
    "}";

  var SCENE_ADD_PLAY_MUTATION =
    "mutation ReelsSceneAddPlay($id: ID!) { sceneAddPlay(id: $id) { count } }";

  // All tag writes are chained onto this single promise, same pattern as
  // configWriteChain: calls run strictly in the order they were made, and
  // tagWriteChain itself is always normalized back to resolved so a
  // rejected write never wedges every write queued after it.
  var tagWriteChain = Promise.resolve();

  function performBulkUpdateTag(sceneIds, tagIds, mode) {
    return gql(BULK_SCENE_UPDATE_MUTATION, { ids: sceneIds, tag_ids: tagIds, mode: mode });
  }

  function bulkUpdateTag(sceneIds, tagIdOrIds, mode) {
    if (!sceneIds || !sceneIds.length) return Promise.resolve();
    var tagIds = Array.isArray(tagIdOrIds) ? tagIdOrIds : [tagIdOrIds];
    if (!tagIds.length) return Promise.resolve();
    var resultPromise = tagWriteChain.then(function () {
      return performBulkUpdateTag(sceneIds, tagIds, mode);
    });
    tagWriteChain = resultPromise.then(
      function () {},
      function () {}
    );
    return resultPromise;
  }

  // --- Tag lookup / creation ----------------------------------------------

  function ensureTags() {
    return gql(ALL_TAGS_QUERY).then(function (data) {
      var byName = {};
      var sceneCounts = {};
      data.findTags.tags.forEach(function (t) {
        byName[t.name] = t.id;
        sceneCounts[t.id] = t.scene_count || 0;
      });

      var missing = [];
      Object.keys(TAG_NAMES).forEach(function (key) {
        var name = TAG_NAMES[key];
        if (!byName[name]) missing.push(name);
      });

      if (!missing.length) {
        return { tags: resolveTagMap(byName), sceneCounts: sceneCounts };
      }

      return missing
        .reduce(function (chain, name) {
          return chain.then(function () {
            return gql(TAG_CREATE_MUTATION, { name: name }).then(function (res) {
              byName[name] = res.tagCreate.id;
              sceneCounts[res.tagCreate.id] = 0;
            });
          });
        }, Promise.resolve())
        .then(function () {
          return { tags: resolveTagMap(byName), sceneCounts: sceneCounts };
        });
    });
  }

  function resolveTagMap(byName) {
    var tags = {};
    Object.keys(TAG_NAMES).forEach(function (key) {
      tags[key] = byName[TAG_NAMES[key]];
    });
    return tags;
  }

  // --- Config store (read-merge-write, serialized) ------------------------

  function parseReelsConfig(plugins) {
    var raw = (plugins && plugins[PLUGIN_ID]) || {};
    return {
      settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
      scores: raw.scores || { performers: {}, studios: {}, tags: {} },
      cycle: raw.cycle || { seen: [] },
      hintVersion: raw.hintVersion || 0,
    };
  }

  function parseTagChipsCategories(plugins) {
    var tagChips = (plugins && plugins.TagChips) || {};
    return tagChips.categories || [];
  }

  function fetchConfigurationPlugins() {
    return gql(CONFIGURATION_QUERY).then(function (data) {
      return (data.configuration && data.configuration.plugins) || {};
    });
  }

  // Every write is chained onto this single promise, so only one
  // read-merge-write for the plugin's config is ever in flight: the next
  // write's read only happens after the previous write has finished, and
  // they land in the order they were requested. configWriteChain itself is
  // always normalized back to a resolved promise after each write, win or
  // lose -- so a rejected write never wedges every write queued after it.
  // Each call's own caller still sees that write's real outcome via the
  // returned `resultPromise`.
  var configWriteChain = Promise.resolve();

  function performConfigWrite(patch) {
    return fetchConfigurationPlugins().then(function (plugins) {
      var current = plugins[PLUGIN_ID] || {};
      var merged = Object.assign({}, current, patch);
      return gql(CONFIGURE_PLUGIN_MUTATION, {
        plugin_id: PLUGIN_ID,
        input: merged,
      }).then(function () {
        return merged;
      });
    });
  }

  function writeConfig(patch) {
    var resultPromise = configWriteChain.then(function () {
      return performConfigWrite(patch);
    });
    configWriteChain = resultPromise.then(
      function () {},
      function () {}
    );
    return resultPromise;
  }

  // --- Scene data helpers --------------------------------------------------

  function sceneFile(scene) {
    return scene.files && scene.files[0] ? scene.files[0] : null;
  }

  function sceneHasTag(scene, tagId) {
    return !!(scene.tags || []).some(function (t) {
      return t.id === tagId;
    });
  }

  function isLandscape(scene) {
    var f = sceneFile(scene);
    return !!(f && f.width && f.height && f.width > f.height);
  }

  // Tags shown as hashtags and used for scoring -- excludes the plugin's
  // own bookkeeping tags.
  function filteredTags(scene) {
    return (scene.tags || []).filter(function (t) {
      if (HIDDEN_HASHTAG_NAMES.indexOf(t.name) !== -1) return false;
      return !HIDDEN_HASHTAG_PREFIXES.some(function (prefix) {
        return t.name.indexOf(prefix) === 0;
      });
    });
  }

  function visibleHashtags(app, scene) {
    return filteredTags(scene).sort(function (a, b) {
      return (app.tagSceneCounts[b.id] || 0) - (app.tagSceneCounts[a.id] || 0);
    });
  }

  function formatDuration(seconds) {
    if (!seconds && seconds !== 0) return "";
    var s = Math.round(seconds);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" + r : r);
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function (a, b) {
      return a + b;
    }, 0) / arr.length;
  }

  function countSharedIds(a, b) {
    var setB = {};
    (b || []).forEach(function (x) {
      setB[x.id] = true;
    });
    return (a || []).filter(function (x) {
      return setB[x.id];
    }).length;
  }

  // --- Scoring / ordering (spec section 6) --------------------------------

  function computeWeight(scene, scores) {
    var perfVals = (scene.performers || []).map(function (p) {
      return scores.performers[p.id] || 0;
    });
    var tagVals = filteredTags(scene).map(function (t) {
      return scores.tags[t.id] || 0;
    });
    var studioScore = scene.studio ? scores.studios[scene.studio.id] || 0 : 0;
    var s = 2 * mean(perfVals) + studioScore + mean(tagVals);
    return clamp(1 + 0.5 * s, 0.2, 5);
  }

  function applyScoreDelta(app, scene, delta) {
    var scores = app.config.scores;
    (scene.performers || []).forEach(function (p) {
      scores.performers[p.id] = (scores.performers[p.id] || 0) + delta;
    });
    if (scene.studio) {
      scores.studios[scene.studio.id] = (scores.studios[scene.studio.id] || 0) + delta;
    }
    filteredTags(scene).forEach(function (t) {
      scores.tags[t.id] = (scores.tags[t.id] || 0) + delta;
    });
    writeConfig({ scores: scores }).catch(logErr);
  }

  // Weighted sample-without-replacement over `list`. One pick in five
  // ignores weights. `weightFn` lets callers apply a seed boost that only
  // affects the first few draws.
  function weightedDrawAll(list, weightFn) {
    var remaining = list.slice();
    var out = [];
    while (remaining.length) {
      var idx;
      if (Math.random() < 0.2) {
        idx = Math.floor(Math.random() * remaining.length);
      } else {
        var weights = remaining.map(weightFn);
        var total = weights.reduce(function (a, b) {
          return a + b;
        }, 0);
        var r = Math.random() * total;
        idx = 0;
        for (; idx < weights.length - 1; idx++) {
          r -= weights[idx];
          if (r <= 0) break;
        }
      }
      out.push(remaining.splice(idx, 1)[0]);
    }
    return out;
  }

  // Builds a feed order over `pool`: draws without replacement by weight,
  // first from clips not in cycle.seen, then from seen ones. If `seedScene`
  // is given it goes first, and the next five draws get a boost relative
  // to it (spec section 6).
  function buildFeedOrder(app, pool, seedScene, boostOnly) {
    var seenSet = {};
    (app.config.cycle.seen || []).forEach(function (id) {
      seenSet[id] = true;
    });

    var rest = seedScene
      ? pool.filter(function (s) {
          return s.id !== seedScene.id;
        })
      : pool.slice();
    var unseen = rest.filter(function (s) {
      return !seenSet[s.id];
    });
    var seen = rest.filter(function (s) {
      return seenSet[s.id];
    });

    var drawsDone = 0;
    function weightFn(scene) {
      var w = computeWeight(scene, app.config.scores);
      if (seedScene && drawsDone < 5) {
        var sharedPerformers = countSharedIds(scene.performers, seedScene.performers);
        var sharedTags = countSharedIds(filteredTags(scene), filteredTags(seedScene));
        w *= 1 + sharedPerformers * 1.0 + sharedTags * 0.25;
      }
      return w;
    }
    function drawTracked(list) {
      var out = weightedDrawAll(list, function (scene) {
        var w = weightFn(scene);
        return w;
      });
      // weightedDrawAll draws one at a time internally but doesn't expose a
      // per-draw callback, so approximate the "first five draws" window by
      // counting after the fact -- good enough given the boost is already
      // a soft multiplier, not an exact cutoff.
      drawsDone += out.length;
      return out;
    }

    var order = [];
    if (seedScene && !boostOnly) order.push(seedScene);
    return order.concat(drawTracked(unseen)).concat(drawTracked(seen));
  }

  // Weight-sampling the full pool is O(n^2) (buildFeedOrder re-weighs every
  // remaining scene on every draw) -- fine for a few hundred clips, too
  // slow to do synchronously at ~2,300. estimateBuildFeedOrderMs times a
  // small sample and scales it up by the algorithm's O(n^2) shape instead
  // of running (and discarding) the full computation just to measure it.
  var FEED_ORDER_BUDGET_MS = 50;
  var FEED_ORDER_SAMPLE_SIZE = 50;

  function estimateBuildFeedOrderMs(app, pool) {
    var n = pool.length;
    if (n <= FEED_ORDER_SAMPLE_SIZE) return 0;
    var sample = pool.slice(0, FEED_ORDER_SAMPLE_SIZE);
    var t0 = performance.now();
    buildFeedOrder(app, sample, null, true);
    var sampleMs = performance.now() - t0;
    var scale = (n / FEED_ORDER_SAMPLE_SIZE) * (n / FEED_ORDER_SAMPLE_SIZE);
    return sampleMs * scale;
  }

  // Only the first FAST_SAMPLE_WINDOW positions (plus the seed) are weight-
  // sampled up front; the rest is plain-shuffled and gets weight-sampled in
  // FAST_SAMPLE_WINDOW-sized batches as the viewer approaches it (see
  // topUpFastOrder). Keeps the initial feed build under budget regardless
  // of pool size.
  var FAST_SAMPLE_WINDOW = 50;

  function buildFeedOrderFast(app, pool, seedScene) {
    var rest = seedScene
      ? pool.filter(function (s) {
          return s.id !== seedScene.id;
        })
      : pool.slice();
    var seenSet = {};
    (app.config.cycle.seen || []).forEach(function (id) {
      seenSet[id] = true;
    });
    // Keep the cycle rule in the shuffled tail too: unseen clips (shuffled)
    // all come before seen clips (shuffled).
    var shuffled = shuffle(
      rest.filter(function (s) {
        return !seenSet[s.id];
      })
    ).concat(
      shuffle(
        rest.filter(function (s) {
          return seenSet[s.id];
        })
      )
    );
    var headPool = shuffled.slice(0, FAST_SAMPLE_WINDOW);
    var tailPool = shuffled.slice(FAST_SAMPLE_WINDOW);
    var head = buildFeedOrder(app, headPool, seedScene);
    return head.concat(tailPool);
  }

  // Called from assignVideosToWindow on every index change. Once the
  // viewer gets within 10 slides of the still-shuffled (not yet weight-
  // sampled) tail, weight-samples the next FAST_SAMPLE_WINDOW scenes in
  // place, same as reorderUpcoming does after a like/dislike. Each batch is
  // contiguous, so buildFeedOrder's unseen-then-seen split keeps the tail's
  // two groups in order.
  function topUpFastOrder(state) {
    if (!state.fastOrderBoundary) return;
    if (state.fastOrderBoundary >= state.scenes.length) return;
    if (state.currentIndex + 10 < state.fastOrderBoundary) return;

    var app = state.app;
    var nextEnd = Math.min(state.fastOrderBoundary + FAST_SAMPLE_WINDOW, state.scenes.length);
    var chunkScenes = state.scenes.slice(state.fastOrderBoundary, nextEnd);
    var resampled = buildFeedOrder(app, chunkScenes, null, true);
    for (var i = 0; i < resampled.length; i++) {
      var idx = state.fastOrderBoundary + i;
      var slide = state.slideEls[idx];
      if (!slide) break;
      var changed = !slide.scene || slide.scene.id !== resampled[i].id;
      slide.scene = resampled[i];
      if (changed) slide.dirty = true;
      state.scenes[idx] = resampled[i];
    }
    state.fastOrderBoundary = nextEnd;
    populateDirtySlidesNear(state);
  }

  // Builds the feed order for a fresh mount, choosing the cheap sampling
  // path when the full weighted draw would blow the frame budget. Returns
  // { order, fastOrderBoundary } -- fastOrderBoundary is null when the
  // whole order was weight-sampled up front.
  function buildInitialFeedOrder(app, pool, seedScene) {
    var estMs = estimateBuildFeedOrderMs(app, pool);
    if (estMs > FEED_ORDER_BUDGET_MS) {
      console.log(
        "Reels: buildFeedOrder estimated " + estMs.toFixed(1) + "ms for " + pool.length +
          " clips -- using fast sampling path."
      );
      var order = buildFeedOrderFast(app, pool, seedScene);
      var boundary = Math.min(FAST_SAMPLE_WINDOW + (seedScene ? 1 : 0), order.length);
      return { order: order, fastOrderBoundary: boundary };
    }
    var t0 = performance.now();
    var fullOrder = buildFeedOrder(app, pool, seedScene);
    console.log("Reels: buildFeedOrder took " + (performance.now() - t0).toFixed(1) + "ms for " + pool.length + " clips.");
    return { order: fullOrder, fastOrderBoundary: null };
  }

  // --- React Router navigation (PLUGIN-DEV-GUIDE.md sec 7) ---------------

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

  function navigateLeaveFeed() {
    navigateTo("/");
  }

  // Performer/studio links inside a feed slide navigate away from /reels
  // entirely. Drop the #feed hash we pushed when the feed opened (plain
  // replaceState -- no new entry) before navigating, so one back press
  // from the destination page lands on plain /reels and a second leaves,
  // instead of landing back inside the feed's own history entry.
  function leaveFeedForLink(state, path) {
    if (state && state.historyEntryOpen) {
      state.historyEntryOpen = false;
      history.replaceState(null, "", location.pathname + location.search);
    }
    navigateTo(path);
  }

  // --- Navbar link injection -----------------------------------------------

  function injectNavLink(show) {
    var existing = document.getElementById("reels-nav-link");
    if (!show) {
      if (existing) existing.closest(".col-4, .col-sm-3, .col-md-2, .col-lg-auto").remove();
      return true;
    }
    if (existing) return true;

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

  // Runs once for the life of the plugin (started from waitForPluginApi
  // below), independent of whether the /reels route is currently mounted.
  function startNavLinkObserver() {
    function apply() {
      injectNavLink(navLinkEnabled);
    }
    apply();
    var observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- DOM helpers ----------------------------------------------------

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // Routes every mute-state change on a pool <video> through one place so
  // it can be logged (debug diagnosis for the Android/Edge silent-clip
  // reports) without littering every call site with console calls.
  function setVideoMuted(video, muted, scene, reason) {
    if (video.muted === muted) return;
    video.muted = muted;
    console.log(
      "Reels: muted -> " + muted + " (scene " + (scene ? scene.id : "?") + ", element " +
        (video._reelsLetter || "?") + ", " + reason + ")"
    );
  }

  // =========================================================================
  // Application shell: owns the current screen and shared data.
  // =========================================================================

  // The Reels app (config, pool, live feed, the three <video> elements)
  // outlives the /reels route: ReelsPage suspends it on unmount and
  // reattaches it on the next mount. A full page reload starts fresh.
  var persistedApp = null;

  function createApp(root) {
    var app = {
      root: root,
      tags: null,
      tagSceneCounts: {},
      config: null,
      chipsCategories: [],
      pool: [],
      candidates: [],
      candidatesCount: 0,
      screen: "loading",
      activeChipId: "all",
      gridScrollTop: 0,
      unmuted: false,
      soundUnlocked: false,
      codecNeedsTranscode: {}, // video_codec -> true, learned this session
      playCountedIds: {}, // scene id -> true, counted this session
      videos: ["A", "B", "C"].map(function (letter) {
        var v = document.createElement("video");
        v.playsInline = true;
        v.muted = true;
        v.preload = "metadata";
        v._reelsLetter = letter;
        return v;
      }),
      _feedState: null,
    };
    return app;
  }

  // Changing the chip, pressing Shuffle, confirming the review grid, or
  // saving settings all invalidate whatever feed is currently built so the
  // next startFeed() call rebuilds from scratch instead of resuming.
  function invalidateFeedState(app) {
    if (app._feedState) {
      unmountFeedScreen(app._feedState);
      app._feedState = null;
    }
  }

  function loadAll(app) {
    return Promise.all([ensureTags(), fetchConfigurationPlugins()]).then(function (results) {
      app.tags = results[0].tags;
      app.tagSceneCounts = results[0].sceneCounts;
      var plugins = results[1];
      app.config = parseReelsConfig(plugins);
      app.chipsCategories = parseTagChipsCategories(plugins);
      navLinkEnabled = app.config.settings.showNavLink;
      return refetchPoolAndCandidates(app);
    });
  }

  function refetchPoolAndCandidates(app) {
    var candidateExcludeIds = [app.tags.pool, app.tags.rejected, app.tags.deleted, app.tags.unplayable];
    var poolExcludeIds = [app.tags.deleted, app.tags.unplayable];
    var orientationValues =
      app.config.settings.orientation === "portrait_square" ? ["PORTRAIT", "SQUARE"] : ["PORTRAIT"];

    return Promise.all([
      gql(POOL_QUERY, { reels: [app.tags.pool], exclude: poolExcludeIds }),
      gql(CANDIDATES_QUERY, {
        max_duration: app.config.settings.maxDuration,
        max_count: CANDIDATE_MAX_COUNT,
        exclude: candidateExcludeIds,
        orientation: { value: orientationValues },
      }),
    ]).then(function (results) {
      // Shuffled once here (covers both the initial load and every
      // refetch) and then left alone -- the cover grid's order must stay
      // put across a feed round-trip. The feed does its own independent
      // ordering each time it starts.
      app.pool = shuffle(results[0].findScenes.scenes);
      app.candidates = results[1].findScenes.scenes;
      app.candidatesCount = results[1].findScenes.count;
    });
  }

  function setScreen(app, screen) {
    app.screen = screen;
    render(app);
  }

  function render(app) {
    clear(app.root);
    app.root.appendChild(buildTopBar(app));

    var body = el("div", "reels-screen-body");
    app.root.appendChild(body);

    if (app.screen === "loading") {
      body.appendChild(el("div", "reels-loading", "Loading…"));
    } else if (app.screen === "start") {
      body.appendChild(buildStartScreen(app));
    } else if (app.screen === "review") {
      body.appendChild(buildReviewScreen(app));
    } else if (app.screen === "settings") {
      body.appendChild(buildSettingsScreen(app));
    } else if (app.screen === "feed") {
      // Feed takes over the whole root; it manages its own top bar.
      clear(app.root);
      if (app._feedState && !app._feedState.disposed) {
        showFeedScreenExisting(app, app._feedState);
      } else {
        mountFeedScreen(app);
      }
    }
  }

  function buildTopBar(app) {
    var bar = el("div", "reels-topbar");

    if (app.screen !== "start") {
      var back = el("button", "reels-back", "←");
      back.setAttribute("aria-label", "Back");
      back.addEventListener("click", function () {
        setScreen(app, "start");
      });
      bar.appendChild(back);
    } else {
      var close = el("button", "reels-back", "×");
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", navigateLeaveFeed);
      bar.appendChild(close);
    }

    bar.appendChild(el("div", "reels-version", "Reels v" + REELS_VERSION));

    if (app.screen === "start") {
      var gear = el("button", "reels-gear", "⚙");
      gear.setAttribute("aria-label", "Settings");
      gear.addEventListener("click", function () {
        setScreen(app, "settings");
      });
      bar.appendChild(gear);
    }

    return bar;
  }

  // =========================================================================
  // Start screen
  // =========================================================================

  function poolMatchesChip(app, scene, chipId) {
    if (chipId === "all") return true;
    if (chipId === "liked") return sceneHasTag(scene, app.tags.liked);
    var category = app.chipsCategories.filter(function (c) {
      return c.id === chipId;
    })[0];
    if (!category) return false;
    var tagIdSet = {};
    (category.tagIds || []).forEach(function (id) {
      tagIdSet[id] = true;
    });
    return (scene.tags || []).some(function (t) {
      return tagIdSet[t.id];
    });
  }

  function buildStartScreen(app) {
    var container = el("div", "reels-start");

    if (!app.pool.length) {
      container.appendChild(el("div", "reels-empty-state", "No clips in the pool yet."));
      var reviewBtn = el("button", "btn btn-primary reels-empty-review-btn", "Review candidates");
      reviewBtn.addEventListener("click", function () {
        setScreen(app, "review");
      });
      container.appendChild(reviewBtn);
      return container;
    }

    if (app.candidatesCount > 0) {
      var banner = el(
        "div",
        "reels-new-candidates-banner",
        app.candidatesCount + " new candidate" + (app.candidatesCount === 1 ? "" : "s") + " to review"
      );
      banner.addEventListener("click", function () {
        setScreen(app, "review");
      });
      container.appendChild(banner);
    }

    var chipsRow = el("div", "reels-chips-row");
    var chips = [{ id: "all", label: "All" }, { id: "liked", label: "Liked" }].concat(
      app.chipsCategories.map(function (c) {
        return { id: c.id, label: c.label };
      })
    );

    chips.forEach(function (chip) {
      var matching = app.pool.filter(function (s) {
        return poolMatchesChip(app, s, chip.id);
      });
      if (chip.id !== "all" && chip.id !== "liked" && matching.length === 0) return;

      var chipEl = el(
        "button",
        "reels-chip" + (app.activeChipId === chip.id ? " reels-chip-active" : ""),
        chip.label
      );
      chipEl.addEventListener("click", function () {
        app.activeChipId = chip.id;
        render(app);
      });
      chipsRow.appendChild(chipEl);
    });
    container.appendChild(chipsRow);

    var shuffleBtn = el("button", "reels-shuffle-btn", "Shuffle");
    shuffleBtn.addEventListener("click", function () {
      startFeed(app, null, true);
    });
    container.appendChild(shuffleBtn);

    var gridScroll = el("div", "reels-cover-grid-scroll");
    gridScroll.addEventListener("scroll", function () {
      app.gridScrollTop = gridScroll.scrollTop;
    });

    var grid = el("div", "reels-cover-grid");

    var filtered = app.pool.filter(function (s) {
      return poolMatchesChip(app, s, app.activeChipId);
    });
    if (app.config.settings.landscapeClips === "hide") {
      filtered = filtered.filter(function (s) {
        return !isLandscape(s);
      });
    }

    filtered.forEach(function (scene) {
      grid.appendChild(buildCoverCell(app, scene));
    });
    gridScroll.appendChild(grid);
    container.appendChild(gridScroll);

    setTimeout(function () {
      gridScroll.scrollTop = app.gridScrollTop;
    }, 0);

    return container;
  }

  function buildCoverCell(app, scene) {
    var cell = el("div", "reels-cover-cell");
    cell.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });

    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    img.src = scene.paths.screenshot || "";
    img.alt = "";
    cell.appendChild(img);

    var heartBadge = null;
    function renderHeartBadge() {
      if (heartBadge) {
        heartBadge.remove();
        heartBadge = null;
      }
      if (sceneHasTag(scene, app.tags.liked)) {
        heartBadge = el("button", "reels-heart-badge", "♥");
        heartBadge.setAttribute("aria-label", "Unlike");
        heartBadge.addEventListener("click", function (e) {
          e.stopPropagation();
          e.preventDefault();
          unlikeFromGrid(app, scene);
        });
        cell.appendChild(heartBadge);
      }
    }
    renderHeartBadge();

    cell.addEventListener("click", function () {
      startFeed(app, scene.id);
    });

    return cell;
  }

  function unlikeFromGrid(app, scene) {
    if (!sceneHasTag(scene, app.tags.liked)) return;
    scene.tags = scene.tags.filter(function (t) {
      return t.id !== app.tags.liked;
    });
    bulkUpdateTag([scene.id], app.tags.liked, "REMOVE").catch(function (err) {
      handleTagWriteFailure(app, err);
    });
    applyScoreDelta(app, scene, -1);
    render(app);
  }

  function startFeed(app, seedSceneId, forceRebuild) {
    var existing = app._feedState;
    var sameChip = existing && !existing.disposed && existing.chipId === app.activeChipId;
    var seedInFeed =
      !seedSceneId ||
      (sameChip &&
        existing.scenes.some(function (s) {
          return s.id === seedSceneId;
        }));

    // A cover that isn't in the live feed rebuilds directly, without
    // showing the old feed first, so only one #feed history entry is pushed.
    if (forceRebuild || !sameChip || !seedInFeed) {
      invalidateFeedState(app);
      app.feedSeedSceneId = seedSceneId;
      app.feedChipId = app.activeChipId;
      setScreen(app, "feed");
      if (app.unmuted && app._feedState) {
        unlockSound(app._feedState);
      }
      return;
    }

    // Same chip, feed already built: resume it in place instead of
    // rebuilding -- render() detects the live state and just redisplays it.
    app.feedChipId = app.activeChipId;
    setScreen(app, "feed");
    if (seedSceneId) jumpToSceneInFeed(app, existing, seedSceneId);
    if (app.unmuted) unlockSound(existing);
  }

  // Tapping a cover while a feed for the same chip is already live: jump
  // to that clip in place (no rebuild) and re-sort what comes after it
  // with the seed boost, same deferred path like/dislike use.
  function jumpToSceneInFeed(app, state, seedSceneId) {
    var idx = -1;
    for (var i = 0; i < state.scenes.length; i++) {
      if (state.scenes[i].id === seedSceneId) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return; // startFeed checked membership before showing the feed

    var seedScene = state.scenes[idx];
    state.currentIndex = idx;
    state.slideEls[idx].el.scrollIntoView({ behavior: "auto", block: "start" });
    assignVideosToWindow(state);
    onBecameCurrent(state, state.slideEls[idx]);
    deferReorderUpcoming(app, state, seedScene);
  }

  // =========================================================================
  // Review grid
  // =========================================================================

  function buildReviewScreen(app) {
    var container = el("div", "reels-review");

    if (!app.candidates.length) {
      container.appendChild(el("div", "reels-empty-state", "No new candidates."));
      return container;
    }

    var selected = {};
    app.candidates.forEach(function (s) {
      selected[s.id] = true; // all pre-selected
    });

    var countLine = el("div", "reels-review-count");
    container.appendChild(countLine);

    function updateCountLine() {
      var sel = Object.keys(selected).filter(function (id) {
        return selected[id];
      }).length;
      var rej = app.candidates.length - sel;
      countLine.textContent = sel + " will be added, " + rej + " rejected";
    }

    // Only one preview (touch play-button or desktop hover) plays at a
    // time across the whole grid.
    var activePreviewStop = null;

    var gridScroll = el("div", "reels-review-grid-scroll");
    var grid = el("div", "reels-review-grid");
    app.candidates.forEach(function (scene) {
      var cell = el("div", "reels-review-cell reels-review-cell-selected");
      cell.addEventListener("contextmenu", function (e) {
        e.preventDefault();
      });

      var img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.src = scene.paths.screenshot || "";
      cell.appendChild(img);

      cell.appendChild(el("div", "reels-select-badge", "✓"));

      var file = sceneFile(scene);
      if (file && file.duration) {
        cell.appendChild(el("div", "reels-duration-badge", formatDuration(file.duration)));
      }

      var previewVideo = null;
      var playBtn = el("button", "reels-cell-play-btn", "▶");
      playBtn.setAttribute("aria-label", "Preview");

      function startPreview() {
        if (previewVideo) return;
        if (activePreviewStop) activePreviewStop();
        previewVideo = document.createElement("video");
        previewVideo.muted = true;
        previewVideo.loop = true;
        previewVideo.playsInline = true;
        previewVideo.className = "reels-review-preview";
        previewVideo.src = scene.paths.stream;
        cell.appendChild(previewVideo);
        previewVideo.play().catch(function () {});
        playBtn.textContent = "❚❚";
        activePreviewStop = stopPreview;
      }
      function stopPreview() {
        if (!previewVideo) return;
        previewVideo.pause();
        previewVideo.removeAttribute("src");
        previewVideo.load();
        previewVideo.remove();
        previewVideo = null;
        playBtn.textContent = "▶";
        if (activePreviewStop === stopPreview) activePreviewStop = null;
      }

      playBtn.addEventListener("click", function (e) {
        e.stopPropagation(); // never toggles selection
        if (previewVideo) stopPreview();
        else startPreview();
      });
      cell.appendChild(playBtn);

      // Desktop hover only; touch devices use the play button above.
      cell.addEventListener("pointerenter", function (e) {
        if (e.pointerType !== "mouse") return;
        startPreview();
      });
      cell.addEventListener("pointerleave", function (e) {
        if (e.pointerType !== "mouse") return;
        stopPreview();
      });

      cell.addEventListener("click", function () {
        selected[scene.id] = !selected[scene.id];
        cell.classList.toggle("reels-review-cell-selected", !!selected[scene.id]);
        updateCountLine();
      });

      grid.appendChild(cell);
    });
    gridScroll.appendChild(grid);
    container.appendChild(gridScroll);
    updateCountLine();

    var confirmBtn = el("button", "btn btn-primary reels-confirm-btn", "Confirm");
    confirmBtn.addEventListener("click", function () {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Saving…";

      var acceptedIds = [];
      var rejectedIds = [];
      app.candidates.forEach(function (s) {
        if (selected[s.id]) acceptedIds.push(s.id);
        else rejectedIds.push(s.id);
      });

      Promise.all([
        bulkUpdateTag(acceptedIds, app.tags.pool, "ADD"),
        bulkUpdateTag(rejectedIds, app.tags.rejected, "ADD"),
      ])
        .then(function () {
          return refetchPoolAndCandidates(app);
        })
        .then(function () {
          invalidateFeedState(app);
          setScreen(app, "start");
        })
        .catch(function (err) {
          handleTagWriteFailure(app, err);
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Confirm";
        });
    });
    container.appendChild(confirmBtn);

    return container;
  }

  // =========================================================================
  // Settings screen
  // =========================================================================

  function buildSettingsScreen(app) {
    var container = el("div", "reels-settings");
    container.appendChild(el("div", "reels-settings-version", "Reels v" + REELS_VERSION));

    var form = el("div", "reels-settings-form");
    container.appendChild(form);

    var pending = Object.assign({}, app.config.settings);

    function row(labelText, inputEl) {
      var r = el("div", "reels-settings-row");
      r.appendChild(el("label", "reels-settings-label", labelText));
      r.appendChild(inputEl);
      form.appendChild(r);
    }

    var durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.value = pending.maxDuration;
    durationInput.min = "1";
    durationInput.addEventListener("input", function () {
      pending.maxDuration = parseInt(durationInput.value, 10) || DEFAULT_SETTINGS.maxDuration;
    });
    row("Max duration (seconds)", durationInput);

    function selectRow(labelText, options, currentValue, onChange) {
      var select = document.createElement("select");
      options.forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === currentValue) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener("change", function () {
        onChange(select.value);
      });
      row(labelText, select);
    }

    selectRow(
      "Orientation",
      [
        { value: "portrait", label: "Portrait only" },
        { value: "portrait_square", label: "Portrait + square" },
      ],
      pending.orientation,
      function (v) {
        pending.orientation = v;
      }
    );

    selectRow(
      "End of clip",
      [
        { value: "loop", label: "Loop" },
        { value: "advance", label: "Auto-advance" },
      ],
      pending.endOfClip,
      function (v) {
        pending.endOfClip = v;
      }
    );

    selectRow(
      "Fit (portrait clips)",
      [
        { value: "contain", label: "Contain" },
        { value: "fill", label: "Fill" },
        { value: "crop", label: "Crop" },
      ],
      pending.fit,
      function (v) {
        pending.fit = v;
      }
    );

    selectRow(
      "Landscape clips",
      [
        { value: "blur", label: "Blur backdrop" },
        { value: "crop", label: "Crop" },
        { value: "hide", label: "Hide" },
      ],
      pending.landscapeClips || "blur",
      function (v) {
        pending.landscapeClips = v;
      }
    );

    function checkboxRow(labelText, currentValue, onChange) {
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!currentValue;
      checkbox.addEventListener("change", function () {
        onChange(checkbox.checked);
      });
      row(labelText, checkbox);
    }

    checkboxRow("Count plays in Stash", pending.countPlays, function (v) {
      pending.countPlays = v;
    });
    checkboxRow("Tag unplayable clips", pending.tagUnplayable, function (v) {
      pending.tagUnplayable = v;
    });
    checkboxRow("Show nav link", pending.showNavLink, function (v) {
      pending.showNavLink = v;
    });
    checkboxRow("Show debug info", pending.showDebugInfo, function (v) {
      pending.showDebugInfo = v;
    });

    var saveBtn = el("button", "btn btn-primary reels-settings-save", "Save");
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      writeConfig({ settings: pending })
        .then(function () {
          app.config.settings = pending;
          navLinkEnabled = pending.showNavLink;
          injectNavLink(pending.showNavLink);
          return refetchPoolAndCandidates(app);
        })
        .then(function () {
          invalidateFeedState(app);
          setScreen(app, "start");
        })
        .catch(function (err) {
          console.error("Reels: failed to save settings.", err);
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
        });
    });
    container.appendChild(saveBtn);

    var resetBtn = el("button", "btn btn-secondary reels-settings-reset", "Reset recommendations");
    resetBtn.addEventListener("click", function () {
      resetBtn.disabled = true;
      writeConfig({ scores: { performers: {}, studios: {}, tags: {} }, cycle: { seen: [] } })
        .then(function () {
          app.config.scores = { performers: {}, studios: {}, tags: {} };
          app.config.cycle = { seen: [] };
          resetBtn.textContent = "Reset ✓";
          setTimeout(function () {
            resetBtn.textContent = "Reset recommendations";
            resetBtn.disabled = false;
          }, 2000);
        })
        .catch(function (err) {
          logErr(err);
          resetBtn.disabled = false;
        });
    });
    container.appendChild(resetBtn);

    return container;
  }

  // =========================================================================
  // Feed screen
  // =========================================================================

  function mountFeedScreen(app) {
    var pool = app.pool.filter(function (s) {
      return poolMatchesChip(app, s, app.feedChipId);
    });
    if (app.config.settings.landscapeClips === "hide") {
      pool = pool.filter(function (s) {
        return !isLandscape(s);
      });
    }

    var seedScene = app.feedSeedSceneId
      ? pool.filter(function (s) {
          return s.id === app.feedSeedSceneId;
        })[0]
      : null;
    var built = buildInitialFeedOrder(app, pool, seedScene);

    var state = {
      app: app,
      chipId: app.feedChipId,
      scenes: built.order,
      fastOrderBoundary: built.fastOrderBoundary,
      slideEls: [],
      videos: app.videos, // 3 reused <video> elements, created once per app mount
      currentIndex: 0,
      unmuted: !!app.unmuted,
      soundUnlocked: !!app.soundUnlocked,
      observer: null,
      keyHandler: null,
      popstateHandler: null,
      historyEntryOpen: false,
      progressRafId: null,
      progressDragging: false,
      disposed: false,
      hidden: false,
      muteBtn: null,
      seenTimer: null,
      playTimer: null,
      debugTimer: null,
      newlySeenCount: 0,
      lastAction: null,
      pendingToastMessage: null,
      toastEl: null,
      toastTimeoutId: null,
    };

    app.root.className = "reels-overlay";
    document.documentElement.classList.add("reels-html-lock");

    enterFeedHistory(state);
    state.popstateHandler = function () {
      if (state.disposed || state.hidden) return;
      hideFeedScreen(state);
      setScreen(app, "start");
      if (state.pendingToastMessage) {
        var pendingMessage = state.pendingToastMessage;
        state.pendingToastMessage = null;
        showUndoToast(state, pendingMessage);
      }
    };
    window.addEventListener("popstate", state.popstateHandler);

    // Everything the feed screen puts on screen lives inside one container
    // so the whole subtree (DOM nodes, playing <video> elements, listeners)
    // can be detached and reattached as a unit when the user leaves/returns
    // to /reels without destroying the feed -- see hideFeedScreen /
    // showFeedScreenExisting.
    var container = el("div", "reels-feed-container");
    state.containerEl = container;

    if (app.config.settings.showDebugInfo) {
      var versionBadge = el("div", "reels-feed-version", "Reels v" + REELS_VERSION);
      container.appendChild(versionBadge);
    }

    var backBtn = el("button", "reels-feed-back", "←");
    backBtn.setAttribute("aria-label", "Back");
    backBtn.addEventListener("click", function () {
      closeFeed(app, state);
    });
    container.appendChild(backBtn);

    var dislikeBtn = el("button", "reels-dislike-btn", "👎");
    dislikeBtn.setAttribute("aria-label", "Dislike");
    dislikeBtn.addEventListener("click", function () {
      dislike(app, state);
    });
    container.appendChild(dislikeBtn);

    var openLink = el("a", "reels-open-btn", "↗");
    openLink.setAttribute("aria-label", "Open in Stash");
    openLink.setAttribute("title", "Open in Stash");
    openLink.href = "/scenes";
    openLink.addEventListener("pointerdown", function () {
      updateOpenLink(state);
    });
    openLink.addEventListener("focus", function () {
      updateOpenLink(state);
    });
    openLink.addEventListener("click", function (e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // new tab/window: browser handles it
      e.preventDefault();
      updateOpenLink(state);
      var slide = state.slideEls[state.currentIndex];
      if (!slide) return;
      leaveFeedForLink(state, openLink.getAttribute("href"));
    });
    container.appendChild(openLink);
    state.openLink = openLink;

    var muteBtn = el("button", "reels-mute-btn", state.unmuted ? "🔊" : "🔇");
    muteBtn.setAttribute("aria-label", "Mute / unmute");
    muteBtn.addEventListener("click", function () {
      toggleFeedMute(state);
    });
    container.appendChild(muteBtn);
    state.muteBtn = muteBtn;

    var feed = el("div", "reels-feed");
    container.appendChild(feed);
    state.feedEl = feed;

    app.root.appendChild(container);

    state.videos.forEach(function (v) {
      v.loop = app.config.settings.endOfClip === "loop";
      v.preload = "metadata";
    });

    state.scenes.forEach(function (scene) {
      var slide = buildFeedSlide(app, scene, state);
      feed.appendChild(slide.el);
      state.slideEls.push(slide);
    });

    assignVideosToWindow(state);
    warmupFreeVideos(state);
    if (state.slideEls.length) onBecameCurrent(state, state.slideEls[0]);

    state.observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var index = state.slideEls.findIndex(function (s) {
            return s.el === entry.target;
          });
          if (index === -1) return;

          if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
            if (state.currentIndex !== index) {
              state.currentIndex = index;
              assignVideosToWindow(state);
              onBecameCurrent(state, state.slideEls[index]);
            }
          }
        });
      },
      { threshold: [0, 0.6] }
    );
    state.slideEls.forEach(function (s) {
      state.observer.observe(s.el);
    });

    state.keyHandler = function (e) {
      if (state.hidden) return; // feed is live but not the visible screen
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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
        scrollToIndex(state, state.currentIndex + 1);
      } else if (lowerKey === "arrowup" || lowerKey === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        scrollToIndex(state, state.currentIndex - 1);
      } else if (key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleCurrentPlayback(state);
      } else if (lowerKey === "m") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleFeedMute(state);
      } else if (lowerKey === "l") {
        e.preventDefault();
        e.stopImmediatePropagation();
        var currentSlide = state.slideEls[state.currentIndex];
        if (currentSlide) like(app, state, currentSlide);
      } else if (lowerKey === "d") {
        e.preventDefault();
        e.stopImmediatePropagation();
        dislike(app, state);
      } else if (lowerKey === "u") {
        e.preventDefault();
        e.stopImmediatePropagation();
        undoLastAction(app, state);
      } else if (lowerKey === "escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeFeed(app, state);
      }
    };
    document.addEventListener("keydown", state.keyHandler, true);

    maybeShowHint(app);

    startProgressLoop(state);
    startDebugTimer(state);

    app._feedState = state;
  }

  // Pushes the #feed history entry -- called both when the feed is first
  // built and every time an already-live feed is redisplayed (resume, or
  // jumping to a cover), so the back arrow / Esc / a real browser back
  // press always has exactly one entry to pop.
  function enterFeedHistory(state) {
    state.historyEntryOpen = true;
    history.pushState({ reelsFeed: true }, "", location.pathname + location.search + "#feed");
  }

  // Pops the history entry pushed when the feed opened (which drives the
  // actual close via the popstate handler above) so the back arrow/Esc and
  // a real browser back press go through the exact same close path and
  // never leave a stray entry behind.
  function closeFeed(app, state) {
    if (state.disposed) return;
    if (state.historyEntryOpen) {
      state.historyEntryOpen = false;
      history.back();
    } else {
      hideFeedScreen(state);
      setScreen(app, "start");
    }
  }

  // Leaving the feed for the start/review/settings screens while staying
  // on /reels: pause playback and stop the feed's timers/loops, but keep
  // every slide, scene order and the pool <video> elements exactly as they
  // are so re-entering (same chip) resumes instantly instead of rebuilding.
  function hideFeedScreen(state) {
    if (state.hidden) return;
    state.hidden = true;
    state.historyEntryOpen = false;
    state.videos.forEach(function (v) {
      v.pause();
    });
    stopProgressLoop(state);
    stopDebugTimer(state);
    clearTimeout(state.seenTimer);
    clearTimeout(state.playTimer);
    clearUndoToast(state);
    persistCycle(state.app);
  }

  // Counterpart to hideFeedScreen, called from render() when the feed
  // screen is requested and a live (not disposed) state already exists for
  // the current chip -- reattaches the whole feed subtree as-is and
  // resumes where the user left off.
  function showFeedScreenExisting(app, state) {
    state.hidden = false;
    app.root.appendChild(state.containerEl);
    // Reattaching resets the feed's scrollTop to 0; restore it before
    // anything (the IntersectionObserver included) reads the position.
    state.feedEl.scrollTop = state.currentIndex * state.feedEl.clientHeight;
    enterFeedHistory(state);
    startProgressLoop(state);
    startDebugTimer(state);
    var currentSlide = state.slideEls[state.currentIndex];
    onBecameCurrent(state, currentSlide);
    attemptPlayCurrent(currentSlide, state);
  }

  // Re-reads the clip the feed resumed on, so edits made in Stash (tags,
  // performers, studio) show in the overlay. A clip that no longer belongs in
  // the pool is dropped and the feed moves on to the next one.
  function refreshResumedScene(app, state) {
    var slide = state.slideEls[state.currentIndex];
    if (!slide) return;
    var sceneId = slide.scene.id;
    gql(SCENE_REFRESH_QUERY, { id: sceneId })
      .then(function (data) {
        if (state.disposed || state.hidden) return;
        var fresh = data.findScene;
        var idx = -1;
        for (var i = 0; i < state.scenes.length; i++) {
          if (state.scenes[i].id === sceneId) {
            idx = i;
            break;
          }
        }
        if (idx === -1 || idx < state.currentIndex) return;

        var inPool =
          fresh &&
          sceneHasTag(fresh, app.tags.pool) &&
          !sceneHasTag(fresh, app.tags.deleted) &&
          !sceneHasTag(fresh, app.tags.unplayable);

        if (!inPool) {
          app.pool = app.pool.filter(function (s) {
            return s.id !== sceneId;
          });
          removeSlideAt(state, idx, null);
          return;
        }

        app.pool = app.pool.map(function (s) {
          return s.id === sceneId ? fresh : s;
        });
        state.scenes[idx] = fresh;
        state.slideEls[idx].scene = fresh;
        populateSlide(app, state.slideEls[idx], state);
        updateOpenLink(state);
      })
      .catch(logErr);
  }

  // Called when the /reels route unmounts: the app, its feed and its three
  // <video> elements stay alive (module scope) but go quiet.
  function suspendApp(app) {
    if (app._feedState && !app._feedState.disposed) hideFeedScreen(app._feedState);
    app.videos.forEach(function (v) {
      v.pause();
    });
  }

  // Called when /reels mounts again with a persisted app.
  function resumeApp(app) {
    render(app);
    var state = app._feedState;
    if (app.screen === "feed" && state && !state.disposed) refreshResumedScene(app, state);

    // Background refresh of the pool and candidates (the pool is reshuffled
    // once, as always). Only the start screen is redrawn; a live feed is
    // left alone and the new pool is used at its next rebuild.
    refetchPoolAndCandidates(app)
      .then(function () {
        if (app.screen === "start" && app.root.isConnected) render(app);
      })
      .catch(logErr);
  }

  // Full teardown: only when a chip change / Shuffle / review confirm /
  // settings save invalidates the feed and the next startFeed() needs to
  // build a fresh one.
  function unmountFeedScreen(state) {
    state.disposed = true;
    state.hidden = true;
    if (state.observer) state.observer.disconnect();
    document.removeEventListener("keydown", state.keyHandler, true);
    if (state.popstateHandler) window.removeEventListener("popstate", state.popstateHandler);
    stopProgressLoop(state);
    stopDebugTimer(state);
    clearTimeout(state.seenTimer);
    clearTimeout(state.playTimer);
    clearUndoToast(state);
    persistCycle(state.app);
    if (state.containerEl && state.containerEl.parentNode) {
      state.containerEl.parentNode.removeChild(state.containerEl);
    }
    state.videos.forEach(function (v) {
      v._reelsSlide = null;
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
  }

  // --- Debug info live refresh (sound diagnosis) --------------------------

  function startDebugTimer(state) {
    if (!state.app.config.settings.showDebugInfo) return;
    stopDebugTimer(state);
    state.debugTimer = setInterval(function () {
      updateDebugLabel(state);
    }, 500);
  }

  function stopDebugTimer(state) {
    if (state.debugTimer) {
      clearInterval(state.debugTimer);
      state.debugTimer = null;
    }
  }

  function audioIndicator(video) {
    if (typeof video.webkitAudioDecodedByteCount === "number") {
      return "decodedBytes:" + video.webkitAudioDecodedByteCount;
    }
    if (video.audioTracks) {
      return "audioTracks:" + video.audioTracks.length;
    }
    return "?";
  }

  function updateDebugLabel(state) {
    var slide = state.slideEls[state.currentIndex];
    if (!slide || !slide.el) return;
    var label = slide.el.querySelector(".reels-debug-label");
    if (!label) return;
    var video = slide.video;
    var baseText = label.dataset.baseText || label.textContent;
    if (!video) {
      label.textContent = baseText;
      return;
    }
    label.textContent =
      baseText +
      " | " + (video._reelsLetter || "?") +
      " muted:" + video.muted +
      " vol:" + video.volume +
      " paused:" + video.paused +
      " audio:" + audioIndicator(video);
  }

  function currentCodecKey(scene) {
    var f = sceneFile(scene);
    return f ? f.video_codec : "";
  }

  // Appends ".mp4" before any query string on the stream URL, so a URL
  // like ".../stream?apikey=..." becomes ".../stream.mp4?apikey=..."
  // rather than ".../stream?apikey=....mp4".
  function toTranscodeUrl(streamUrl) {
    var qIndex = streamUrl.indexOf("?");
    if (qIndex === -1) return streamUrl + ".mp4";
    return streamUrl.slice(0, qIndex) + ".mp4" + streamUrl.slice(qIndex);
  }

  function streamUrlForScene(app, scene) {
    var codec = currentCodecKey(scene);
    if (app.codecNeedsTranscode[codec]) {
      return toTranscodeUrl(scene.paths.stream);
    }
    return scene.paths.stream;
  }

  // Builds only the empty shell: a snap-target div the IntersectionObserver
  // can watch. Its visible content (poster, overlay, progress bar) is
  // filled in lazily by populateSlide, via populateDirtySlidesNear, once
  // the slide comes within currentIndex +/- 3 -- building full content for
  // all ~2,300 slides up front is what made the feed slow to open.
  function buildFeedSlide(app, scene, state) {
    var slide = {
      scene: scene,
      el: el("div", "reels-slide"),
      video: null,
      expanded: false,
      dirty: true,
    };
    slide.el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });
    attachTapHandler(slide, state);
    return slide;
  }

  // (Re)builds a slide's visible content for its current `slide.scene`.
  // Used for the initial lazy build, when re-sampling the upcoming order
  // after a like/dislike, and when topping up the fast-sampled tail.
  //
  // A slide can still be holding one of the 3 pool <video> elements when
  // this runs (e.g. a neighbour slide marked dirty by reorderUpcoming
  // while it's within the currentIndex +/- 1 video window). clear() would
  // otherwise rip that <video> out of the DOM without clearing its
  // `_reelsSlide` back-reference, permanently stranding it: the pool drops
  // to 2 working videos and whichever slide owned it goes silently blank.
  // Detach it first and reattach it once the rest of the slide is rebuilt.
  function populateSlide(app, slide, state) {
    var scene = slide.scene;
    var attachedVideo = slide.video;
    if (attachedVideo && attachedVideo.parentNode === slide.el) {
      slide.el.removeChild(attachedVideo);
    }
    clear(slide.el);
    slide.el.className = "reels-slide";
    slide.video = null;
    slide.errorLabel = null;
    slide.convertingLabel = null;
    slide.tapHint = null;
    slide.needsSoundRetry = false;
    slide.progressFill = null;

    var landscape = isLandscape(scene);
    var fitClass;
    if (landscape && app.config.settings.landscapeClips === "crop") {
      fitClass = "reels-fit-crop";
    } else if (landscape) {
      // "blur" (default): always contain, with a blurred backdrop below.
      fitClass = "reels-fit-contain";
    } else {
      fitClass =
        app.config.settings.fit === "fill"
          ? "reels-fit-fill"
          : app.config.settings.fit === "crop"
          ? "reels-fit-crop"
          : "reels-fit-contain";
    }
    slide.el.classList.add(fitClass);

    if (landscape && app.config.settings.landscapeClips === "blur") {
      slide.el.classList.add("reels-landscape-blur");
      var bg = el("div", "reels-landscape-bg");
      bg.style.backgroundImage = "url('" + (scene.paths.screenshot || "") + "')";
      slide.el.appendChild(bg);
    }

    var poster = document.createElement("img");
    poster.className = "reels-poster";
    poster.loading = "lazy";
    poster.decoding = "async";
    poster.src = scene.paths.screenshot || "";
    slide.el.appendChild(poster);
    slide.poster = poster;

    slide.el.appendChild(buildOverlay(app, scene, slide, state));
    slide.el.appendChild(buildProgressBar(slide, state));

    if (attachedVideo) {
      slide.el.insertBefore(attachedVideo, slide.el.firstChild);
      slide.video = attachedVideo;
      poster.style.display = "none";
    }
  }

  function buildOverlay(app, scene, slide, state) {
    var overlay = el("div", "reels-slide-overlay");

    if (sceneHasTag(scene, app.tags.liked)) {
      overlay.appendChild(buildLikedBadge(app, state, slide));
    }

    var performers = scene.performers || [];
    if (performers.length) {
      var perfRow = el("div", "reels-performers");
      performers.forEach(function (p, i) {
        if (i > 0) perfRow.appendChild(document.createTextNode(", "));
        var a = document.createElement("a");
        a.href = "/performers/" + p.id;
        a.textContent = p.name;
        a.addEventListener("click", function (e) {
          e.stopPropagation();
          e.preventDefault();
          leaveFeedForLink(state, "/performers/" + p.id);
        });
        perfRow.appendChild(a);
      });
      overlay.appendChild(perfRow);
    }

    if (scene.studio && scene.studio.image_path) {
      var studioLink = document.createElement("a");
      studioLink.className = "reels-studio-badge";
      studioLink.href = "/studios/" + scene.studio.id;
      studioLink.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        leaveFeedForLink(state, "/studios/" + scene.studio.id);
      });
      var studioImg = document.createElement("img");
      studioImg.src = scene.studio.image_path;
      studioLink.appendChild(studioImg);
      overlay.appendChild(studioLink);
    }

    var tags = visibleHashtags(app, scene);
    if (tags.length) {
      var hashtagsEl = el("div", "reels-hashtags reels-hashtags-clipped");
      var text = tags
        .map(function (t) {
          return "#" + t.name;
        })
        .join(" ");
      hashtagsEl.textContent = text;
      hashtagsEl.addEventListener("click", function (e) {
        e.stopPropagation();
        slide.expanded = !slide.expanded;
        hashtagsEl.classList.toggle("reels-hashtags-clipped", !slide.expanded);
      });
      overlay.appendChild(hashtagsEl);
    }

    if (app.config.settings.showDebugInfo) {
      var file = sceneFile(scene);
      var baseText =
        "id:" + scene.id + " " + (file ? file.video_codec || "?" : "?") + " " + (file ? file.width + "x" + file.height : "?x?");
      var debugLabel = el("div", "reels-debug-label", baseText);
      debugLabel.dataset.baseText = baseText;
      overlay.appendChild(debugLabel);
    }

    return overlay;
  }

  // Keeps 3 reused <video> elements assigned to the current slide and its
  // immediate neighbours. A video already showing a slide that is still in
  // the window is left completely untouched (no src change, no DOM move,
  // no pause) so the currently-playing element is never disturbed; only a
  // video whose slide has left the window is freed and moved to whichever
  // new slide just entered it.
  function assignVideosToWindow(state) {
    populateDirtySlidesNear(state);
    topUpFastOrder(state);
    var app = state.app;
    var desiredSlides = [
      state.slideEls[state.currentIndex - 1],
      state.slideEls[state.currentIndex],
      state.slideEls[state.currentIndex + 1],
    ].filter(function (s) {
      return !!s;
    });

    var freeVideos = state.videos.filter(function (v) {
      return !v._reelsSlide || desiredSlides.indexOf(v._reelsSlide) === -1;
    });

    desiredSlides.forEach(function (slide) {
      var alreadyPlaced = state.videos.some(function (v) {
        return v._reelsSlide === slide;
      });
      if (alreadyPlaced) return;

      var video = freeVideos.shift();
      if (!video) return; // should not happen: 3 videos for up to 3 slots

      if (video._reelsSlide) {
        video._reelsSlide.poster.style.display = "";
        video._reelsSlide.video = null;
      }
      if (video.parentNode) video.parentNode.removeChild(video);

      var codec = currentCodecKey(slide.scene);
      video.pause();
      video.src = streamUrlForScene(app, slide.scene);
      video.poster = slide.scene.paths.screenshot || "";
      video._reelsSlide = slide;
      video._reelsOnTranscode = !!app.codecNeedsTranscode[codec];
      setVideoMuted(video, !state.unmuted, slide.scene, "assign");
      video.loop = app.config.settings.endOfClip === "loop";
      attachVideoHandlers(video, slide, state);

      slide.video = video;
      slide.el.insertBefore(video, slide.el.firstChild);
    });

    freeVideos.forEach(function (video) {
      if (video._reelsSlide) {
        video._reelsSlide.poster.style.display = "";
        video._reelsSlide.video = null;
      }
      video._reelsSlide = null;
      if (video.parentNode) video.parentNode.removeChild(video);
      video.pause();
      video.preload = "metadata";
    });

    var currentSlide = state.slideEls[state.currentIndex];
    state.videos.forEach(function (video) {
      if (!video._reelsSlide) return;
      if (video._reelsSlide === currentSlide) {
        video.preload = "auto";
        attemptPlayCurrent(currentSlide, state);
      } else {
        video.preload = "metadata";
        video.pause();
        video.playbackRate = 1;
        try {
          video.currentTime = 0;
        } catch (e) {}
      }
    });
  }

  function warmupFreeVideos(state) {
    var fallback = state.scenes[state.currentIndex] || state.scenes[0];
    if (!fallback) return;
    state.videos.forEach(function (video) {
      if (video._reelsSlide || video.hasAttribute("src")) return;
      var codec = currentCodecKey(fallback);
      video.muted = true;
      video.preload = "metadata";
      video.src = streamUrlForScene(state.app, fallback);
      video._reelsOnTranscode = !!state.app.codecNeedsTranscode[codec];
    });
  }

  function attachVideoHandlers(video, slide, state) {
    video.onplaying = function () {
      hideConverting(slide);
      slide.poster.style.display = "none";
    };

    video.onended = function () {
      if (state.app.config.settings.endOfClip === "advance" && slide === state.slideEls[state.currentIndex]) {
        scrollToIndex(state, state.currentIndex + 1);
      }
    };

    video.onerror = function () {
      var err = video.error;
      var code = err ? err.code : 0;
      if (code !== 3 && code !== 4) return;

      var app = state.app;
      var codec = currentCodecKey(slide.scene);

      if (!video._reelsOnTranscode) {
        app.codecNeedsTranscode[codec] = true;
        video._reelsOnTranscode = true;
        showConverting(slide);
        video.src = toTranscodeUrl(slide.scene.paths.stream);
        video.load();
        if (slide === state.slideEls[state.currentIndex]) {
          attemptPlayCurrent(slide, state);
        }
        return;
      }

      // Transcode URL also failed: only now, and only if the setting is
      // on, tag it unplayable and drop it from the pool for good.
      hideConverting(slide);
      console.error(
        "Reels: scene " + slide.scene.id + " unplayable even after transcode retry (codec " + codec + ")."
      );
      showSlideError(slide, code);
      if (app.config.settings.tagUnplayable) {
        bulkUpdateTag([slide.scene.id], app.tags.unplayable, "ADD").catch(function (err) {
          handleTagWriteFailure(app, err);
        });
        app.pool = app.pool.filter(function (s) {
          return s.id !== slide.scene.id;
        });
      }
      if (slide === state.slideEls[state.currentIndex]) {
        var idx = state.slideEls.indexOf(slide);
        if (idx !== -1) removeSlideAt(state, idx);
      }
    };
  }

  function showConverting(slide) {
    if (slide.convertingLabel) return;
    var label = el("div", "reels-converting-label", "Converting…");
    slide.el.appendChild(label);
    slide.convertingLabel = label;
  }

  function hideConverting(slide) {
    if (slide.convertingLabel) {
      slide.convertingLabel.remove();
      slide.convertingLabel = null;
    }
  }

  function showSlideError(slide, code) {
    if (slide.errorLabel) return;
    var label = el("div", "reels-error-label", "Can't play (code " + code + ")");
    slide.el.appendChild(label);
    slide.errorLabel = label;
  }

  function showTapForSound(slide) {
    slide.needsSoundRetry = true;
    if (slide.tapHint) return;
    var hint = el("div", "reels-tap-hint", "Tap for sound");
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

  function buildLikedBadge(app, state, slide) {
    var badge = el("button", "reels-liked-badge", "♥");
    badge.setAttribute("aria-label", "Unlike");
    badge.addEventListener("click", function (e) {
      e.stopPropagation();
      e.preventDefault();
      unlikeFromFeed(app, state, slide);
    });
    return badge;
  }

  // The scene file's own duration (from the pool query) as a fallback for
  // when video.duration isn't finite yet -- notably on transcode streams,
  // which also can't be seeked at all.
  function progressDuration(slide) {
    var video = slide.video;
    if (video && isFinite(video.duration) && video.duration > 0) return video.duration;
    var file = sceneFile(slide.scene);
    return file && file.duration ? file.duration : 0;
  }

  // Thin seek bar along the bottom edge of the slide. The fill itself is
  // only ever written by startProgressLoop's single rAF loop (for whichever
  // slide is current); this builder only wires up the drag-to-seek hit
  // area, which doubles its 3px track to a ~24px touch target.
  function buildProgressBar(slide, state) {
    var hit = el("div", "reels-progress-hit");
    var track = el("div", "reels-progress-track");
    var fill = el("div", "reels-progress-fill");
    track.appendChild(fill);
    hit.appendChild(track);
    slide.progressFill = fill;

    var dragging = false;

    function seekFromClientX(clientX) {
      var video = slide.video;
      if (!video) return;
      var duration = progressDuration(slide);
      if (!duration) return;
      var rect = hit.getBoundingClientRect();
      var ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      video.currentTime = ratio * duration;
      fill.style.width = ratio * 100 + "%";
    }

    hit.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      // Transcode streams can't be seeked -- leave the fill alone (the rAF
      // loop keeps updating it) and don't start a drag at all.
      if (slide.video && slide.video._reelsOnTranscode) return;
      dragging = true;
      state.progressDragging = true;
      try {
        hit.setPointerCapture(e.pointerId);
      } catch (err) {}
      seekFromClientX(e.clientX);
    });
    hit.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      seekFromClientX(e.clientX);
      e.stopPropagation();
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      state.progressDragging = false;
      e.stopPropagation();
    }
    hit.addEventListener("pointerup", endDrag);
    hit.addEventListener("pointercancel", endDrag);

    return hit;
  }

  function startProgressLoop(state) {
    function tick() {
      var slide = state.slideEls[state.currentIndex];
      if (slide && slide.video && slide.progressFill && !state.progressDragging) {
        var duration = progressDuration(slide);
        if (duration) {
          var ratio = clamp(slide.video.currentTime / duration, 0, 1);
          slide.progressFill.style.width = ratio * 100 + "%";
        }
      }
      state.progressRafId = requestAnimationFrame(tick);
    }
    state.progressRafId = requestAnimationFrame(tick);
  }

  function stopProgressLoop(state) {
    if (state.progressRafId) {
      cancelAnimationFrame(state.progressRafId);
      state.progressRafId = null;
    }
  }

  // Populates any slide marked dirty by reorderUpcoming once it comes
  // within currentIndex +/- 3, instead of rebuilding the whole re-sampled
  // tail (up to ~175 slides) in one go.
  function populateDirtySlidesNear(state) {
    var lo = Math.max(0, state.currentIndex - 3);
    var hi = Math.min(state.slideEls.length - 1, state.currentIndex + 3);
    for (var i = lo; i <= hi; i++) {
      var slide = state.slideEls[i];
      if (slide && slide.dirty) {
        populateSlide(state.app, slide, state);
        slide.dirty = false;
      }
    }
  }

  function attemptPlayCurrent(slide, state) {
    if (!slide || !slide.video) return;
    hideTapForSound(slide);
    var letter = slide.video._reelsLetter || "?";
    setVideoMuted(slide.video, !state.unmuted, slide.scene, "attemptPlay");
    var playPromise = slide.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(function (err) {
        if (
          state.unmuted &&
          err &&
          err.name === "NotAllowedError" &&
          slide === state.slideEls[state.currentIndex]
        ) {
          console.warn(
            "Reels: unmuted play rejected (scene " + slide.scene.id + ", element " + letter + "), falling back to muted.",
            err
          );
          setVideoMuted(slide.video, true, slide.scene, "fallback-after-rejected-unmuted-play");
          var retry = slide.video.play();
          if (retry && typeof retry.catch === "function") {
            retry.catch(function (err2) {
              console.warn(
                "Reels: fallback muted play also rejected (scene " + slide.scene.id + ", element " + letter + ").",
                err2
              );
            });
          }
          showTapForSound(slide);
        } else {
          console.warn("Reels: play rejected (scene " + slide.scene.id + ", element " + letter + ").", err);
        }
      });
    }
  }

  function toggleCurrentPlayback(state) {
    var slide = state.slideEls[state.currentIndex];
    if (!slide || !slide.video) return;
    if (slide.video.paused) {
      attemptPlayCurrent(slide, state);
    } else {
      slide.video.pause();
    }
  }

  function unlockSound(state) {
    state.unmuted = true;
    state.soundUnlocked = true;
    state.app.unmuted = true;
    state.app.soundUnlocked = true;
    var currentVideo = state.slideEls[state.currentIndex] && state.slideEls[state.currentIndex].video;
    state.videos.forEach(function (v) {
      if (!v.hasAttribute("src")) return;
      var scene = v._reelsSlide ? v._reelsSlide.scene : null;
      setVideoMuted(v, false, scene, "unlock");
      var p = v.play();
      if (p && typeof p.catch === "function") {
        p.catch(function (err) {
          console.warn("Reels: unlock play rejected (scene " + (scene ? scene.id : "?") + ", element " + (v._reelsLetter || "?") + ").", err);
        });
      }
    });
    state.videos.forEach(function (v) {
      if (v === currentVideo) return;
      v.pause();
      try {
        v.currentTime = 0;
      } catch (e) {}
    });
  }

  function toggleFeedMute(state) {
    if (!state.unmuted) {
      unlockSound(state);
    } else {
      state.unmuted = false;
      state.app.unmuted = false;
      state.videos.forEach(function (v) {
        setVideoMuted(v, true, v._reelsSlide ? v._reelsSlide.scene : null, "toggle-mute-on");
      });
    }
    if (state.muteBtn) {
      state.muteBtn.textContent = state.unmuted ? "🔊" : "🔇";
    }
  }

  function scrollToIndex(state, index) {
    if (index < 0 || index >= state.slideEls.length) return;
    state.slideEls[index].el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --- Seen / play-count tracking -----------------------------------------

  // Stash's scene page reads ?t=SECONDS as the initial playback position.
  function updateOpenLink(state) {
    var slide = state.slideEls[state.currentIndex];
    if (!slide || !state.openLink) return;
    var href = "/scenes/" + slide.scene.id;
    var t = slide.video && slide.video.currentTime ? Math.floor(slide.video.currentTime) : 0;
    if (t > 0) href += "?t=" + t;
    state.openLink.setAttribute("href", href);
  }

  function onBecameCurrent(state, slide) {
    updateOpenLink(state);
    clearTimeout(state.seenTimer);
    clearTimeout(state.playTimer);
    if (!slide) return;
    state.seenTimer = setTimeout(function () {
      if (!state.disposed) markSeen(state, slide.scene);
    }, SEEN_AFTER_MS);
    state.playTimer = setTimeout(function () {
      if (!state.disposed) maybeCountPlay(state, slide.scene);
    }, PLAY_COUNT_AFTER_MS);
  }

  function markSeen(state, scene) {
    var cycle = state.app.config.cycle;
    if (cycle.seen.indexOf(scene.id) !== -1) return;
    cycle.seen.push(scene.id);
    state.newlySeenCount++;

    var poolIds = state.app.pool.map(function (s) {
      return s.id;
    });
    var allSeen = poolIds.length > 0 && poolIds.every(function (id) {
      return cycle.seen.indexOf(id) !== -1;
    });
    if (allSeen) cycle.seen = [];

    if (state.newlySeenCount >= 5) {
      state.newlySeenCount = 0;
      persistCycle(state.app);
    }
  }

  function persistCycle(app) {
    writeConfig({ cycle: app.config.cycle }).catch(logErr);
  }

  function maybeCountPlay(state, scene) {
    var app = state.app;
    if (!app.config.settings.countPlays) return;
    if (app.playCountedIds[scene.id]) return;
    app.playCountedIds[scene.id] = true;
    gql(SCENE_ADD_PLAY_MUTATION, { id: scene.id }).catch(logErr);
  }

  // --- Like / dislike / undo ------------------------------------------------

  function showHeartBurst(slide) {
    var burst = el("div", "reels-heart-burst", "♥");
    slide.el.appendChild(burst);
    setTimeout(function () {
      burst.remove();
    }, 800);
  }

  function refreshLikedBadge(app, state, slide) {
    var existing = slide.el.querySelector(".reels-liked-badge");
    if (existing) existing.remove();
    if (sceneHasTag(slide.scene, app.tags.liked)) {
      var overlay = slide.el.querySelector(".reels-slide-overlay");
      if (overlay) overlay.insertBefore(buildLikedBadge(app, state, slide), overlay.firstChild);
    }
  }

  function like(app, state, slide) {
    var scene = slide.scene;
    if (sceneHasTag(scene, app.tags.liked)) return; // already liked, no-op

    scene.tags = (scene.tags || []).concat([{ id: app.tags.liked, name: TAG_NAMES.liked }]);
    bulkUpdateTag([scene.id], app.tags.liked, "ADD").catch(function (err) {
      handleTagWriteFailure(app, err);
    });
    applyScoreDelta(app, scene, 1);
    showHeartBurst(slide);
    refreshLikedBadge(app, state, slide);

    state.lastAction = { type: "like", scene: scene, delta: 1 };
    showUndoToast(state, "Liked");
    deferReorderUpcoming(app, state);
  }

  // Unliking the small heart badge inside the feed itself -- same undo
  // toast/undo path as a like, just the reverse tag write and score delta.
  function unlikeFromFeed(app, state, slide) {
    var scene = slide.scene;
    if (!sceneHasTag(scene, app.tags.liked)) return;

    scene.tags = scene.tags.filter(function (t) {
      return t.id !== app.tags.liked;
    });
    bulkUpdateTag([scene.id], app.tags.liked, "REMOVE").catch(function (err) {
      handleTagWriteFailure(app, err);
    });
    applyScoreDelta(app, scene, -1);
    refreshLikedBadge(app, state, slide);

    state.lastAction = { type: "unlike", scene: scene, delta: -1 };
    showUndoToast(state, "Unliked");
    deferReorderUpcoming(app, state);
  }

  function dislike(app, state) {
    var slide = state.slideEls[state.currentIndex];
    if (!slide) return;
    var scene = slide.scene;
    var wasLiked = sceneHasTag(scene, app.tags.liked);
    var idx = state.currentIndex;

    // Queued in this order: ADD zzz-reels-delete first, then one REMOVE
    // covering both Reels and (if liked) Reels-liked.
    bulkUpdateTag([scene.id], app.tags.deleted, "ADD").catch(function (err) {
      handleTagWriteFailure(app, err);
    });
    var removeIds = wasLiked ? [app.tags.pool, app.tags.liked] : [app.tags.pool];
    bulkUpdateTag([scene.id], removeIds, "REMOVE").catch(function (err) {
      handleTagWriteFailure(app, err);
    });

    if (wasLiked) applyScoreDelta(app, scene, -1); // reverse the earlier like
    applyScoreDelta(app, scene, -1); // the dislike itself

    app.pool = app.pool.filter(function (s) {
      return s.id !== scene.id;
    });

    // removeSlideAt shows the undo toast itself once it knows whether the
    // feed stayed open or had to close (closing is async -- see closeFeed
    // -- so a toast appended here could get wiped by the start screen's
    // render before the close actually happens).
    removeSlideAt(state, idx, {
      message: "Marked for deletion",
      action: { type: "dislike", scene: scene, wasLiked: wasLiked },
    });

    deferReorderUpcoming(app, state);
  }

  function undoLastAction(app, state) {
    var action = state.lastAction;
    if (!action) return;
    clearUndoToast(state);
    state.lastAction = null;
    var scene = action.scene;

    if (action.type === "like") {
      scene.tags = (scene.tags || []).filter(function (t) {
        return t.id !== app.tags.liked;
      });
      bulkUpdateTag([scene.id], app.tags.liked, "REMOVE").catch(function (err) {
        handleTagWriteFailure(app, err);
      });
      applyScoreDelta(app, scene, -action.delta);
      var slide = state.slideEls.filter(function (s) {
        return s.scene === scene;
      })[0];
      if (slide) refreshLikedBadge(app, state, slide);
    } else if (action.type === "unlike") {
      scene.tags = (scene.tags || []).concat([{ id: app.tags.liked, name: TAG_NAMES.liked }]);
      bulkUpdateTag([scene.id], app.tags.liked, "ADD").catch(function (err) {
        handleTagWriteFailure(app, err);
      });
      applyScoreDelta(app, scene, -action.delta); // delta is -1, so this adds the 1 back
      var unlikedSlide = state.slideEls.filter(function (s) {
        return s.scene === scene;
      })[0];
      if (unlikedSlide) refreshLikedBadge(app, state, unlikedSlide);
    } else if (action.type === "dislike") {
      // Queued in this order: ADD Reels (and Reels-liked if it was
      // liked) first, then REMOVE zzz-reels-delete.
      var addIds = action.wasLiked ? [app.tags.pool, app.tags.liked] : [app.tags.pool];
      bulkUpdateTag([scene.id], addIds, "ADD").catch(function (err) {
        handleTagWriteFailure(app, err);
      });
      bulkUpdateTag([scene.id], app.tags.deleted, "REMOVE").catch(function (err) {
        handleTagWriteFailure(app, err);
      });
      if (action.wasLiked) applyScoreDelta(app, scene, 1);
      applyScoreDelta(app, scene, 1); // reverse the dislike's own -1

      app.pool.push(scene);
      if (state.disposed) {
        // The dislike emptied the feed entirely (it was the only slide),
        // which already sent us back to the start screen. There's no
        // feed to reinsert into -- just get the restored clip back into
        // the pool and let the start screen re-render with it.
        setScreen(app, "start");
      } else {
        // Always currentIndex + 1, never currentIndex itself, so the
        // clip actually being watched never moves or restarts.
        var insertIndex = Math.min(state.currentIndex + 1, state.slideEls.length);
        insertSlideAt(state, insertIndex, scene);
      }
    }
  }

  // A standalone toast (no Undo button, not tied to feed state) for
  // reporting a failed tag write anywhere in the plugin -- the start
  // screen and review grid have no feed `state` to hang an undo toast
  // off of, but `app.root` always exists while /reels is open.
  function showErrorToast(app, message) {
    var toast = el("div", "reels-toast reels-toast-error", message);
    app.root.appendChild(toast);
    setTimeout(function () {
      toast.remove();
    }, 4000);
  }

  function handleTagWriteFailure(app, err) {
    logErr(err);
    showErrorToast(app, "Couldn't save that change.");
  }

  function showUndoToast(state, message) {
    clearUndoToast(state);
    var toast = el("div", "reels-toast");
    toast.appendChild(el("span", "reels-toast-text", message));
    var undoBtn = el("button", "reels-toast-undo", "Undo");
    undoBtn.addEventListener("click", function () {
      undoLastAction(state.app, state);
    });
    toast.appendChild(undoBtn);
    state.app.root.appendChild(toast);
    state.toastEl = toast;
    // Two rAFs guarantee a frame has actually painted (the first fires
    // before paint, the second after) before the 5s countdown starts --
    // otherwise the toast could visually have had far less than 5s.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (state.toastEl !== toast) return;
        state.toastTimeoutId = setTimeout(function () {
          state.toastEl = null;
          state.toastTimeoutId = null;
          state.lastAction = null;
          toast.remove();
        }, UNDO_TOAST_MS);
      });
    });
  }

  function clearUndoToast(state) {
    if (state.toastTimeoutId) {
      clearTimeout(state.toastTimeoutId);
      state.toastTimeoutId = null;
    }
    if (state.toastEl) {
      state.toastEl.remove();
      state.toastEl = null;
    }
  }

  // Removes the slide at `idx` from the feed. Because every slide is the
  // same height, removing the DOM node at (or above) the current scroll
  // position leaves scrollTop numerically unchanged, which lands exactly
  // on the slide that used to be next -- no explicit scroll needed.
  function removeSlideAt(state, idx, pendingToast) {
    var slide = state.slideEls[idx];
    if (!slide) return;
    state.observer.unobserve(slide.el);
    if (slide.video) {
      slide.video._reelsSlide = null;
      slide.video = null;
    }
    slide.el.remove();
    state.slideEls.splice(idx, 1);
    state.scenes.splice(idx, 1);

    if (!state.slideEls.length) {
      if (pendingToast) {
        state.lastAction = pendingToast.action;
        state.pendingToastMessage = pendingToast.message;
      }
      closeFeed(state.app, state);
      return;
    }
    if (state.currentIndex >= state.slideEls.length) {
      state.currentIndex = state.slideEls.length - 1;
    }
    assignVideosToWindow(state);
    onBecameCurrent(state, state.slideEls[state.currentIndex]);
    if (pendingToast) {
      state.lastAction = pendingToast.action;
      showUndoToast(state, pendingToast.message);
    }
  }

  // Inserts `scene` as a new slide at `idx` (used by undo to put a
  // disliked clip back as "the next slide").
  function insertSlideAt(state, idx, scene) {
    var slide = buildFeedSlide(state.app, scene, state);
    var refEl = state.slideEls[idx] ? state.slideEls[idx].el : null;
    state.feedEl.insertBefore(slide.el, refEl);
    state.slideEls.splice(idx, 0, slide);
    state.scenes.splice(idx, 0, scene);
    state.observer.observe(slide.el);
    assignVideosToWindow(state);
  }

  // After a like/dislike, re-sample the order of everything beyond the
  // current slide and its two neighbours (the 3-video window), using the
  // freshly updated scores. Slide element identity and position are kept;
  // only which scene each one shows is swapped, so scroll-snap and the
  // IntersectionObserver are untouched.
  function reorderUpcoming(app, state, seedScene) {
    var tailStart = state.currentIndex + 2;
    if (tailStart >= state.slideEls.length) return;
    var tailScenes = state.scenes.slice(tailStart);
    var newOrder = buildFeedOrder(app, tailScenes, seedScene || null, true);
    for (var i = 0; i < newOrder.length; i++) {
      var slide = state.slideEls[tailStart + i];
      var changed = !slide.scene || slide.scene.id !== newOrder[i].id;
      slide.scene = newOrder[i];
      if (changed) slide.dirty = true;
      state.scenes[tailStart + i] = newOrder[i];
    }
    populateDirtySlidesNear(state);
  }

  // like()/dislike() want their visual feedback (heart burst, badge, toast)
  // to paint before the up-to-~175-slide re-sample runs, not after -- rAF
  // then a 0ms timeout lands this just after the next paint.
  function deferReorderUpcoming(app, state, seedScene) {
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (!state.disposed) reorderUpcoming(app, state, seedScene);
      }, 0);
    });
  }

  // --- Tap / double-tap / long-press / swipe disambiguation ---------------

  function attachTapHandler(slide, state) {
    var startX = 0;
    var startY = 0;
    var startTime = 0;
    var MOVE_THRESHOLD = 10;
    var longPressTimer = null;
    var isLongPress = false;
    var longPressSlowed = false;
    var tapTimer = null;
    var pendingTap = false;

    function clearLongPress() {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (longPressSlowed && slide.video) {
        slide.video.playbackRate = 1;
      }
      longPressSlowed = false;
      isLongPress = false;
    }

    slide.el.addEventListener("pointerdown", function (e) {
      if (e.target.closest && e.target.closest("a, button, .reels-hashtags, .reels-progress-hit")) return;
      startX = e.clientX;
      startY = e.clientY;
      startTime = Date.now();
      longPressTimer = setTimeout(function () {
        isLongPress = true;
        if (slide.video && !slide.video.paused) {
          slide.video.playbackRate = 2;
          longPressSlowed = true;
        }
      }, LONG_PRESS_MS);
    });

    slide.el.addEventListener("pointercancel", clearLongPress);
    slide.el.addEventListener("pointerleave", clearLongPress);

    slide.el.addEventListener("pointerup", function (e) {
      if (e.target.closest && e.target.closest("a, button, .reels-hashtags, .reels-progress-hit")) {
        return;
      }

      var wasLongPress = isLongPress;
      clearLongPress();

      var dx = Math.abs(e.clientX - startX);
      var dy = Math.abs(e.clientY - startY);
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) {
        return; // scroll/swipe, not a tap
      }
      if (wasLongPress) {
        return; // releasing a long-press is consumed, not a tap
      }

      if (!state.soundUnlocked) {
        unlockSound(state);
        if (state.muteBtn) state.muteBtn.textContent = "🔊";
        // Open the same double-tap window as a normal single tap: a
        // second tap within DOUBLE_TAP_MS likes the clip instead of
        // this unlock tap also toggling play/pause when its timer
        // elapses with nothing else having happened.
        pendingTap = true;
        tapTimer = setTimeout(function () {
          pendingTap = false;
        }, DOUBLE_TAP_MS);
        return;
      }

      if (slide.needsSoundRetry) {
        hideTapForSound(slide);
        setVideoMuted(slide.video, false, slide.scene, "tap-retry");
        var p = slide.video.play();
        if (p && typeof p.catch === "function") {
          p.catch(function (err) {
            console.warn("Reels: tap-retry play rejected (scene " + slide.scene.id + ", element " + (slide.video._reelsLetter || "?") + ").", err);
          });
        }
        return;
      }

      if (pendingTap) {
        pendingTap = false;
        clearTimeout(tapTimer);
        tapTimer = null;
        like(state.app, state, slide);
        return;
      }

      pendingTap = true;
      tapTimer = setTimeout(function () {
        pendingTap = false;
        if (slide.video) {
          if (slide.video.paused) {
            attemptPlayCurrent(slide, state);
          } else {
            slide.video.pause();
          }
        }
      }, DOUBLE_TAP_MS);
    });
  }

  // --- First-run gesture hint ----------------------------------------------

  function maybeShowHint(app) {
    if (app.config.hintVersion >= CURRENT_HINT_VERSION) return;

    var hint = el("div", "reels-hint-card");
    hint.appendChild(el("div", "reels-hint-title", "Reels"));
    var list = document.createElement("ul");
    [
      "Swipe up / down — next / previous",
      "Tap — pause / play (first tap unmutes sound)",
      "Double tap, or L — like",
      "Long press — 2x speed",
      "Thumbs-down, or D — dislike (Undo for 5s)",
    ].forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    });
    hint.appendChild(list);

    var dismiss = el("button", "btn btn-primary reels-hint-dismiss", "Got it");
    dismiss.addEventListener("click", function () {
      hint.remove();
      app.config.hintVersion = CURRENT_HINT_VERSION;
      writeConfig({ hintVersion: CURRENT_HINT_VERSION }).catch(logErr);
    });
    hint.appendChild(dismiss);

    app.root.appendChild(hint);
  }

  // =========================================================================
  // Route registration
  // =========================================================================

  function ReelsPage() {
    var React = window.PluginApi.React;
    var containerRef = React.useRef(null);

    React.useEffect(function () {
      var root = containerRef.current;
      var app = persistedApp;
      var fresh = !app;
      if (fresh) {
        app = persistedApp = createApp(root);
      } else {
        app.root = root;
      }

      root.className = "reels-overlay";
      document.documentElement.classList.add("reels-html-lock");

      if (fresh) {
        clear(root);
        root.appendChild(el("div", "reels-loading", "Loading…"));
        loadAll(app)
          .then(function () {
            setScreen(app, "start");
          })
          .catch(function (err) {
            console.error("Reels: failed to load.", err);
            persistedApp = null;
            clear(app.root);
            app.root.appendChild(el("div", "reels-loading", "Failed to load Reels. See console."));
          });
      } else {
        resumeApp(app);
      }

      return function () {
        suspendApp(app);
        document.documentElement.classList.remove("reels-html-lock");
      };
    }, []);

    return React.createElement("div", { ref: containerRef });
  }

  waitForPluginApi(function (PluginApi) {
    fetchConfigurationPlugins()
      .then(function (plugins) {
        navLinkEnabled = parseReelsConfig(plugins).settings.showNavLink;
      })
      .catch(function () {
        navLinkEnabled = true;
      })
      .then(function () {
        startNavLinkObserver();
      });

    PluginApi.register.route("/reels", ReelsPage);
  });
})();
