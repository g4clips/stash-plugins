// IWantClipsStashDB.js
// Adds an "iWantClips" button to the scene toolbar. No patch point exists
// for arbitrary toolbar buttons (same finding as Data18StashDB), so this
// injects into .scene-toolbar via MutationObserver and opens a plain-DOM
// modal -- same pattern as Data18StashDB_v2.js, no React/patch access
// needed or used.

(function () {
  "use strict";

  if (window._iwantClipsStashDBLoaded) return;
  window._iwantClipsStashDBLoaded = true;

  const PLUGIN_ID  = "IWantClipsStashDB";
  const BTN_ID     = "iwc-open-btn";
  const MODAL_ID   = "iwc-modal-overlay";
  const RESULT_TAG = "__iwc_result__";

  // ── Utilities ──────────────────────────────────────────────────────────────

  function getSceneId()  { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage() { return !!getSceneId(); }
  function getModal()    { return document.getElementById(MODAL_ID); }
  function getContent()  { return document.getElementById("iwc-content"); }

  function normalize(s) {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // Shared hover-enlarge thumbnail markup (mirrors Data18StashDB_v2.js's
  // .d18-thumb-wrap/.d18-thumb-hover pattern), reused for both search
  // result cards and the cover-image comparison row -- built once here,
  // not reimplemented per call site.
  function thumbWithHover(url, thumbClass) {
    if (!url) return `<div class="${thumbClass} iwc-no-img"></div>`;
    // No nested hover-preview element here -- .iwc-results/.iwc-compare-table/
    // #iwc-content are all overflow:auto (scroll containers) and #iwc-box
    // itself is overflow:hidden (needed to clip the header's square
    // background to the box's rounded corners), so anything nested inside
    // one of these wrappers gets clipped no matter how it's positioned.
    // Instead a single shared preview element lives as a sibling of
    // #iwc-box (see openModal) and gets moved/shown on hover -- see
    // bindThumbHovers().
    return `<div class="iwc-thumb-wrap" data-full="${esc(url)}">
      <img class="${thumbClass}" src="${esc(url)}" alt="">
    </div>`;
  }

  // Attaches hover listeners to every .iwc-thumb-wrap currently in the DOM.
  // Called after each render that injects thumbnails (innerHTML wipes any
  // previously-bound listeners, so this re-binds every time, matching this
  // file's existing convention elsewhere).
  function bindThumbHovers() {
    document.querySelectorAll(".iwc-thumb-wrap[data-full]").forEach(wrap => {
      wrap.addEventListener("mouseenter", () => showHoverPreview(wrap));
      wrap.addEventListener("mouseleave", hideHoverPreview);
    });
  }

  function showHoverPreview(wrapEl) {
    const preview = document.getElementById("iwc-hover-preview");
    if (!preview) return;
    const url = wrapEl.dataset.full;
    if (!url) return;
    preview.querySelector("img").src = url;
    // preview is a sibling of #iwc-box (position:fixed, no transform on
    // that ancestor), so plain viewport-relative getBoundingClientRect()
    // coordinates are exactly right here -- it never enters #iwc-box's
    // transformed subtree, so there's no need to offset against #iwc-box's
    // own rect.
    const rect = wrapEl.getBoundingClientRect();
    preview.style.left = `${rect.right + 8}px`;
    preview.style.top = `${rect.top}px`;
    preview.style.display = "block";
  }

  function hideHoverPreview() {
    const preview = document.getElementById("iwc-hover-preview");
    if (preview) preview.style.display = "none";
  }

  function setStatus(msg) {
    const el = document.getElementById("iwc-status");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function setError(msg) {
    const el = document.getElementById("iwc-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  function extractModelUsernameFromUrl(url) {
    const m = url.match(/\/store\/\d+\/([^/?#]+)/);
    return m ? m[1] : null;
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

  // ── Plugin config (performerStoreMap + proxyUrl) — same read-modify-write
  // pattern as TagChips.js, independent of the Python side's own copy of
  // the same read/write logic (both talk to the same configurePlugin store).

  async function readConfig() {
    const data = await gql(`{ configuration { plugins } }`);
    const cfg = (data.configuration.plugins || {})[PLUGIN_ID] || {};
    return {
      performerStoreMap: cfg.performerStoreMap || {},
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

  // ── Run Python task and read result from __iwc_result__ tag ───────────────
  // Python's result shape is {ok, output} / {ok:false, error}, not Data18's
  // {output}/{error} shape -- checked against ok explicitly.

  async function runTask(taskName, args) {
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

    for (let i = 0; i < 90; i++) {
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

  // ── Fetch current scene ────────────────────────────────────────────────────

  async function fetchCurrentScene(sceneId) {
    const data = await gql(`
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id title date details urls
          files { basename }
          studio { id name }
          performers { id name }
          paths { screenshot }
        }
      }
    `, { id: sceneId });
    return data.findScene;
  }

  // ── Create performer/studio in local Stash (name only -- no external
  // database to enrich from, unlike Data18's StashDB-backed performer
  // creation) ────────────────────────────────────────────────────────────────

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

  // ── Apply scraped metadata directly via GraphQL ───────────────────────────

  async function applyToScene(sceneId, fieldChecks, selPerfNames, scraped, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail) {
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
    // "current" (the default) means don't touch cover_image at all --
    // only send it when the scraped image was explicitly picked.
    if (coverPick === "scraped" && scrapedThumbnail) input.cover_image = scrapedThumbnail;
    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
  }

  // Bumps lastUsedAt on a successful (applied) scrape, for the "Last used
  // stores" quick-pick. Reads config fresh rather than trusting storeInfo
  // held in memory, since storeInfo written at confirm-time doesn't carry
  // a prior lastUsedAt forward. Non-critical -- never blocks a completed
  // apply on a config-write failure.
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
      btn.textContent = "iWantClips";
      btn.title = "Scrape iWantClips and match to local Stash";
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
      <div id="iwc-box">
        <div id="iwc-header">
          <span>iWantClips → Stash</span>
          <button id="iwc-close">✕</button>
        </div>
        <div id="iwc-tabs">
          <button id="iwc-tab-scrape" class="iwc-tab iwc-tab-active">Scrape</button>
          <button id="iwc-tab-manage" class="iwc-tab">Manage Known Stores</button>
        </div>
        <div id="iwc-error"  style="display:none"></div>
        <div id="iwc-status" style="display:none"></div>
        <div id="iwc-content"></div>
      </div>
      <div id="iwc-hover-preview"><img alt=""></div>`;
    document.body.appendChild(overlay);
    document.getElementById("iwc-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    document.getElementById("iwc-tab-scrape").onclick = () => switchTab(sceneId, "scrape");
    document.getElementById("iwc-tab-manage").onclick = () => switchTab(sceneId, "manage");

    // ── Drag to move (mirrors Data18StashDB_v2.js's implementation) ─────────
    const box    = document.getElementById("iwc-box");
    const header = document.getElementById("iwc-header");
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
      if (e.target.closest("button")) return; // don't start a drag from the close button
      // Resolve current pixel position before dropping the CSS transform
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
    document.getElementById("iwc-tab-scrape").classList.toggle("iwc-tab-active", tab === "scrape");
    document.getElementById("iwc-tab-manage").classList.toggle("iwc-tab-active", tab === "manage");
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
    getContent().innerHTML = `<p class="iwc-hint">Loading scene info…</p>`;

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
      <div class="iwc-section-label">Last used stores</div>
      <div class="iwc-suggestions">
        ${recentEntries.map(([key, e]) => `
          <span class="iwc-suggestion-chip iwc-quickpick-chip" data-key="${esc(key)}">${esc(e.displayName || e.modelUsername)}</span>
        `).join("")}
      </div>` : "";

    getContent().innerHTML = `
      ${quickPickHtml}
      <p class="iwc-hint">Filename to parse (edit if needed):</p>
      <div class="iwc-row">
        <input id="iwc-filename" class="iwc-input" type="text" value="${esc(basename)}" />
        <button id="iwc-parse" class="iwc-btn iwc-btn-primary">Parse</button>
      </div>`;

    document.querySelectorAll(".iwc-quickpick-chip").forEach(chip => {
      chip.addEventListener("click", async () => {
        const key = chip.dataset.key;
        const entry = cfg.performerStoreMap[key];
        // Skips the *performer/store discovery* half of parsing (that part
        // is already known from the quick-pick), but still runs the real
        // filename parse to get an actual title candidate -- title
        // extraction always runs the same way regardless of how the store
        // was confirmed.
        chip.style.opacity = ".5"; chip.style.pointerEvents = "none";
        setStatus("Parsing filename…");
        try {
          const filename = document.getElementById("iwc-filename")?.value.trim() || basename;
          const parsed = await runTask("Parse Filename", { filename });
          setStatus("");
          renderMatchState(sceneId, current,
            { performerCandidate: entry.displayName || entry.modelUsername, titleCandidate: parsed.titleCandidate },
            { confidence: "confident", source: "quickpick", match: entry, score: 1, suggestions: [] });
        } catch (e) {
          setStatus("");
          setError(e.message);
          chip.style.opacity = ""; chip.style.pointerEvents = "";
        }
      });
    });

    const input = document.getElementById("iwc-filename");
    const btn = document.getElementById("iwc-parse");

    async function go() {
      const filename = input.value.trim();
      if (!filename) { setError("Enter a filename"); return; }
      setError("");
      btn.disabled = true; btn.textContent = "Parsing…";
      setStatus("Parsing filename…");
      try {
        const parsed = await runTask("Parse Filename", { filename });
        setStatus("Matching performer to a known store…");
        const match = await runTask("Match Performer Store", { performer_name: parsed.performerCandidate });
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
      <span class="iwc-suggestion-chip" data-model="${esc(s.modelUsername)}" data-url="${esc(s.storeUrl)}" data-display="${esc(s.displayName)}">
        ${esc(s.displayName)} (${Math.round(s.score * 100)}%)
      </span>`).join("");

    const boxHtml = isConfident ? `
      <div class="iwc-confidence-box iwc-confidence-confident">
        <div class="iwc-confidence-title">✓ Matched known store: ${esc(match.match.displayName)}</div>
        <div class="iwc-hint">Source: ${esc(match.source)}${match.score < 1 ? ` (score ${match.score})` : ""}</div>
      </div>` : `
      <div class="iwc-confidence-box iwc-confidence-none">
        <div class="iwc-confidence-title">⚠ No confident match — pick a suggestion or paste a store URL</div>
        ${suggestionsHtml ? `<div class="iwc-hint">Did you mean:</div><div class="iwc-suggestions">${suggestionsHtml}</div>` : ""}
      </div>`;

    getContent().innerHTML = `
      <div class="iwc-section-label">Performer</div>
      <div class="iwc-row">
        <input id="iwc-performer" class="iwc-input" type="text" value="${esc(parsed.performerCandidate)}" />
      </div>
      ${boxHtml}
      ${!isConfident ? `
        <div class="iwc-row">
          <input id="iwc-store-url" class="iwc-input" type="url" placeholder="Paste store URL, e.g. https://iwantclips.com/store/145/BrattyNikki" />
        </div>` : ""}
      <div class="iwc-section-label">Search terms (clip title)</div>
      <div class="iwc-row">
        <input id="iwc-query" class="iwc-input" type="text" value="${esc(parsed.titleCandidate)}" />
      </div>
      <div class="iwc-row">
        <button id="iwc-confirm" class="iwc-btn iwc-btn-primary">${isConfident ? "Confirm &amp; Search" : "Search"}</button>
        <button id="iwc-back0" class="iwc-btn iwc-btn-secondary">← Back</button>
      </div>`;

    document.getElementById("iwc-back0").onclick = () => renderFilenameInput(sceneId);

    let selectedStore = isConfident ? match.match : null;

    document.querySelectorAll(".iwc-suggestion-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        selectedStore = {
          modelUsername: chip.dataset.model,
          storeUrl: chip.dataset.url,
          displayName: chip.dataset.display,
        };
        document.querySelectorAll(".iwc-suggestion-chip").forEach(c => { c.style.outline = ""; });
        chip.style.outline = "2px solid #6ea8fe";
        const urlInput = document.getElementById("iwc-store-url");
        if (urlInput) urlInput.value = chip.dataset.url;
      });
    });

    document.getElementById("iwc-confirm").onclick = async () => {
      const performerName = document.getElementById("iwc-performer").value.trim();
      const queryText = document.getElementById("iwc-query").value.trim();
      if (!performerName) { setError("Performer name is required"); return; }

      let storeInfo = selectedStore;
      if (!storeInfo) {
        const urlInput = document.getElementById("iwc-store-url");
        const pastedUrl = urlInput?.value.trim();
        if (!pastedUrl) { setError("Confirm a store first — pick a suggestion or paste a store URL"); return; }
        const modelUsername = extractModelUsernameFromUrl(pastedUrl);
        if (!modelUsername) { setError("Could not parse a store slug out of that URL"); return; }
        storeInfo = { modelUsername, storeUrl: pastedUrl, displayName: performerName };
      }

      setError("");
      const btn = document.getElementById("iwc-confirm");
      btn.disabled = true; btn.textContent = "Searching…";
      setStatus("Confirming store & searching…");

      try {
        // Write to performerStoreMap immediately on confirm (auto or
        // manual) -- one-time cost per performer going forward.
        const cfg = await readConfig();
        const storeKey = normalize(performerName);
        await writeConfig({
          performerStoreMap: {
            ...cfg.performerStoreMap,
            [storeKey]: storeInfo,
          },
        });

        const searchOutput = await runTask("Search Store", {
          store_url: storeInfo.storeUrl,
          model_username: storeInfo.modelUsername,
          query_text: queryText,
        });
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
      getContent().innerHTML = `
        <p class="iwc-hint">No results found in ${esc(storeInfo.displayName)}'s store for that search.</p>
        <div class="iwc-row"><button id="iwc-back1" class="iwc-btn iwc-btn-secondary">← Back</button></div>`;
      document.getElementById("iwc-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
      return;
    }

    function shortDesc(text) {
      if (!text) return "";
      return text.length > 120 ? text.slice(0, 117) + "…" : text;
    }

    const cardsHtml = hits.map((h, i) => `
      <div class="iwc-result-card" data-idx="${i}">
        ${thumbWithHover(h.thumbnail, "iwc-result-thumb")}
        <div class="iwc-result-info">
          <div class="iwc-result-title">${esc(h.title || "(no title)")}</div>
          <div class="iwc-result-sub">${esc(h.category || "")}${h.price != null ? ` — $${h.price}` : ""}</div>
          ${h.description ? `<div class="iwc-result-desc">${esc(shortDesc(h.description))}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      <p class="iwc-hint">${searchOutput.found} result${searchOutput.found !== 1 ? "s" : ""} in ${esc(storeInfo.displayName)}'s store — click to select:</p>
      <div class="iwc-results">${cardsHtml}</div>
      <div class="iwc-row"><button id="iwc-back1" class="iwc-btn iwc-btn-secondary">← Back</button></div>`;

    bindThumbHovers();

    document.querySelectorAll(".iwc-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        const hit = hits[+card.dataset.idx];
        card.classList.add("iwc-card-loading");
        setStatus("Scraping clip…");
        try {
          const scrapeOutput = await runTask("Scrape Clip", { url: hit.contentUrl, studio_name: storeInfo.displayName });
          setStatus("");
          renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail);
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("iwc-card-loading");
        }
      });
    });

    document.getElementById("iwc-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
  }

  // ── Scrape flow: Step 4 — comparison table ────────────────────────────────

  function matchBadge(found) {
    return found
      ? `<span class="iwc-badge iwc-badge-found">✓ in Stash</span>`
      : `<span class="iwc-badge iwc-badge-missing">✗ not found</span>`;
  }

  function renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail) {
    setError("");
    const scraped = scrapeOutput.scraped;
    const resolvedPerformers = scrapeOutput.resolvedPerformers || [];
    const resolvedStudio = scrapeOutput.resolvedStudio;

    const perfRowHtml = resolvedPerformers.length ? `
      <div class="iwc-compare-row">
        <div class="iwc-compare-label">Performers</div>
        <div class="iwc-compare-current">${esc((current.performers || []).map(p => p.name).join(", ") || "—")}</div>
        <div class="iwc-compare-incoming">
          ${resolvedPerformers.map(p => `
            <div class="iwc-perf-row">
              <label class="iwc-item-label">
                <input type="checkbox" class="iwc-perf-chk" data-name="${esc(p.name)}" ${p.found ? "checked" : ""} />
                <span>${esc(p.name)} ${matchBadge(p.found)}</span>
              </label>
              ${!p.found ? `
                <button class="iwc-btn iwc-btn-secondary iwc-btn-xs iwc-perf-create" data-name="${esc(p.name)}" type="button">Create in Stash</button>
                <span class="iwc-perf-inline-msg"></span>` : ""}
            </div>`).join("")}
        </div>
        <div class="iwc-compare-toggle"><input type="checkbox" class="iwc-field-chk" data-field="performers" checked /></div>
      </div>` : "";

    const studioIncomingHtml = resolvedStudio && resolvedStudio.name ? `
      <div class="iwc-perf-row">
        <span>${esc(resolvedStudio.name)} ${matchBadge(resolvedStudio.found)}</span>
        ${!resolvedStudio.found ? `
          <button class="iwc-btn iwc-btn-secondary iwc-btn-xs iwc-studio-create" data-name="${esc(resolvedStudio.name)}" type="button">Create in Stash</button>
          <span class="iwc-perf-inline-msg"></span>` : ""}
      </div>` : "—";

    // Confirmed live via introspection: SceneUpdateInput.cover_image is a
    // plain String ("a URL or a base64 encoded data URL") -- no separate
    // upload/imageCreate mechanism needed, same as Data18's own
    // `input.cover_image = match.image` pattern. Defaults to "current" so
    // a bad scrape never silently overwrites a good existing cover.
    const currentImageUrl = current.paths?.screenshot || "";
    const defaultCoverPick = currentImageUrl ? "current" : "scraped";
    const imageRowHtml = (currentImageUrl || scrapedThumbnail) ? `
      <div class="iwc-compare-row">
        <div class="iwc-compare-label">Cover Image</div>
        <div class="iwc-compare-current">
          ${thumbWithHover(currentImageUrl, "iwc-result-thumb")}
          ${currentImageUrl ? `
            <label class="iwc-item-label" style="margin-top:.3rem">
              <input type="radio" name="iwc-cover-pick" value="current" ${defaultCoverPick === "current" ? "checked" : ""} />
              <span>Keep current</span>
            </label>` : ""}
        </div>
        <div class="iwc-compare-incoming">
          ${thumbWithHover(scrapedThumbnail, "iwc-result-thumb")}
          ${scrapedThumbnail ? `
            <label class="iwc-item-label" style="margin-top:.3rem">
              <input type="radio" name="iwc-cover-pick" value="scraped" ${defaultCoverPick === "scraped" ? "checked" : ""} />
              <span>Use scraped</span>
            </label>` : ""}
        </div>
        <div class="iwc-compare-toggle"></div>
      </div>` : "";

    // Description moves to its own row at the bottom of the table (see
    // descriptionRowHtml below), with an editable textarea instead of a
    // static, cramped single-line cell -- so it's deliberately excluded
    // from the normal scalarFields loop.
    const scalarFields = [
      ["title",   "Title",              current.title,               scraped.title],
      ["date",    "Date",               current.date,                scraped.date],
      ["studio",  "Studio",             current.studio?.name,        studioIncomingHtml],
      ["urls",    "URLs (will merge)",  (current.urls || []).join(", "), contentUrl],
    ].filter(([, , , inc]) => inc);

    const scalarRowsHtml = scalarFields.map(([field, label, cur, inc]) => `
      <div class="iwc-compare-row">
        <div class="iwc-compare-label">${esc(label)}</div>
        <div class="iwc-compare-current">${esc(cur || "—")}</div>
        <div class="iwc-compare-incoming">${field === "studio" ? inc : esc(inc)}</div>
        <div class="iwc-compare-toggle"><input type="checkbox" class="iwc-field-chk" data-field="${field}" checked /></div>
      </div>`).join("");

    // Description: own row at the bottom, taller, with an editable
    // textarea pre-filled from the scraped value -- Apply uses whatever
    // is in the textarea at submit time (the user's edits), not the
    // original scraped text. The "Use" checkbox still gates whether it's
    // applied at all.
    const descriptionRowHtml = scraped.description ? `
      <div class="iwc-compare-row iwc-compare-row-tall">
        <div class="iwc-compare-label">Description</div>
        <div class="iwc-compare-current iwc-trunc">${esc(current.details || "—")}</div>
        <div class="iwc-compare-incoming">
          <textarea id="iwc-details-edit" class="iwc-textarea">${esc(scraped.description)}</textarea>
        </div>
        <div class="iwc-compare-toggle"><input type="checkbox" class="iwc-field-chk" data-field="details" checked /></div>
      </div>` : "";

    getContent().innerHTML = `
      <div class="iwc-compare-table">
        <div class="iwc-compare-header">
          <div class="iwc-compare-label"></div>
          <div class="iwc-compare-current">Current</div>
          <div class="iwc-compare-incoming">Incoming (iWantClips)</div>
          <div class="iwc-compare-toggle">Use</div>
        </div>
        ${imageRowHtml}
        ${scalarRowsHtml}
        ${perfRowHtml}
        ${descriptionRowHtml}
      </div>
      <div class="iwc-row" style="margin-top:.75rem;flex-shrink:0">
        <button id="iwc-back2"   class="iwc-btn iwc-btn-secondary">← Back</button>
        <button id="iwc-selall"  class="iwc-btn iwc-btn-secondary">All</button>
        <button id="iwc-selnone" class="iwc-btn iwc-btn-secondary">None</button>
        <button id="iwc-apply"   class="iwc-btn iwc-btn-primary">Apply to Scene</button>
      </div>`;

    bindThumbHovers();

    document.getElementById("iwc-back2").onclick = () => renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput);
    document.getElementById("iwc-selall").onclick  = () =>
      document.querySelectorAll(".iwc-field-chk,.iwc-perf-chk").forEach(c => { c.checked = true; });
    document.getElementById("iwc-selnone").onclick = () =>
      document.querySelectorAll(".iwc-field-chk,.iwc-perf-chk").forEach(c => { c.checked = false; });

    document.getElementById("iwc-apply").onclick = async () => {
      const fieldChecks = {};
      document.querySelectorAll(".iwc-field-chk").forEach(cb => { fieldChecks[cb.dataset.field] = cb.checked; });
      const selPerfs = [...document.querySelectorAll(".iwc-perf-chk:checked")].map(cb => cb.dataset.name);
      const coverPick = document.querySelector('input[name="iwc-cover-pick"]:checked')?.value || "current";
      // Whatever is in the textarea *at submit time* -- the user's edits,
      // if any -- not the original unedited scraped value.
      const detailsTextarea = document.getElementById("iwc-details-edit");
      const scrapedForApply = detailsTextarea ? { ...scraped, description: detailsTextarea.value } : scraped;

      if (!Object.values(fieldChecks).some(Boolean) && !selPerfs.length) {
        setError("Select at least one field"); return;
      }

      setError("");
      const btn = document.getElementById("iwc-apply");
      btn.disabled = true; btn.textContent = "Applying…";
      setStatus("Writing to scene…");

      try {
        await applyToScene(sceneId, fieldChecks, selPerfs, scrapedForApply, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail);
        await bumpLastUsed(storeKey, storeInfo);
        setStatus("");
        renderDone();
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Apply to Scene"; setStatus("");
      }
    };

    document.querySelectorAll(".iwc-perf-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".iwc-perf-row");
        const msgEl = row?.querySelector(".iwc-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createPerformerInStash(name);
          const entry = resolvedPerformers.find(p => p.name === name);
          if (entry) { entry.localId = created.id; entry.found = true; }
          const chk = row?.querySelector(".iwc-perf-chk");
          const badge = row?.querySelector(".iwc-badge");
          if (chk) chk.checked = true;
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "iwc-perf-inline-msg iwc-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "iwc-perf-inline-msg iwc-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });

    document.querySelectorAll(".iwc-studio-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".iwc-perf-row");
        const msgEl = row?.querySelector(".iwc-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createStudioInStash(name);
          if (resolvedStudio) { resolvedStudio.localId = created.id; resolvedStudio.found = true; }
          const badge = row?.querySelector(".iwc-badge");
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "iwc-perf-inline-msg iwc-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "iwc-perf-inline-msg iwc-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });
  }

  // ── Scrape flow: Step 5 — done ────────────────────────────────────────────

  function renderDone() {
    setError(""); setStatus("");
    getContent().innerHTML = `<div class="iwc-success">✓ Scene updated! Reloading…</div>`;
    setTimeout(() => window.location.reload(), 1500);
  }

  // ── Manage Known Stores tab ────────────────────────────────────────────────

  function renderStoreList(sceneId) {
    setError("");
    getContent().innerHTML = `<p class="iwc-hint">Loading known stores…</p>`;
    readConfig().then(cfg => {
      const map = cfg.performerStoreMap || {};
      const entries = Object.entries(map);
      getContent().innerHTML = `
        <div class="iwc-row">
          <span class="iwc-section-label" style="margin:0">Known Stores</span>
          <button id="iwc-store-new" class="iwc-store-manage-btn">+ add store</button>
        </div>
        ${entries.length === 0 ? `<div class="iwc-hint">No stores confirmed yet.</div>` : `
          <div class="iwc-store-list">
            ${entries.map(([key, entry]) => `
              <div class="iwc-store-row" data-key="${esc(key)}">
                <span class="iwc-store-name">${esc(entry.displayName || entry.modelUsername)}</span>
                <a class="iwc-store-url" href="${esc(entry.storeUrl)}" target="_blank" rel="noopener">${esc(entry.storeUrl)}</a>
                <button class="iwc-store-manage-btn iwc-store-edit" data-key="${esc(key)}">edit</button>
                <button class="iwc-store-manage-btn iwc-store-delete" data-key="${esc(key)}">delete</button>
              </div>`).join("")}
          </div>`}`;

      document.getElementById("iwc-store-new").onclick = () => renderStoreEditor(sceneId, null);
      document.querySelectorAll(".iwc-store-edit").forEach(btn =>
        btn.addEventListener("click", () =>
          renderStoreEditor(sceneId, { key: btn.dataset.key, ...map[btn.dataset.key] })));
      document.querySelectorAll(".iwc-store-delete").forEach(btn =>
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
      <div class="iwc-row">
        <input id="iwc-edit-name" class="iwc-input" placeholder="Performer name" value="${esc(item?.displayName || "")}" />
      </div>
      <div class="iwc-row">
        <input id="iwc-edit-url" class="iwc-input" placeholder="Store URL, e.g. https://iwantclips.com/store/145/BrattyNikki" value="${esc(item?.storeUrl || "")}" />
      </div>
      <div class="iwc-row">
        <button id="iwc-edit-save" class="iwc-btn iwc-btn-primary">${item ? "Save" : "Create"}</button>
        ${item ? `<button id="iwc-edit-delete" class="iwc-btn iwc-btn-danger">Delete</button>` : ""}
        <button id="iwc-edit-cancel" class="iwc-btn iwc-btn-secondary">Cancel</button>
      </div>`;

    document.getElementById("iwc-edit-cancel").onclick = () => renderStoreList(sceneId);

    document.getElementById("iwc-edit-save").onclick = async () => {
      const name = document.getElementById("iwc-edit-name").value.trim();
      const url = document.getElementById("iwc-edit-url").value.trim();
      if (!name || !url) { setError("Performer name and store URL are both required"); return; }
      const modelUsername = extractModelUsernameFromUrl(url);
      if (!modelUsername) { setError("Could not parse a store slug out of that URL"); return; }

      const current = await readConfig();
      const next = { ...current.performerStoreMap };
      if (item && item.key && item.key !== normalize(name)) delete next[item.key];
      next[normalize(name)] = { modelUsername, storeUrl: url, displayName: name };
      await writeConfig({ performerStoreMap: next });
      renderStoreList(sceneId);
    };

    if (item) {
      document.getElementById("iwc-edit-delete").onclick = async () => {
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
