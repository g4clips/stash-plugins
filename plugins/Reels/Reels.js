(function () {
  if (window._reelsPluginLoaded) {
    return;
  }
  window._reelsPluginLoaded = true;

  var REELS_VERSION = "0.3.0";
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
  function buildFeedOrder(app, pool, seedScene) {
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
    if (seedScene) order.push(seedScene);
    return order.concat(drawTracked(unseen)).concat(drawTracked(seen));
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

  // =========================================================================
  // Application shell: owns the current screen and shared data.
  // =========================================================================

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
      codecNeedsTranscode: {}, // video_codec -> true, learned this session
      playCountedIds: {}, // scene id -> true, counted this session
    };
    return app;
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
      mountFeedScreen(app);
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
      startFeed(app, null);
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
          unlikeFromGrid(app, scene, renderHeartBadge);
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

  function unlikeFromGrid(app, scene, onDone) {
    if (!sceneHasTag(scene, app.tags.liked)) return;
    scene.tags = scene.tags.filter(function (t) {
      return t.id !== app.tags.liked;
    });
    bulkUpdateTag([scene.id], app.tags.liked, "REMOVE").catch(function (err) {
      handleTagWriteFailure(app, err);
    });
    applyScoreDelta(app, scene, -1);
    if (onDone) onDone();
  }

  function startFeed(app, seedSceneId) {
    app.feedSeedSceneId = seedSceneId;
    app.feedChipId = app.activeChipId;
    setScreen(app, "feed");
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
      "Fit",
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

    var seedScene = app.feedSeedSceneId
      ? pool.filter(function (s) {
          return s.id === app.feedSeedSceneId;
        })[0]
      : null;
    var ordered = buildFeedOrder(app, pool, seedScene);

    var state = {
      app: app,
      scenes: ordered,
      slideEls: [],
      videos: [null, null, null], // pool of 3 reused <video> elements
      currentIndex: 0,
      unmuted: false,
      soundUnlocked: false,
      observer: null,
      keyHandler: null,
      disposed: false,
      muteBtn: null,
      seenTimer: null,
      playTimer: null,
      newlySeenCount: 0,
      lastAction: null,
      toastEl: null,
      toastTimeoutId: null,
    };

    app.root.className = "reels-overlay";
    document.documentElement.classList.add("reels-html-lock");

    if (app.config.settings.showDebugInfo) {
      var versionBadge = el("div", "reels-feed-version", "Reels v" + REELS_VERSION);
      app.root.appendChild(versionBadge);
    }

    var backBtn = el("button", "reels-feed-back", "←");
    backBtn.setAttribute("aria-label", "Back");
    backBtn.addEventListener("click", function () {
      unmountFeedScreen(state);
      setScreen(app, "start");
    });
    app.root.appendChild(backBtn);

    var dislikeBtn = el("button", "reels-dislike-btn", "👎");
    dislikeBtn.setAttribute("aria-label", "Dislike");
    dislikeBtn.addEventListener("click", function () {
      dislike(app, state);
    });
    app.root.appendChild(dislikeBtn);

    var muteBtn = el("button", "reels-mute-btn", state.unmuted ? "🔊" : "🔇");
    muteBtn.setAttribute("aria-label", "Mute / unmute");
    muteBtn.addEventListener("click", function () {
      toggleFeedMute(state);
    });
    app.root.appendChild(muteBtn);
    state.muteBtn = muteBtn;

    var feed = el("div", "reels-feed");
    app.root.appendChild(feed);
    state.feedEl = feed;

    for (var i = 0; i < 3; i++) {
      var v = document.createElement("video");
      v.playsInline = true;
      v.muted = true;
      v.loop = app.config.settings.endOfClip === "loop";
      v.preload = "metadata";
      state.videos[i] = v;
    }

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
        unmountFeedScreen(state);
        setScreen(app, "start");
      }
    };
    document.addEventListener("keydown", state.keyHandler, true);

    maybeShowHint(app);

    app._feedState = state;
  }

  // Leaving the feed for the start/review/settings screens -- the overlay
  // (and its html scroll lock) stays up the whole time the user is on
  // /reels; only the route unmounting entirely should drop the lock.
  function unmountFeedScreen(state) {
    state.disposed = true;
    if (state.observer) state.observer.disconnect();
    document.removeEventListener("keydown", state.keyHandler, true);
    clearTimeout(state.seenTimer);
    clearTimeout(state.playTimer);
    clearUndoToast(state);
    persistCycle(state.app);
    state.videos.forEach(function (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
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

  function buildFeedSlide(app, scene, state) {
    var slide = {
      scene: scene,
      el: el("div", "reels-slide"),
      video: null,
      expanded: false,
    };
    slide.el.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });
    populateSlide(app, slide, state);
    attachTapHandler(slide, state);
    return slide;
  }

  // (Re)builds a slide's visible content for its current `slide.scene`.
  // Used both for the initial build and when re-sampling the upcoming
  // order after a like/dislike swaps which scene a slide shows.
  function populateSlide(app, slide, state) {
    var scene = slide.scene;
    clear(slide.el);
    slide.el.className = "reels-slide";
    slide.video = null;
    slide.errorLabel = null;
    slide.convertingLabel = null;
    slide.tapHint = null;
    slide.needsSoundRetry = false;

    var fitClass =
      app.config.settings.fit === "fill"
        ? "reels-fit-fill"
        : app.config.settings.fit === "crop"
        ? "reels-fit-crop"
        : "reels-fit-contain";
    slide.el.classList.add(fitClass);

    var poster = document.createElement("img");
    poster.className = "reels-poster";
    poster.loading = "lazy";
    poster.decoding = "async";
    poster.src = scene.paths.screenshot || "";
    slide.el.appendChild(poster);
    slide.poster = poster;

    slide.el.appendChild(buildOverlay(app, scene, slide));
  }

  function buildOverlay(app, scene, slide) {
    var overlay = el("div", "reels-slide-overlay");

    if (sceneHasTag(scene, app.tags.liked)) {
      overlay.appendChild(el("div", "reels-liked-badge", "♥"));
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
          navigateTo("/performers/" + p.id);
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
        navigateTo("/studios/" + scene.studio.id);
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
      overlay.appendChild(
        el(
          "div",
          "reels-debug-label",
          "id:" + scene.id + " " + (file ? file.video_codec || "?" : "?") + " " + (file ? file.width + "x" + file.height : "?x?")
        )
      );
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
      video.muted = !state.unmuted;
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

  function attemptPlayCurrent(slide, state) {
    if (!slide || !slide.video) return;
    hideTapForSound(slide);
    slide.video.muted = !state.unmuted;
    var playPromise = slide.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(function (err) {
        if (
          state.unmuted &&
          err &&
          err.name === "NotAllowedError" &&
          slide === state.slideEls[state.currentIndex]
        ) {
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
          console.warn("Reels: play rejected.", err);
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
    var currentVideo = state.slideEls[state.currentIndex] && state.slideEls[state.currentIndex].video;
    state.videos.forEach(function (v) {
      if (!v.hasAttribute("src")) return;
      v.muted = false;
      var p = v.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
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
      state.videos.forEach(function (v) {
        v.muted = true;
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

  function onBecameCurrent(state, slide) {
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

  function refreshLikedBadge(app, slide) {
    var existing = slide.el.querySelector(".reels-liked-badge");
    if (existing) existing.remove();
    if (sceneHasTag(slide.scene, app.tags.liked)) {
      var overlay = slide.el.querySelector(".reels-slide-overlay");
      if (overlay) overlay.insertBefore(el("div", "reels-liked-badge", "♥"), overlay.firstChild);
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
    refreshLikedBadge(app, slide);

    state.lastAction = { type: "like", scene: scene, delta: 1 };
    showUndoToast(state, "Liked");
    reorderUpcoming(app, state);
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

    removeSlideAt(state, idx);

    state.lastAction = { type: "dislike", scene: scene, wasLiked: wasLiked };
    showUndoToast(state, "Marked for deletion");
    reorderUpcoming(app, state);
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
      if (slide) refreshLikedBadge(app, slide);
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
    state.toastTimeoutId = setTimeout(function () {
      state.toastEl = null;
      state.toastTimeoutId = null;
      state.lastAction = null;
      toast.remove();
    }, UNDO_TOAST_MS);
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
  function removeSlideAt(state, idx) {
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
      unmountFeedScreen(state);
      setScreen(state.app, "start");
      return;
    }
    if (state.currentIndex >= state.slideEls.length) {
      state.currentIndex = state.slideEls.length - 1;
    }
    assignVideosToWindow(state);
    onBecameCurrent(state, state.slideEls[state.currentIndex]);
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
  function reorderUpcoming(app, state) {
    var tailStart = state.currentIndex + 2;
    if (tailStart >= state.slideEls.length) return;
    var tailScenes = state.scenes.slice(tailStart);
    var newOrder = buildFeedOrder(app, tailScenes, null);
    for (var i = 0; i < newOrder.length; i++) {
      var slide = state.slideEls[tailStart + i];
      slide.scene = newOrder[i];
      populateSlide(app, slide, state);
      state.scenes[tailStart + i] = newOrder[i];
    }
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
      if (e.target.closest && e.target.closest("a, button, .reels-hashtags")) return;
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
      if (e.target.closest && e.target.closest("a, button, .reels-hashtags")) {
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
        slide.video.muted = false;
        var p = slide.video.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
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
      var app = createApp(containerRef.current);

      containerRef.current.className = "reels-overlay";
      document.documentElement.classList.add("reels-html-lock");
      clear(containerRef.current);
      containerRef.current.appendChild(el("div", "reels-loading", "Loading…"));

      loadAll(app)
        .then(function () {
          setScreen(app, "start");
        })
        .catch(function (err) {
          console.error("Reels: failed to load.", err);
          clear(containerRef.current);
          containerRef.current.appendChild(el("div", "reels-loading", "Failed to load Reels. See console."));
        });

      return function () {
        if (app._feedState) unmountFeedScreen(app._feedState);
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
