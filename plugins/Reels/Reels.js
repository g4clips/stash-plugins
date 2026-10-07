(function () {
  if (window._reelsPluginLoaded) {
    return;
  }
  window._reelsPluginLoaded = true;

  var REELS_VERSION = "0.2.1";
  var PLUGIN_ID = "Reels";
  var CANDIDATE_MAX_COUNT = 500;

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
    "query ReelsAllTags { findTags(filter: { per_page: -1 }) { tags { id name } } }";

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
    "      tags { id name scene_count }" +
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
    "mutation ReelsBulkSceneUpdate($ids: [ID!]!, $tag_ids: [ID!]!) {" +
    "  bulkSceneUpdate(input: { ids: $ids, tag_ids: { ids: $tag_ids, mode: ADD } }) { id }" +
    "}";

  function addTagToScenes(sceneIds, tagId) {
    if (!sceneIds.length) return Promise.resolve();
    return gql(BULK_SCENE_UPDATE_MUTATION, { ids: sceneIds, tag_ids: [tagId] });
  }

  // --- Tag lookup / creation ----------------------------------------------

  function ensureTags() {
    return gql(ALL_TAGS_QUERY).then(function (data) {
      var byName = {};
      data.findTags.tags.forEach(function (t) {
        byName[t.name] = t.id;
      });

      var missing = [];
      Object.keys(TAG_NAMES).forEach(function (key) {
        var name = TAG_NAMES[key];
        if (!byName[name]) missing.push(name);
      });

      if (!missing.length) {
        return resolveTagMap(byName);
      }

      return missing
        .reduce(function (chain, name) {
          return chain.then(function () {
            return gql(TAG_CREATE_MUTATION, { name: name }).then(function (res) {
              byName[name] = res.tagCreate.id;
            });
          });
        }, Promise.resolve())
        .then(function () {
          return resolveTagMap(byName);
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

  // --- Config store (read-merge-write) ------------------------------------

  function readConfig() {
    return gql(CONFIGURATION_QUERY).then(function (data) {
      var plugins = (data.configuration && data.configuration.plugins) || {};
      var raw = plugins[PLUGIN_ID] || {};
      return {
        settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
        scores: raw.scores || { performers: {}, studios: {}, tags: {} },
        cycle: raw.cycle || { seen: [] },
        hintShown: !!raw.hintShown,
      };
    });
  }

  // Re-reads the live config and shallow-merges `patch` on top before writing
  // back the whole object, so a concurrent write (e.g. from another device,
  // or a different key written moments earlier) is never clobbered.
  function writeConfig(patch) {
    return gql(CONFIGURATION_QUERY).then(function (data) {
      var plugins = (data.configuration && data.configuration.plugins) || {};
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

  // --- TagChips categories (read-only) ------------------------------------

  function readTagChipsCategories() {
    return gql(CONFIGURATION_QUERY).then(function (data) {
      var plugins = (data.configuration && data.configuration.plugins) || {};
      var tagChips = plugins.TagChips || {};
      return tagChips.categories || [];
    });
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

  function visibleHashtags(scene) {
    return (scene.tags || [])
      .filter(function (t) {
        if (HIDDEN_HASHTAG_NAMES.indexOf(t.name) !== -1) return false;
        return !HIDDEN_HASHTAG_PREFIXES.some(function (prefix) {
          return t.name.indexOf(prefix) === 0;
        });
      })
      .sort(function (a, b) {
        return (b.scene_count || 0) - (a.scene_count || 0);
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
  // The nav link must stay present (or absent) across every page the user
  // visits, not just while the Reels overlay itself is open.
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
      config: null,
      chipsCategories: [],
      pool: [],
      candidates: [],
      candidatesCount: 0,
      screen: "loading",
      activeChipId: "all",
      gridScrollTop: 0,
      codecNeedsTranscode: {}, // video_codec -> true, learned this session
    };
    return app;
  }

  function loadAll(app) {
    return Promise.all([
      ensureTags(),
      readConfig(),
      readTagChipsCategories(),
    ]).then(function (results) {
      app.tags = results[0];
      app.config = results[1];
      app.chipsCategories = results[2];
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
      app.pool = results[0].findScenes.scenes;
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
      // Same non-fixed, top-left-of-the-bar styling as the back button --
      // it used to reuse the feed's fixed top-right close button class,
      // which placed it directly on top of the gear icon.
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

    var grid = el("div", "reels-cover-grid");
    grid.addEventListener("scroll", function () {
      app.gridScrollTop = grid.scrollTop;
    });

    var filtered = app.pool.filter(function (s) {
      return poolMatchesChip(app, s, app.activeChipId);
    });

    filtered.forEach(function (scene) {
      grid.appendChild(buildCoverCell(app, scene));
    });
    container.appendChild(grid);

    setTimeout(function () {
      grid.scrollTop = app.gridScrollTop;
    }, 0);

    return container;
  }

  function buildCoverCell(app, scene) {
    var cell = el("div", "reels-cover-cell");
    var img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = scene.paths.screenshot || "";
    img.alt = "";
    cell.appendChild(img);

    if (sceneHasTag(scene, app.tags.liked)) {
      cell.appendChild(el("div", "reels-heart-badge", "♥"));
    }

    cell.addEventListener("click", function () {
      startFeed(app, scene.id);
    });

    return cell;
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

    var grid = el("div", "reels-review-grid");
    app.candidates.forEach(function (scene) {
      var cell = el("div", "reels-review-cell reels-review-cell-selected");
      var img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.src = scene.paths.screenshot || "";
      cell.appendChild(img);

      var file = sceneFile(scene);
      if (file && file.duration) {
        cell.appendChild(el("div", "reels-duration-badge", formatDuration(file.duration)));
      }

      var previewVideo = null;
      var pressTimer = null;
      var suppressClick = false;

      function startPreview() {
        if (previewVideo) return;
        previewVideo = document.createElement("video");
        previewVideo.muted = true;
        previewVideo.loop = true;
        previewVideo.playsInline = true;
        previewVideo.className = "reels-review-preview";
        previewVideo.src = scene.paths.stream;
        cell.appendChild(previewVideo);
        previewVideo.play().catch(function () {});
      }
      function stopPreview() {
        if (!previewVideo) return;
        previewVideo.pause();
        previewVideo.removeAttribute("src");
        previewVideo.load();
        previewVideo.remove();
        previewVideo = null;
      }

      // Touch: long-press starts a preview and suppresses the click that
      // follows release, so the long-press doesn't also toggle selection.
      cell.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse") return;
        pressTimer = setTimeout(function () {
          suppressClick = true;
          startPreview();
        }, 350);
      });
      cell.addEventListener("pointerup", function () {
        clearTimeout(pressTimer);
        stopPreview();
      });
      cell.addEventListener("pointerleave", function () {
        clearTimeout(pressTimer);
        stopPreview();
      });

      // Mouse: hover starts/stops the preview; a real click still selects.
      cell.addEventListener("pointerenter", function (e) {
        if (e.pointerType !== "mouse") return;
        startPreview();
      });

      cell.addEventListener("click", function () {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        selected[scene.id] = !selected[scene.id];
        cell.classList.toggle("reels-review-cell-selected", !!selected[scene.id]);
        updateCountLine();
      });

      grid.appendChild(cell);
    });
    container.appendChild(grid);
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
        addTagToScenes(acceptedIds, app.tags.pool),
        addTagToScenes(rejectedIds, app.tags.rejected),
      ])
        .then(function () {
          return refetchPoolAndCandidates(app);
        })
        .then(function () {
          setScreen(app, "start");
        })
        .catch(function (err) {
          console.error("Reels: failed to confirm review grid.", err);
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
      writeConfig({ scores: { performers: {}, studios: {}, tags: {} }, cycle: { seen: [] } }).then(
        function () {
          app.config.scores = { performers: {}, studios: {}, tags: {} };
          app.config.cycle = { seen: [] };
        }
      );
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
    var ordered = shuffle(pool);

    if (app.feedSeedSceneId) {
      var seedIndex = ordered.findIndex(function (s) {
        return s.id === app.feedSeedSceneId;
      });
      if (seedIndex > 0) {
        var seed = ordered.splice(seedIndex, 1)[0];
        ordered.unshift(seed);
      }
    }

    var state = {
      app: app,
      scenes: ordered,
      slideEls: [],
      videos: [null, null, null], // pool of 3 reused <video> elements
      currentIndex: 0,
      unmuted: false,
      observer: null,
      keyHandler: null,
      disposed: false,
      muteBtn: null,
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

    attachTapHandler(slide, state);

    return slide;
  }

  function buildOverlay(app, scene, slide) {
    var overlay = el("div", "reels-slide-overlay");

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

    var tags = visibleHashtags(scene);
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

    // A video is free when it has no slide at all, or its slide fell out
    // of the window -- a slide that doesn't exist (nulls at the ends of
    // the window) must never make an otherwise-free video look "placed".
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
      // Poster stays visible (the <video> also carries the same image as
      // its native `poster`) until the "playing" handler in
      // attachVideoHandlers hides it, so a still-loading clip shows its
      // cover instead of a black frame.
      slide.el.insertBefore(video, slide.el.firstChild);
    });

    // Any video left over (window edge, e.g. no "previous" at the first
    // slide) is detached but keeps whatever src it has -- including a
    // warmup src used only to unlock sound on iOS -- so it stays ready to
    // be picked up by the `desiredSlides.forEach` loop above once needed.
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
        try {
          video.currentTime = 0;
        } catch (e) {}
      }
    });
  }

  // Gives any video element that has never held content a real (muted,
  // paused) src purely so a first-tap gesture can start+unmute it -- e.g.
  // the "previous" slot's video when the feed opens on the first clip.
  // Without this it has no src to play() and never gets gesture-unlocked.
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

  // Attaches error/playing/ended handlers to a video that was just given a
  // new src for `slide`. Each video is reused across many slides over the
  // life of the feed, so these are reassigned (not added with
  // addEventListener) every time a video is handed to a new slide.
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

      // The transcode URL itself failed: give up on this clip. Phase 1
      // never tags unplayable clips -- that's Phase 2.
      hideConverting(slide);
      console.error(
        "Reels: scene " + slide.scene.id + " unplayable even after transcode retry (codec " + codec + ")."
      );
      showSlideError(slide, code);
      if (slide === state.slideEls[state.currentIndex]) {
        scrollToIndex(state, state.currentIndex + 1);
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

  // Plays the given (current) slide's video respecting the session's
  // unmuted state. If an unmuted play is refused (common on iOS outside a
  // direct gesture), falls back to a muted play and shows "Tap for sound",
  // matching v0.1.0's behaviour -- restored here because it was dropped by
  // mistake when the single-video-per-slide model was replaced.
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

  // Unmutes and starts every pooled video (then immediately re-pauses
  // whichever aren't actually current) so each <video> element has been
  // started by this user gesture -- fixes iOS tying sound permission to
  // the element. Used by both the first tap on a slide and the explicit
  // mute button.
  function unlockSound(state) {
    state.unmuted = true;
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
      // Links, buttons and the hashtag block handle their own taps (and
      // call stopPropagation), so this is only reached for clicks that
      // bubbled from plain overlay chrome -- but guard anyway, since
      // pointerup/pointerdown aren't stopped by those listeners.
      if (e.target.closest && e.target.closest("a, button, .reels-hashtags")) {
        return;
      }

      var dx = Math.abs(e.clientX - startX);
      var dy = Math.abs(e.clientY - startY);
      var elapsed = Date.now() - startTime;
      if (dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD || elapsed > 600) {
        return; // scroll/swipe, not a tap
      }

      if (!state.unmuted) {
        unlockSound(state);
        if (state.muteBtn) state.muteBtn.textContent = "🔊";
        return;
      }

      if (slide.needsSoundRetry) {
        hideTapForSound(slide);
        slide.video.muted = false;
        var p = slide.video.play();
        if (p && typeof p.catch === "function") p.catch(function () {});
        return;
      }

      if (slide.video) {
        if (slide.video.paused) {
          attemptPlayCurrent(slide, state);
        } else {
          slide.video.pause();
        }
      }
    });
  }

  // --- First-run gesture hint ----------------------------------------------

  function maybeShowHint(app) {
    if (app.config.hintShown) return;

    var hint = el("div", "reels-hint-card");
    hint.appendChild(el("div", "reels-hint-title", "Reels"));
    var list = document.createElement("ul");
    // Only gestures actually implemented in this version -- double-tap to
    // like and long-press for 2x speed are Phase 2.
    [
      "Swipe up / down — next / previous",
      "Tap — pause / play (first tap unmutes sound)",
    ].forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    });
    hint.appendChild(list);

    var dismiss = el("button", "btn btn-primary reels-hint-dismiss", "Got it");
    dismiss.addEventListener("click", function () {
      hint.remove();
      app.config.hintShown = true;
      writeConfig({ hintShown: true }).catch(function (e) {
        console.error("Reels: failed to persist hint dismissal.", e);
      });
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
    readConfig()
      .then(function (config) {
        navLinkEnabled = config.settings.showNavLink;
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
