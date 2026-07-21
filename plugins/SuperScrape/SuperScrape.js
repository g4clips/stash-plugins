// SuperScrape.js
// Unifies IWantClipsStashDB.js and ManyVidsStashDB.js behind one modal with
// a site-adapter architecture (site is auto-detected from a pasted store
// URL's domain -- no site-picker UI). Reuses the proven plain-DOM modal
// shell (draggable, hover-enlarge thumbnails, confidence-colored match
// state, quick-pick last-5, Manage Known Stores tab) wholesale, and adds
// two new steps: a tag-chip picker on the apply screen, and a duplicate-
// detection warning step before it (mirrors Data18StashDB's pattern).

(function () {
  "use strict";

  if (window._superScrapeLoaded) return;
  window._superScrapeLoaded = true;

  const PLUGIN_ID  = "SuperScrape";
  const BTN_ID     = "ss-open-btn";
  const MODAL_ID   = "ss-modal-overlay";
  const RESULT_TAG = "__superscrape_result__";

  // Mirrors SuperScrape.py's SITE_DOMAINS exactly -- kept small/duplicated
  // here rather than round-tripping through a "Detect Site" task on every
  // keystroke; the Python side still owns the same mapping as the source
  // of truth (used by search_store/scrape_clip's own site dispatch).
  const SITE_DOMAINS = { "iwantclips.com": "iwantclips", "manyvids.com": "manyvids", "clips4sale.com": "clips4sale", "goddesssnow.com": "goddesssnow" };

  // ── Utilities ──────────────────────────────────────────────────────────────

  function getSceneId()  { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage() { return !!getSceneId(); }
  function getModal()    { return document.getElementById(MODAL_ID); }
  function getContent()  { return document.getElementById("ss-content"); }

  function normalize(s) {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function detectSiteFromUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      for (const [domain, site] of Object.entries(SITE_DOMAINS)) {
        if (host === domain || host.endsWith("." + domain)) return site;
      }
    } catch (_) { /* invalid URL */ }
    return null;
  }

  function extractStoreIdFromUrl(url, site) {
    if (site === "iwantclips") {
      const m = url.match(/\/store\/\d+\/([^/?#]+)/);
      return m ? m[1] : null;
    }
    if (site === "manyvids") {
      const m = url.match(/\/Profile\/(\d+)/i);
      return m ? m[1] : null;
    }
    if (site === "clips4sale") {
      const m = url.match(/\/studio\/(\d+)/i);
      return m ? m[1] : null;
    }
    if (site === "goddesssnow") {
      // No per-store id concept -- genuinely single-performer site
      // (confirmed live), always the same fixed base URL. A truthy
      // sentinel here just satisfies the generic "could we parse a store
      // id out of that URL" check shared by every site's paste-URL
      // fallback path -- nothing downstream ever reads this value.
      return "vod";
    }
    return null;
  }

  // The store-id field name differs per site (iwantclips' is a slug
  // string, manyvids'/clips4sale's are numeric ids) -- one place to map
  // site -> field name, used everywhere a storeInfo object gets built
  // instead of repeating a growing ternary at each call site.
  function storeIdFieldName(site) {
    if (site === "iwantclips") return "modelUsername";
    if (site === "manyvids") return "profileId";
    if (site === "clips4sale") return "studioId";
    return "storeId";
  }

  function siteLabel(site) {
    if (site === "iwantclips") return "iWantClips";
    if (site === "manyvids") return "ManyVids";
    if (site === "clips4sale") return "Clips4Sale";
    if (site === "goddesssnow") return "Goddess Snow";
    return site || "?";
  }

  // Shared hover-enlarge thumbnail markup (mirrors IWantClipsStashDB.js/
  // ManyVidsStashDB.js's .*-thumb-wrap/#*-hover-preview pattern).
  function thumbWithHover(url, thumbClass) {
    if (!url) return `<div class="${thumbClass} ss-no-img"></div>`;
    return `<div class="ss-thumb-wrap" data-full="${esc(url)}">
      <img class="${thumbClass}" src="${esc(url)}" alt="">
    </div>`;
  }

  function bindThumbHovers() {
    document.querySelectorAll(".ss-thumb-wrap[data-full]").forEach(wrap => {
      wrap.addEventListener("mouseenter", () => showHoverPreview(wrap));
      wrap.addEventListener("mouseleave", hideHoverPreview);
    });
  }

  function showHoverPreview(wrapEl) {
    const preview = document.getElementById("ss-hover-preview");
    if (!preview) return;
    const url = wrapEl.dataset.full;
    if (!url) return;
    preview.querySelector("img").src = url;
    const rect = wrapEl.getBoundingClientRect();
    preview.style.left = `${rect.right + 8}px`;
    preview.style.top = `${rect.top}px`;
    preview.style.display = "block";
  }

  function hideHoverPreview() {
    const preview = document.getElementById("ss-hover-preview");
    if (preview) preview.style.display = "none";
  }

  function setStatus(msg) {
    const el = document.getElementById("ss-status");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function setError(msg) {
    const el = document.getElementById("ss-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  // ── GraphQL (local Stash) ──────────────────────────────────────────────────

  async function gql(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });
    const json = await resp.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join("; "));
    return json.data;
  }

  // ── Plugin config — SINGLE SOURCE OF TRUTH, read/written identically by
  // SuperScrape.py's read_config/write_config. *** These two readConfig
  // implementations must stay in sync -- any new field added to one MUST
  // be added to the other in the same change. *** This is the exact bug
  // class found in ManyVidsStashDB this session (JS readConfig() not
  // knowing about storeCatalogCache, silently dropping it on the next
  // writeConfig call from anywhere in that file). ───────────────────────────

  async function readConfig() {
    const data = await gql(`{ configuration { plugins } }`);
    const cfg = (data.configuration.plugins || {})[PLUGIN_ID] || {};
    return {
      performerStoreMap: cfg.performerStoreMap || {},
      storeCatalogCache: cfg.storeCatalogCache || {},
      proxyUrl: cfg.proxyUrl || "",
    };
  }

  async function writeConfig(patch) {
    const current = await readConfig();
    const merged = { ...current, ...patch };
    await gql(
      `mutation Configure($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
      { id: PLUGIN_ID, input: merged }
    );
    return merged;
  }

  // ── Run Python task and read result from __superscrape_result__ tag ───────
  // ManyVids' "Search Store" can do a full paginated catalog crawl (cache
  // miss/stale), which takes noticeably longer than a single live query --
  // pollSeconds is per-call so that path can ask for more time.

  async function runTask(taskName, args, { pollSeconds = 90 } = {}) {
    const argsArray = Object.entries(args).map(([key, value]) => ({
      key,
      value: { str: typeof value === "string" ? value : JSON.stringify(value) },
    }));

    const startData = await gql(`
      mutation RunTask($name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: "${PLUGIN_ID}", task_name: $name, args: $args)
      }
    `, { name: taskName, args: argsArray });

    const jobId = startData.runPluginTask;
    if (!jobId) throw new Error(`Could not start task: ${taskName}`);

    for (let i = 0; i < pollSeconds; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const jd = await gql(`
          query FindJob($input: FindJobInput!) { findJob(input: $input) { id status description } }
        `, { input: { id: jobId } });
        const job = jd.findJob;
        if (!job) break;
        if (job.status === "FINISHED") break;
        if (job.status === "FAILED") throw new Error(job.description || `Task failed: ${taskName}`);
      } catch (e) {
        if (e.message.includes("Task failed")) throw e;
        break;
      }
    }

    const td = await gql(`
      query { findTags(filter: { q: ${JSON.stringify(RESULT_TAG)}, per_page: 1 }) { tags { id name description } } }
    `);
    const tag = (td.findTags.tags || []).find(t => t.name === RESULT_TAG);
    if (!tag?.description) throw new Error(`Task completed but returned no result. Check Settings → Logs.`);

    try { await gql(`mutation D($id:ID!){tagDestroy(input:{id:$id})}`, { id: tag.id }); } catch (_) {}

    const result = JSON.parse(tag.description);
    if (result.ok === false) throw new Error(result.error || `Task failed: ${taskName}`);
    return result.output;
  }

  // ── Fetch current scene (extended with files.fingerprints for phash-based
  // duplicate detection -- neither source plugin needed this) ───────────────

  async function fetchCurrentScene(sceneId) {
    const data = await gql(`
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id title date details urls
          files { basename fingerprints { type value } }
          studio { id name }
          performers { id name }
          tags { id name }
          paths { screenshot }
        }
      }
    `, { id: sceneId });
    return data.findScene;
  }

  function currentScenePhashes(current) {
    const file = (current.files || [])[0];
    if (!file) return [];
    return (file.fingerprints || []).filter(f => f.type === "phash").map(f => f.value);
  }

  // ── Create performer/studio in local Stash (name only) ─────────────────────

  async function createPerformerInStash(name) {
    const result = await gql(
      `mutation($input: PerformerCreateInput!) { performerCreate(input: $input) { id name } }`,
      { input: { name } }
    );
    if (!result.performerCreate) throw new Error("Create mutation returned no result");
    return result.performerCreate;
  }

  async function createStudioInStash(name) {
    const result = await gql(
      `mutation($input: StudioCreateInput!) { studioCreate(input: $input) { id name } }`,
      { input: { name } }
    );
    if (!result.studioCreate) throw new Error("Create mutation returned no result");
    return result.studioCreate;
  }

  // ── Tags (flat picker -- see renderApply) ──────────────────────────────────

  async function fetchAllTags() {
    // "scene_count" is a real field but NOT a valid server-side sort key
    // (confirmed live: findTags errors with "invalid sort: scene_count") --
    // TagChips hits the same wall and sorts client-side after fetching by
    // name; mirrored here rather than assumed.
    const data = await gql(`
      query SuperScrapeAllTags {
        findTags(filter: { per_page: -1, sort: "name", direction: ASC }) {
          tags { id name scene_count }
        }
      }
    `);
    return data.findTags.tags
      .slice()
      .sort((a, b) => (b.scene_count || 0) - (a.scene_count || 0));
  }

  // ── Apply scraped metadata directly via GraphQL ───────────────────────────

  async function applyToScene(sceneId, fieldChecks, selPerfNames, scraped, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail, selectedTagIds) {
    const input = { id: sceneId };
    if (fieldChecks.title && scraped.title) input.title = scraped.title;
    if (fieldChecks.date && scraped.date) input.date = scraped.date;
    if (fieldChecks.details && scraped.description) input.details = scraped.description;
    if (fieldChecks.studio && resolvedStudio?.found) input.studio_id = resolvedStudio.localId;
    if (fieldChecks.performers && selPerfNames.length) {
      const ids = resolvedPerformers.filter(p => selPerfNames.includes(p.name) && p.localId).map(p => p.localId);
      if (ids.length) input.performer_ids = ids;
    }
    if (fieldChecks.urls && contentUrl) {
      const existing = current.urls || [];
      if (!existing.includes(contentUrl)) input.urls = [...existing, contentUrl];
    }
    if (coverPick === "scraped" && scrapedThumbnail) input.cover_image = scrapedThumbnail;
    // Tags are always additive (merge, not replace), independent of the
    // per-field "Use" checkboxes above -- whatever's toggled on in the
    // chip picker gets added to whatever the scene already has.
    if (selectedTagIds && selectedTagIds.length) {
      const existingIds = (current.tags || []).map(t => t.id);
      input.tag_ids = Array.from(new Set([...existingIds, ...selectedTagIds]));
    }
    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
  }

  async function bumpLastUsed(storeKey, storeInfo) {
    if (!storeKey) return;
    try {
      const cfg = await readConfig();
      const existing = cfg.performerStoreMap[storeKey] || storeInfo;
      await writeConfig({
        performerStoreMap: {
          ...cfg.performerStoreMap,
          [storeKey]: { ...existing, lastUsedAt: Date.now() },
        },
      });
    } catch (_) { /* non-critical */ }
  }

  // ── Button injection ───────────────────────────────────────────────────────

  function injectButton() {
    if (!isScenePage() || document.getElementById(BTN_ID)) return;
    const tryInsert = () => {
      const target =
        document.querySelector(".scene-toolbar") ||
        document.querySelector(".details-edit .buttons-container");
      if (!target) return false;
      const btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.className = "btn btn-secondary";
      btn.textContent = "Scrape";
      btn.title = "Scrape iWantClips/ManyVids and match to local Stash";
      btn.addEventListener("click", () => openModal(getSceneId()));
      target.appendChild(btn);
      return true;
    };
    if (!tryInsert()) {
      const deadline = Date.now() + 15000;
      const obs = new MutationObserver(() => { if (tryInsert() || Date.now() > deadline) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  function onLocationChange() {
    const old = document.getElementById(BTN_ID);
    if (old) old.remove();
    if (isScenePage()) setTimeout(injectButton, 800);
  }

  function startListening() {
    if (window.PluginApi?.Event) {
      window.PluginApi.Event.addEventListener("stash:location", onLocationChange);
    } else {
      let last = "";
      setInterval(() => { if (window.location.pathname !== last) { last = window.location.pathname; onLocationChange(); } }, 500);
    }
    onLocationChange();
  }

  // ── Modal shell + tabs ─────────────────────────────────────────────────────

  function closeModal() { getModal()?.remove(); }

  function openModal(sceneId) {
    if (getModal()) return;
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div id="ss-box">
        <div id="ss-header">
          <span>SuperScrape → Stash</span>
          <button id="ss-close">✕</button>
        </div>
        <div id="ss-tabs">
          <button id="ss-tab-scrape" class="ss-tab ss-tab-active">Scrape</button>
          <button id="ss-tab-manage" class="ss-tab">Manage Known Stores</button>
        </div>
        <div id="ss-error"  style="display:none"></div>
        <div id="ss-status" style="display:none"></div>
        <div id="ss-content"></div>
      </div>
      <div id="ss-hover-preview"><img alt=""></div>`;
    document.body.appendChild(overlay);
    document.getElementById("ss-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    document.getElementById("ss-tab-scrape").onclick = () => switchTab(sceneId, "scrape");
    document.getElementById("ss-tab-manage").onclick = () => switchTab(sceneId, "manage");

    // ── Drag to move ──────────────────────────────────────────────────────
    const box    = document.getElementById("ss-box");
    const header = document.getElementById("ss-header");
    let dragging = false, ox = 0, oy = 0;

    function onDragMove(e) {
      if (!dragging) return;
      let x = Math.max(0, Math.min(window.innerWidth  - box.offsetWidth,  e.clientX - ox));
      let y = Math.max(0, Math.min(window.innerHeight - box.offsetHeight, e.clientY - oy));
      box.style.left = x + "px";
      box.style.top  = y + "px";
    }

    function onDragEnd() {
      dragging = false;
      header.style.cursor = "grab";
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup",   onDragEnd);
    }

    header.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;
      const rect = box.getBoundingClientRect();
      box.style.transform = "none";
      box.style.left = rect.left + "px";
      box.style.top  = rect.top  + "px";
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      dragging = true;
      header.style.cursor = "grabbing";
      e.preventDefault();
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup",   onDragEnd);
    });
    // ── End drag ─────────────────────────────────────────────────────────────

    switchTab(sceneId, "scrape");
  }

  function switchTab(sceneId, tab) {
    document.getElementById("ss-tab-scrape").classList.toggle("ss-tab-active", tab === "scrape");
    document.getElementById("ss-tab-manage").classList.toggle("ss-tab-active", tab === "manage");
    setError(""); setStatus("");
    if (tab === "scrape") {
      renderFilenameInput(sceneId);
    } else {
      renderStoreList(sceneId);
    }
  }

  // ── Scrape flow: Step 1 — filename input ──────────────────────────────────

  async function renderFilenameInput(sceneId) {
    setError(""); setStatus("Loading…");
    getContent().innerHTML = `<p class="ss-hint">Loading scene info…</p>`;

    let current;
    try {
      current = await fetchCurrentScene(sceneId);
    } catch (e) {
      setStatus("");
      setError(e.message);
      return;
    }
    setStatus("");

    const basename = (current.files || [])[0]?.basename || "";

    let cfg;
    try {
      cfg = await readConfig();
    } catch (_) {
      cfg = { performerStoreMap: {} };
    }
    const recentEntries = Object.entries(cfg.performerStoreMap)
      .filter(([, e]) => e.lastUsedAt)
      .sort((a, b) => (b[1].lastUsedAt || 0) - (a[1].lastUsedAt || 0))
      .slice(0, 5);

    const quickPickHtml = recentEntries.length ? `
      <div class="ss-section-label">Last used stores</div>
      <div class="ss-suggestions">
        ${recentEntries.map(([key, e]) => `
          <span class="ss-suggestion-chip ss-quickpick-chip" data-key="${esc(key)}">${esc(e.displayName || e.modelUsername || e.profileId || e.studioId)} <em>(${siteLabel(e.site)})</em></span>
        `).join("")}
      </div>` : "";

    getContent().innerHTML = `
      ${quickPickHtml}
      <p class="ss-hint">Filename to parse (edit if needed):</p>
      <div class="ss-row">
        <input id="ss-filename" class="ss-input" type="text" value="${esc(basename)}" />
        <button id="ss-parse" class="ss-btn ss-btn-primary">Parse</button>
      </div>`;

    document.querySelectorAll(".ss-quickpick-chip").forEach(chip => {
      chip.addEventListener("click", async () => {
        const key = chip.dataset.key;
        const entry = cfg.performerStoreMap[key];
        chip.style.opacity = ".5"; chip.style.pointerEvents = "none";
        setStatus("Parsing filename…");
        try {
          const filename = document.getElementById("ss-filename")?.value.trim() || basename;
          const parsed = await runTask("Parse Filename", { filename });
          setStatus("");
          renderMatchState(sceneId, current,
            { performerCandidate: entry.displayName || entry.modelUsername || entry.profileId || entry.studioId, titleCandidate: parsed.titleCandidate },
            { confidence: "confident", source: "quickpick", match: entry, score: 1, suggestions: [] });
        } catch (e) {
          setStatus("");
          setError(e.message);
          chip.style.opacity = ""; chip.style.pointerEvents = "";
        }
      });
    });

    const input = document.getElementById("ss-filename");
    const btn = document.getElementById("ss-parse");

    async function go() {
      const filename = input.value.trim();
      if (!filename) { setError("Enter a filename"); return; }
      setError("");
      btn.disabled = true; btn.textContent = "Parsing…";
      setStatus("Parsing filename…");
      try {
        const parsed = await runTask("Parse Filename", { filename });
        setStatus("Checking known stores…");
        const match = await runTask("Discover Store", { performer_name: parsed.performerCandidate });
        setStatus("");
        renderMatchState(sceneId, current, parsed, match);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Parse"; setStatus("");
      }
    }

    btn.onclick = go;
    input.addEventListener("keydown", e => e.key === "Enter" && go());
  }

  // ── Scrape flow: Step 2 — confidence state + confirm ──────────────────────

  function renderMatchState(sceneId, current, parsed, match) {
    setError("");
    const isConfident = match.confidence === "confident";

    const suggestionsHtml = (match.suggestions || []).map(s => `
      <span class="ss-suggestion-chip" data-site="${esc(s.site)}" data-id="${esc(s.modelUsername || s.profileId || s.studioId)}" data-url="${esc(s.storeUrl)}" data-display="${esc(s.displayName)}">
        ${esc(s.displayName)} <em>(${siteLabel(s.site)})</em> ${s.score != null ? `(${Math.round(s.score * 100)}%)` : ""}
      </span>`).join("");

    const isMultiSite = match.source === "multi_site_match";
    const boxHtml = isConfident ? `
      <div class="ss-confidence-box ss-confidence-confident">
        <div class="ss-confidence-title">✓ Matched known store: ${esc(match.match.displayName)} <em>(${siteLabel(match.match.site)})</em></div>
        <div class="ss-hint">Source: ${esc(match.source)}${match.score < 1 ? ` (score ${match.score})` : ""}</div>
      </div>` : isMultiSite ? `
      <div class="ss-confidence-box ss-confidence-none">
        <div class="ss-confidence-title">⚠ This performer matches more than one site — pick which one to use</div>
        <div class="ss-hint">Confirmed on multiple sites (not a fuzzy guess) -- your pick is remembered for next time:</div>
        <div class="ss-suggestions">${suggestionsHtml}</div>
      </div>` : `
      <div class="ss-confidence-box ss-confidence-none">
        <div class="ss-confidence-title">⚠ No confident match — pick a suggestion or paste a store URL</div>
        ${suggestionsHtml ? `<div class="ss-hint">Did you mean:</div><div class="ss-suggestions">${suggestionsHtml}</div>` : ""}
      </div>`;

    getContent().innerHTML = `
      <div class="ss-section-label">Performer</div>
      <div class="ss-row">
        <input id="ss-performer" class="ss-input" type="text" value="${esc(parsed.performerCandidate)}" />
      </div>
      ${boxHtml}
      ${!isConfident ? `
        <div class="ss-row">
          <input id="ss-store-url" class="ss-input" type="url" placeholder="Paste store URL, e.g. https://iwantclips.com/store/145/BrattyNikki, https://www.manyvids.com/Profile/1004021302/latexnchill/Store/Videos, https://www.clips4sale.com/studio/37562/mina-thorne-, or https://goddesssnow.com/vod/" />
        </div>
        <div id="ss-store-url-site" class="ss-hint"></div>` : ""}
      <div class="ss-section-label">Search terms (clip title)</div>
      <div class="ss-row">
        <input id="ss-query" class="ss-input" type="text" value="${esc(parsed.titleCandidate)}" />
      </div>
      <div class="ss-row">
        <button id="ss-confirm" class="ss-btn ss-btn-primary">${isConfident ? "Confirm &amp; Search" : "Search"}</button>
        <button id="ss-back0" class="ss-btn ss-btn-secondary">← Back</button>
      </div>`;

    document.getElementById("ss-back0").onclick = () => renderFilenameInput(sceneId);

    let selectedStore = isConfident ? match.match : null;

    document.querySelectorAll(".ss-suggestion-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const site = chip.dataset.site;
        selectedStore = {
          site,
          storeUrl: chip.dataset.url,
          displayName: chip.dataset.display,
          [storeIdFieldName(site)]: chip.dataset.id,
        };
        document.querySelectorAll(".ss-suggestion-chip").forEach(c => { c.style.outline = ""; });
        chip.style.outline = "2px solid #6ea8fe";
        const urlInput = document.getElementById("ss-store-url");
        if (urlInput) urlInput.value = chip.dataset.url;
      });
    });

    const storeUrlInput = document.getElementById("ss-store-url");
    const storeUrlSiteHint = document.getElementById("ss-store-url-site");
    if (storeUrlInput) {
      storeUrlInput.addEventListener("input", () => {
        selectedStore = null;
        document.querySelectorAll(".ss-suggestion-chip").forEach(c => { c.style.outline = ""; });
        const url = storeUrlInput.value.trim();
        if (!url) { storeUrlSiteHint.textContent = ""; return; }
        const site = detectSiteFromUrl(url);
        storeUrlSiteHint.textContent = site ? `Detected site: ${siteLabel(site)}` : `⚠ Unrecognized domain (expected ${Object.keys(SITE_DOMAINS).join(", ")})`;
      });
    }

    document.getElementById("ss-confirm").onclick = async () => {
      const performerName = document.getElementById("ss-performer").value.trim();
      const queryText = document.getElementById("ss-query").value.trim();
      if (!performerName) { setError("Performer name is required"); return; }

      let storeInfo = selectedStore;
      if (!storeInfo) {
        const pastedUrl = storeUrlInput?.value.trim();
        if (!pastedUrl) { setError("Confirm a store first — pick a suggestion or paste a store URL"); return; }
        const site = detectSiteFromUrl(pastedUrl);
        if (!site) { setError(`Could not detect a known site (${Object.keys(SITE_DOMAINS).join(", ")}) from that URL`); return; }
        const storeId = extractStoreIdFromUrl(pastedUrl, site);
        if (!storeId) { setError(`Could not parse a store id out of that ${siteLabel(site)} URL`); return; }
        storeInfo = {
          site, storeUrl: pastedUrl, displayName: performerName,
          [storeIdFieldName(site)]: storeId,
        };
      }

      setError("");
      const btn = document.getElementById("ss-confirm");
      btn.disabled = true; btn.textContent = "Searching…";
      setStatus(storeInfo.site === "manyvids"
        ? "Confirming store & fetching clip catalog… (may take a bit for large catalogs, faster on repeat scrapes)"
        : "Confirming store & searching…");

      try {
        const cfg = await readConfig();
        const storeKey = normalize(performerName);
        await writeConfig({
          performerStoreMap: {
            ...cfg.performerStoreMap,
            [storeKey]: storeInfo,
          },
        });

        const searchOutput = await runTask("Search Store", {
          store_info: storeInfo,
          title_candidate: queryText,
        }, { pollSeconds: storeInfo.site === "manyvids" ? 240 : 90 });
        setStatus("");
        renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = isConfident ? "Confirm & Search" : "Search"; setStatus("");
      }
    };
  }

  // ── Scrape flow: Step 3 — clip-picker cards ───────────────────────────────

  function renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput) {
    setError("");
    const hits = searchOutput.hits || [];

    if (!hits.length) {
      const totalHint = searchOutput.totalInStore != null ? ` (${searchOutput.totalInStore} total)` : "";
      getContent().innerHTML = `
        <p class="ss-hint">No results in ${esc(storeInfo.displayName)}'s store${totalHint} for that search.</p>
        <div class="ss-row"><button id="ss-back1" class="ss-btn ss-btn-secondary">← Back</button></div>`;
      document.getElementById("ss-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
      return;
    }

    function shortDesc(text) {
      if (!text) return "";
      return text.length > 120 ? text.slice(0, 117) + "…" : text;
    }

    const cardsHtml = hits.map((h, i) => `
      <div class="ss-result-card" data-idx="${i}">
        ${thumbWithHover(h.thumbnail, "ss-result-thumb")}
        <div class="ss-result-info">
          <div class="ss-result-title">${esc(h.title || "(no title)")}</div>
          <div class="ss-result-sub">${esc(h.category || "")}${h.price != null ? ` — $${h.price}` : ""}${h.score != null ? ` — match ${Math.round(h.score * 100)}%` : ""}</div>
          ${h.description ? `<div class="ss-result-desc">${esc(shortDesc(h.description))}</div>` : ""}
        </div>
      </div>`).join("");

    const warningHtml = searchOutput.largeResultWarning ? `
      <p class="ss-hint ss-warning">⚠ ${hits.length} matches — that's a lot for a specific title. The parsed title candidate may be too generic, or worth narrowing manually.</p>` : "";

    const countLabel = searchOutput.totalInStore != null
      ? `${hits.length} matching clip${hits.length !== 1 ? "s" : ""} out of ${searchOutput.totalInStore}`
      : `${searchOutput.found} result${searchOutput.found !== 1 ? "s" : ""}`;

    getContent().innerHTML = `
      <p class="ss-hint">${countLabel} in ${esc(storeInfo.displayName)}'s store — click to select:</p>
      ${warningHtml}
      <div class="ss-results">${cardsHtml}</div>
      <div class="ss-row"><button id="ss-back1" class="ss-btn ss-btn-secondary">← Back</button></div>`;

    bindThumbHovers();

    document.querySelectorAll(".ss-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        const hit = hits[+card.dataset.idx];
        card.classList.add("ss-card-loading");
        setStatus("Scraping clip…");
        try {
          const scrapeOutput = await runTask("Scrape Clip", {
            url: hit.contentUrl,
            site: storeInfo.site,
            studio_name: storeInfo.displayName,
            // Full hit, not just thumbnail -- goddesssnow's extract() needs
            // publishDate/duration/price threaded through from whichever
            // search/listing hit produced this URL (see gs_extract's
            // docstring in SuperScrape.py; it's the first adapter that
            // isn't self-sufficient from the URL alone). Harmless for the
            // other three adapters' extract(), which only ever reads
            // hit.thumbnail from this object.
            hit,
          });
          setStatus("Checking for duplicates…");
          const resolvedPerfs = scrapeOutput.resolvedPerformers || [];
          const perfIds = resolvedPerfs.filter(p => p.localId).map(p => p.localId);
          const dupeOutput = await runTask("Check Duplicates", {
            scraped_title: scrapeOutput.scraped.title || "",
            performer_ids: perfIds,
            current_scene_id: sceneId,
            current_phashes: currentScenePhashes(current),
          });
          setStatus("");
          const dupes = (dupeOutput.duplicates || []).filter(d => d.id !== sceneId);
          if (dupes.length) {
            renderDuplicates(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail, dupes);
          } else {
            renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail);
          }
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("ss-card-loading");
        }
      });
    });

    document.getElementById("ss-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
  }

  // ── Scrape flow: Step 3b — duplicate warning (mirrors Data18StashDB's
  // pattern, adapted: no stash_id concept here, and the only destructive
  // action offered is deleting the CURRENT scene -- the one about to be
  // scraped into -- not the found duplicate, since the premise is "this
  // scene turns out to already exist elsewhere, remove the redundant one
  // I was about to process") ──────────────────────────────────────────────

  function renderDuplicates(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail, dupes) {
    setError("");

    function fmtSize(bytes) {
      if (!bytes) return null;
      return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
    }

    const cardsHtml = dupes.map((d, i) => {
      const size = fmtSize((d.files || [])[0]?.size);
      const thumb = d.paths?.screenshot;
      return `
        <div class="ss-dupe-card">
          ${thumbWithHover(thumb, "ss-result-thumb")}
          <div class="ss-result-info" style="flex:1">
            <div class="ss-result-title">${esc(d.title || "(no title)")}</div>
            <div class="ss-result-sub">${esc(d.matchReason || "")}</div>
            ${d.date ? `<div class="ss-result-sub">${esc(d.date)}</div>` : ""}
            ${size  ? `<div class="ss-result-sub">Size: ${size}</div>` : ""}
          </div>
          <div class="ss-dupe-actions">
            <a class="ss-btn ss-btn-secondary ss-btn-xs" href="/scenes/${esc(d.id)}" target="_blank" rel="noopener">View existing</a>
          </div>
        </div>`;
    }).join("");

    getContent().innerHTML = `
      <div class="ss-dupe-header">⚠ This scene may already exist in your library.</div>
      <div class="ss-dupe-list">${cardsHtml}</div>
      <div class="ss-row" style="margin-top:.5rem;flex-shrink:0">
        <button id="ss-dupe-delete" class="ss-btn ss-btn-danger">Delete current scene</button>
        <button id="ss-dupe-keep" class="ss-btn ss-btn-secondary">Keep current scene &amp; continue</button>
      </div>`;

    bindThumbHovers();

    document.getElementById("ss-dupe-keep").onclick = () =>
      renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail);

    document.getElementById("ss-dupe-delete").onclick = async () => {
      const btn = document.getElementById("ss-dupe-delete");
      btn.disabled = true; btn.textContent = "Deleting…";
      setStatus("Deleting current scene…");
      try {
        await gql(`mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
          { input: { ids: [sceneId], delete_file: false } });
        setStatus("");
        getContent().innerHTML = `<div class="ss-success">✓ Current scene deleted.</div>
          <div class="ss-row" style="margin-top:.75rem"><button id="ss-dupe-close" class="ss-btn ss-btn-primary">Close</button></div>`;
        document.getElementById("ss-dupe-close").onclick = closeModal;
      } catch (e) {
        btn.disabled = false; btn.textContent = "Delete current scene";
        setStatus("");
        setError(e.message);
      }
    };
  }

  // ── Scrape flow: Step 4 — comparison table (unified: used regardless of
  // which site produced the scraped data) ───────────────────────────────────

  function matchBadge(found) {
    return found
      ? `<span class="ss-badge ss-badge-found">✓ in Stash</span>`
      : `<span class="ss-badge ss-badge-missing">✗ not found</span>`;
  }

  function renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail) {
    setError("");
    const scraped = scrapeOutput.scraped;
    const resolvedPerformers = scrapeOutput.resolvedPerformers || [];
    const resolvedStudio = scrapeOutput.resolvedStudio;

    const perfRowHtml = resolvedPerformers.length ? `
      <div class="ss-compare-row">
        <div class="ss-compare-label">Performers</div>
        <div class="ss-compare-current">${esc((current.performers || []).map(p => p.name).join(", ") || "—")}</div>
        <div class="ss-compare-incoming">
          ${resolvedPerformers.map(p => `
            <div class="ss-perf-row">
              <label class="ss-item-label">
                <input type="checkbox" class="ss-perf-chk" data-name="${esc(p.name)}" ${p.found ? "checked" : ""} />
                <span>${esc(p.name)} ${matchBadge(p.found)}</span>
              </label>
              ${!p.found ? `
                <button class="ss-btn ss-btn-secondary ss-btn-xs ss-perf-create" data-name="${esc(p.name)}" type="button">Create in Stash</button>
                <span class="ss-perf-inline-msg"></span>` : ""}
            </div>`).join("")}
        </div>
        <div class="ss-compare-toggle"><input type="checkbox" class="ss-field-chk" data-field="performers" checked /></div>
      </div>` : "";

    const studioIncomingHtml = resolvedStudio && resolvedStudio.name ? `
      <div class="ss-perf-row">
        <span>${esc(resolvedStudio.name)} ${matchBadge(resolvedStudio.found)}</span>
        ${!resolvedStudio.found ? `
          <button class="ss-btn ss-btn-secondary ss-btn-xs ss-studio-create" data-name="${esc(resolvedStudio.name)}" type="button">Create in Stash</button>
          <span class="ss-perf-inline-msg"></span>` : ""}
      </div>` : "—";

    const currentImageUrl = current.paths?.screenshot || "";
    const defaultCoverPick = currentImageUrl ? "current" : "scraped";
    const imageRowHtml = (currentImageUrl || scrapedThumbnail) ? `
      <div class="ss-compare-row">
        <div class="ss-compare-label">Cover Image</div>
        <div class="ss-compare-current">
          ${thumbWithHover(currentImageUrl, "ss-result-thumb")}
          ${currentImageUrl ? `
            <label class="ss-item-label" style="margin-top:.3rem">
              <input type="radio" name="ss-cover-pick" value="current" ${defaultCoverPick === "current" ? "checked" : ""} />
              <span>Keep current</span>
            </label>` : ""}
        </div>
        <div class="ss-compare-incoming">
          ${thumbWithHover(scrapedThumbnail, "ss-result-thumb")}
          ${scrapedThumbnail ? `
            <label class="ss-item-label" style="margin-top:.3rem">
              <input type="radio" name="ss-cover-pick" value="scraped" ${defaultCoverPick === "scraped" ? "checked" : ""} />
              <span>Use scraped</span>
            </label>` : ""}
        </div>
        <div class="ss-compare-toggle"></div>
      </div>` : "";

    const scalarFields = [
      ["title",   "Title",              current.title,               scraped.title],
      ["date",    "Date",               current.date,                scraped.date],
      ["studio",  "Studio",             current.studio?.name,        studioIncomingHtml],
      ["urls",    "URLs (will merge)",  (current.urls || []).join(", "), contentUrl],
    ].filter(([, , , inc]) => inc);

    const scalarRowsHtml = scalarFields.map(([field, label, cur, inc]) => `
      <div class="ss-compare-row">
        <div class="ss-compare-label">${esc(label)}</div>
        <div class="ss-compare-current">${esc(cur || "—")}</div>
        <div class="ss-compare-incoming">${field === "studio" ? inc : esc(inc)}</div>
        <div class="ss-compare-toggle"><input type="checkbox" class="ss-field-chk" data-field="${field}" checked /></div>
      </div>`).join("");

    const descriptionRowHtml = scraped.description ? `
      <div class="ss-compare-row ss-compare-row-tall">
        <div class="ss-compare-label">Description</div>
        <div class="ss-compare-current ss-trunc">${esc(current.details || "—")}</div>
        <div class="ss-compare-incoming">
          <textarea id="ss-details-edit" class="ss-textarea">${esc(scraped.description)}</textarea>
        </div>
        <div class="ss-compare-toggle"><input type="checkbox" class="ss-field-chk" data-field="details" checked /></div>
      </div>` : "";

    getContent().innerHTML = `
      <div class="ss-compare-table">
        <div class="ss-compare-header">
          <div class="ss-compare-label"></div>
          <div class="ss-compare-current">Current</div>
          <div class="ss-compare-incoming">Incoming (${siteLabel(storeInfo.site)})</div>
          <div class="ss-compare-toggle">Use</div>
        </div>
        ${imageRowHtml}
        ${scalarRowsHtml}
        ${perfRowHtml}
        ${descriptionRowHtml}
      </div>
      <div class="ss-row" style="margin-top:.75rem;flex-shrink:0">
        <button id="ss-back2"   class="ss-btn ss-btn-secondary">← Back</button>
        <button id="ss-selall"  class="ss-btn ss-btn-secondary">All</button>
        <button id="ss-selnone" class="ss-btn ss-btn-secondary">None</button>
        <button id="ss-apply"   class="ss-btn ss-btn-primary">Apply to Scene</button>
      </div>
      <div id="ss-tagpicker-wrap">
        <div class="ss-section-label">Add tags</div>
        <input id="ss-tag-filter" class="ss-input" type="text" placeholder="Filter tags…" style="margin-bottom:.4rem" />
        <div id="ss-tag-grid" class="ss-tag-grid"><span class="ss-hint">Loading tags…</span></div>
      </div>`;

    bindThumbHovers();
    renderTagPicker();

    document.getElementById("ss-back2").onclick = () => renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput);
    document.getElementById("ss-selall").onclick  = () =>
      document.querySelectorAll(".ss-field-chk,.ss-perf-chk").forEach(c => { c.checked = true; });
    document.getElementById("ss-selnone").onclick = () =>
      document.querySelectorAll(".ss-field-chk,.ss-perf-chk").forEach(c => { c.checked = false; });

    document.getElementById("ss-apply").onclick = async () => {
      const fieldChecks = {};
      document.querySelectorAll(".ss-field-chk").forEach(cb => { fieldChecks[cb.dataset.field] = cb.checked; });
      const selPerfs = [...document.querySelectorAll(".ss-perf-chk:checked")].map(cb => cb.dataset.name);
      const coverPick = document.querySelector('input[name="ss-cover-pick"]:checked')?.value || "current";
      const detailsTextarea = document.getElementById("ss-details-edit");
      const scrapedForApply = detailsTextarea ? { ...scraped, description: detailsTextarea.value } : scraped;
      const selectedTagIds = getSelectedTagIds();

      if (!Object.values(fieldChecks).some(Boolean) && !selPerfs.length && !selectedTagIds.length) {
        setError("Select at least one field"); return;
      }

      setError("");
      const btn = document.getElementById("ss-apply");
      btn.disabled = true; btn.textContent = "Applying…";
      setStatus("Writing to scene…");

      try {
        await applyToScene(sceneId, fieldChecks, selPerfs, scrapedForApply, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail, selectedTagIds);
        await bumpLastUsed(storeKey, storeInfo);
        setStatus("");
        renderDone();
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Apply to Scene"; setStatus("");
      }
    };

    document.querySelectorAll(".ss-perf-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".ss-perf-row");
        const msgEl = row?.querySelector(".ss-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createPerformerInStash(name);
          const entry = resolvedPerformers.find(p => p.name === name);
          if (entry) { entry.localId = created.id; entry.found = true; }
          const chk = row?.querySelector(".ss-perf-chk");
          const badge = row?.querySelector(".ss-badge");
          if (chk) chk.checked = true;
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "ss-perf-inline-msg ss-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "ss-perf-inline-msg ss-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });

    document.querySelectorAll(".ss-studio-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".ss-perf-row");
        const msgEl = row?.querySelector(".ss-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createStudioInStash(name);
          if (resolvedStudio) { resolvedStudio.localId = created.id; resolvedStudio.found = true; }
          const badge = row?.querySelector(".ss-badge");
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "ss-perf-inline-msg ss-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "ss-perf-inline-msg ss-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });
  }

  // ── Tag-chip picker — BELOW the back/select-all/select-none/apply row
  // (deliberately, per explicit reasoning: the action buttons stay
  // reachable without scrolling past a long tag list every time). Flat
  // list (no categories, unlike TagChips), sorted by scene_count desc,
  // fixed-size CSS grid (same visual language as TagChips' .tc-tag-grid,
  // different namespace -- no cross-import). Selected tags are ADDED to
  // whatever the scrape/apply flow already sets (merge, not replace). ──────

  let _allTagsCache = null;
  // Selection lives here, independent of the DOM -- filtering the grid
  // removes non-matching chips from the DOM entirely (confirmed live: a
  // chip toggled on, then filtered out of view, then the filter cleared,
  // came back NOT selected, because nothing but its own DOM class tracked
  // selection). getSelectedTagIds() below is the only source of truth
  // read at apply-time, not a DOM query.
  let _selectedTagIds = new Set();

  function getSelectedTagIds() {
    return [..._selectedTagIds];
  }

  async function renderTagPicker() {
    // Deliberately does NOT pre-highlight tags the scene already has: the
    // picker only ever ADDS (see applyToScene's merge, never a replace),
    // so pre-checking an existing tag and letting the user "uncheck" it
    // would falsely imply removal is possible here.
    const grid = document.getElementById("ss-tag-grid");
    if (!grid) return;
    _selectedTagIds = new Set();
    try {
      if (!_allTagsCache) _allTagsCache = await fetchAllTags();
    } catch (e) {
      grid.innerHTML = `<span class="ss-hint">Could not load tags: ${esc(e.message)}</span>`;
      return;
    }
    drawTagGrid(_allTagsCache);

    const filterInput = document.getElementById("ss-tag-filter");
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        const q = normalize(filterInput.value);
        const filtered = q ? _allTagsCache.filter(t => normalize(t.name).includes(q)) : _allTagsCache;
        drawTagGrid(filtered);
      });
    }
  }

  function drawTagGrid(tags) {
    const grid = document.getElementById("ss-tag-grid");
    if (!grid) return;
    if (!tags.length) { grid.innerHTML = `<span class="ss-hint">No tags match.</span>`; return; }
    grid.innerHTML = tags.map(t => `
      <span class="ss-tag-chip${_selectedTagIds.has(t.id) ? " ss-chip-on" : ""}" data-id="${esc(t.id)}" title="${esc(t.name)}">${esc(t.name)}</span>
    `).join("");
    grid.querySelectorAll(".ss-tag-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const id = chip.dataset.id;
        if (_selectedTagIds.has(id)) { _selectedTagIds.delete(id); chip.classList.remove("ss-chip-on"); }
        else { _selectedTagIds.add(id); chip.classList.add("ss-chip-on"); }
      });
    });
  }

  // ── Scrape flow: Step 5 — done ────────────────────────────────────────────

  function renderDone() {
    setError(""); setStatus("");
    getContent().innerHTML = `<div class="ss-success">✓ Scene updated! Reloading…</div>`;
    setTimeout(() => window.location.reload(), 1500);
  }

  // ── Manage Known Stores tab ────────────────────────────────────────────────

  function renderStoreList(sceneId) {
    setError("");
    getContent().innerHTML = `<p class="ss-hint">Loading known stores…</p>`;
    readConfig().then(cfg => {
      const map = cfg.performerStoreMap || {};
      const entries = Object.entries(map);
      getContent().innerHTML = `
        <div class="ss-row">
          <span class="ss-section-label" style="margin:0">Known Stores</span>
          <button id="ss-store-new" class="ss-store-manage-btn">+ add store</button>
        </div>
        ${entries.length === 0 ? `<div class="ss-hint">No stores confirmed yet.</div>` : `
          <div class="ss-store-list">
            ${entries.map(([key, entry]) => `
              <div class="ss-store-row" data-key="${esc(key)}">
                <span class="ss-store-site-badge">${siteLabel(entry.site)}</span>
                <span class="ss-store-name">${esc(entry.displayName || entry.modelUsername || entry.profileId || entry.studioId)}</span>
                <a class="ss-store-url" href="${esc(entry.storeUrl)}" target="_blank" rel="noopener">${esc(entry.storeUrl)}</a>
                <button class="ss-store-manage-btn ss-store-edit" data-key="${esc(key)}">edit</button>
                <button class="ss-store-manage-btn ss-store-delete" data-key="${esc(key)}">delete</button>
              </div>`).join("")}
          </div>`}`;

      document.getElementById("ss-store-new").onclick = () => renderStoreEditor(sceneId, null);
      document.querySelectorAll(".ss-store-edit").forEach(btn =>
        btn.addEventListener("click", () =>
          renderStoreEditor(sceneId, { key: btn.dataset.key, ...map[btn.dataset.key] })));
      document.querySelectorAll(".ss-store-delete").forEach(btn =>
        btn.addEventListener("click", async () => {
          const key = btn.dataset.key;
          const current = await readConfig();
          const next = { ...current.performerStoreMap };
          delete next[key];
          await writeConfig({ performerStoreMap: next });
          renderStoreList(sceneId);
        }));
    }).catch(e => setError(e.message));
  }

  function renderStoreEditor(sceneId, item) {
    setError("");
    getContent().innerHTML = `
      <div class="ss-row">
        <input id="ss-edit-name" class="ss-input" placeholder="Performer name" value="${esc(item?.displayName || "")}" />
      </div>
      <div class="ss-row">
        <input id="ss-edit-url" class="ss-input" placeholder="Store URL (iwantclips.com or manyvids.com)" value="${esc(item?.storeUrl || "")}" />
      </div>
      <div id="ss-edit-site-hint" class="ss-hint">${item?.site ? `Site: ${siteLabel(item.site)}` : ""}</div>
      <div class="ss-row">
        <button id="ss-edit-save" class="ss-btn ss-btn-primary">${item ? "Save" : "Create"}</button>
        ${item ? `<button id="ss-edit-delete" class="ss-btn ss-btn-danger">Delete</button>` : ""}
        <button id="ss-edit-cancel" class="ss-btn ss-btn-secondary">Cancel</button>
      </div>`;

    const urlInput = document.getElementById("ss-edit-url");
    const siteHint = document.getElementById("ss-edit-site-hint");
    urlInput.addEventListener("input", () => {
      const site = detectSiteFromUrl(urlInput.value.trim());
      siteHint.textContent = site ? `Site: ${siteLabel(site)}` : (urlInput.value.trim() ? "⚠ Unrecognized domain" : "");
    });

    document.getElementById("ss-edit-cancel").onclick = () => renderStoreList(sceneId);

    document.getElementById("ss-edit-save").onclick = async () => {
      const name = document.getElementById("ss-edit-name").value.trim();
      const url = document.getElementById("ss-edit-url").value.trim();
      if (!name || !url) { setError("Performer name and store URL are both required"); return; }
      const site = detectSiteFromUrl(url);
      if (!site) { setError("Could not detect a known site (iwantclips.com, manyvids.com, or clips4sale.com) from that URL"); return; }
      const storeId = extractStoreIdFromUrl(url, site);
      if (!storeId) { setError(`Could not parse a store id out of that ${siteLabel(site)} URL`); return; }

      const current = await readConfig();
      const next = { ...current.performerStoreMap };
      if (item && item.key && item.key !== normalize(name)) delete next[item.key];
      next[normalize(name)] = {
        site, storeUrl: url, displayName: name,
        [storeIdFieldName(site)]: storeId,
      };
      await writeConfig({ performerStoreMap: next });
      renderStoreList(sceneId);
    };

    if (item) {
      document.getElementById("ss-edit-delete").onclick = async () => {
        const current = await readConfig();
        const next = { ...current.performerStoreMap };
        delete next[item.key];
        await writeConfig({ performerStoreMap: next });
        renderStoreList(sceneId);
      };
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  startListening();

})();
