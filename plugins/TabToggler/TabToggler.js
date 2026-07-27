(function () {
  const PLUGIN_ID = "TabToggler"; // must match the .yml filename stem

  // Substring match (lowercased) against each nav-link's text content.
  // NOT yet verified against live DOM. Verification checklist:
  //   1. [RESOLVED] Confirmed via stashapp/stash pkg/plugin/config.go that the
  //      BOOLEAN settings schema has no `default` field — checkboxes render
  //      unchecked until a value is explicitly written. Fixed below via
  //      seedDefaultsIfNeeded(), which writes `true` for any of the 8 keys
  //      missing from configuration.plugins.TabToggler on first load, so a
  //      fresh install shows every checkbox checked (matching "all tabs visible").
  //   2. Confirm the real `.nav-link` text for all 8 tabs on a scene page matches
  //      the substrings below (adjust from real DOM output, not assumption).
  //   3. Confirm hiding the currently-active tab correctly falls back to the
  //      first still-visible tab (no blank pane, no console error).
  const TAB_DEFS = [
    { match: "details",   key: "showDetails" },
    { match: "queue",     key: "showQueue" },
    { match: "markers",   key: "showMarkers" },
    { match: "group",     key: "showGroups" },
    { match: "filter",    key: "showFilters" },
    { match: "file info", key: "showFileInfo" },
    { match: "history",   key: "showHistory" },
    { match: "edit",      key: "showEdit" },
  ];

  async function gql(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });
    const json = await resp.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data;
  }

  let cachedConfig = null;
  let configFetchedAt = 0;
  const CONFIG_TTL_MS = 5000; // short TTL so a settings change is picked up without a full page reload

  // Stash's BOOLEAN settings schema has no `default` field (verified against
  // pkg/plugin/config.go), so a fresh install has no config.plugins.TabToggler
  // entry at all, and the Settings UI renders every checkbox unchecked even
  // though our own JS defaults missing keys to "visible". This writes an
  // explicit `true` for any of the 8 keys not yet present, once, so the
  // checkbox state matches actual tab visibility. Never overwrites a key that
  // already exists (including an explicit `false` from a user toggle).
  async function seedDefaultsIfNeeded() {
    try {
      const data = await gql(`query { configuration { plugins } }`);
      const all = data?.configuration?.plugins || {};
      const current = all[PLUGIN_ID] || {};
      const missingKeys = TAB_DEFS.map((t) => t.key).filter((k) => !(k in current));
      if (!missingKeys.length) {
        cachedConfig = current;
        configFetchedAt = Date.now();
        return;
      }
      const seeded = { ...current };
      missingKeys.forEach((k) => { seeded[k] = true; });
      await gql(
        `mutation TabTogglerConfigure($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
        { id: PLUGIN_ID, input: seeded }
      );
      cachedConfig = seeded;
      configFetchedAt = Date.now();
    } catch (e) {
      console.error("[TabToggler] failed to seed default settings", e);
    }
  }

  async function getConfig() {
    const now = Date.now();
    if (cachedConfig && now - configFetchedAt < CONFIG_TTL_MS) return cachedConfig;
    try {
      const data = await gql(`query { configuration { plugins } }`);
      const all = data?.configuration?.plugins || {};
      cachedConfig = all[PLUGIN_ID] || {};
    } catch (e) {
      console.error("[TabToggler] failed to read plugin config", e);
      cachedConfig = cachedConfig || {};
    }
    configFetchedAt = now;
    return cachedConfig;
  }

  function isScenePage() {
    return /^\/scenes\/\d+/.test(window.location.pathname);
  }

  // Returns true if it found + processed a tablist, false if not present yet.
  function applyVisibility(config) {
    const tabList = document.querySelector("div[role='tablist']");
    if (!tabList) return false;
    const navLinks = Array.from(tabList.querySelectorAll(".nav-link"));
    if (!navLinks.length) return false;

    let activeHidden = false;
    let firstVisible = null;

    navLinks.forEach((link) => {
      const text = (link.textContent || "").trim().toLowerCase();
      const def = TAB_DEFS.find((t) => text.includes(t.match));
      const navItem = link.closest(".nav-item") || link;

      if (!def) {
        // Unknown tab (e.g. injected by another plugin like TagChips) — never touch it.
        if (!firstVisible) firstVisible = link;
        return;
      }

      const show = config[def.key] !== false; // default: visible
      navItem.style.display = show ? "" : "none";
      if (show && !firstVisible) firstVisible = link;
      if (!show && link.classList.contains("active")) activeHidden = true;
    });

    // If the tab that was active got hidden, jump to the first still-visible one
    // so the user doesn't land on a blank pane.
    if (activeHidden && firstVisible) {
      firstVisible.click();
    }

    return true;
  }

  async function onLocationChange() {
    if (!isScenePage()) return;
    const config = await getConfig();

    if (!applyVisibility(config)) {
      const deadline = Date.now() + 10000;
      const obs = new MutationObserver(() => {
        if (applyVisibility(config) || Date.now() > deadline) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Persistent, debounced observer: React re-renders (switching tabs, scene
  // data reloading, etc.) can wipe our inline display:none styles since these
  // are Stash's own DOM nodes, not ours. Re-apply cheaply whenever it churns.
  let debounceHandle = null;
  const persistentObserver = new MutationObserver(() => {
    if (!isScenePage() || !cachedConfig) return;
    if (debounceHandle) return;
    debounceHandle = requestAnimationFrame(() => {
      debounceHandle = null;
      applyVisibility(cachedConfig);
    });
  });
  persistentObserver.observe(document.body, { childList: true, subtree: true });

  if (window.PluginApi?.Event) {
    window.PluginApi.Event.addEventListener("stash:location", onLocationChange);
  } else {
    let last = "";
    setInterval(() => {
      if (window.location.pathname !== last) {
        last = window.location.pathname;
        onLocationChange();
      }
    }, 500);
  }
  seedDefaultsIfNeeded();
  onLocationChange();
})();
