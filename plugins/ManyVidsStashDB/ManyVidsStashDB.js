// ManyVidsStashDB.js
// Adds a "ManyVids" button to the scene toolbar. Same architecture as
// IWantClipsStashDB.js: no patch point exists for arbitrary toolbar
// buttons, so this injects into .scene-toolbar via MutationObserver and
// opens a plain-DOM modal -- no React/patch access needed or used.
//
// The only functional difference from IWantClipsStashDB: ManyVids has no
// server-side search (confirmed live -- q=/search=/keyword=/title=/filter=
// were all silently ignored) and no performer-directory sitemap to fuzzy-
// match against. "Search Store" is replaced by "Match Clips" (a full
// paginated catalog fetch + local fuzzy title match), and unconfirmed
// performers never get "did you mean" suggestions -- only a manual store
// URL paste. Everything else (tabs, confidence states, quick-pick,
// draggable modal, hover-enlarge thumbnails, comparison table with an
// editable description textarea) is reused as-is.

(function () {
  "use strict";

  if (window._manyVidsStashDBLoaded) return;
  window._manyVidsStashDBLoaded = true;

  const PLUGIN_ID  = "ManyVidsStashDB";
  const BTN_ID     = "mv-open-btn";
  const MODAL_ID   = "mv-modal-overlay";
  const RESULT_TAG = "__mv_result__";

  // ── Utilities ──────────────────────────────────────────────────────────────

  function getSceneId()  { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage() { return !!getSceneId(); }
  function getModal()    { return document.getElementById(MODAL_ID); }
  function getContent()  { return document.getElementById("mv-content"); }

  function normalize(s) {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // Shared hover-enlarge thumbnail markup (mirrors IWantClipsStashDB.js's
  // .iwc-thumb-wrap/#iwc-hover-preview pattern), reused for both search
  // result cards and the cover-image comparison row.
  function thumbWithHover(url, thumbClass) {
    if (!url) return `<div class="${thumbClass} mv-no-img"></div>`;
    // A single shared preview element lives as a sibling of #mv-box (see
    // openModal) and gets moved/shown on hover -- see bindThumbHovers() --
    // since every thumbnail here sits inside an overflow:auto/hidden
    // ancestor that would otherwise clip a nested hover child.
    return `<div class="mv-thumb-wrap" data-full="${esc(url)}">
      <img class="${thumbClass}" src="${esc(url)}" alt="">
    </div>`;
  }

  function bindThumbHovers() {
    document.querySelectorAll(".mv-thumb-wrap[data-full]").forEach(wrap => {
      wrap.addEventListener("mouseenter", () => showHoverPreview(wrap));
      wrap.addEventListener("mouseleave", hideHoverPreview);
    });
  }

  function showHoverPreview(wrapEl) {
    const preview = document.getElementById("mv-hover-preview");
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
    const preview = document.getElementById("mv-hover-preview");
    if (preview) preview.style.display = "none";
  }

  function setStatus(msg) {
    const el = document.getElementById("mv-status");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function setError(msg) {
    const el = document.getElementById("mv-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  function extractProfileIdFromUrl(url) {
    const m = url.match(/\/Profile\/(\d+)/i);
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
  // pattern as IWantClipsStashDB.js. ─────────────────────────────────────────

  async function readConfig() {
    const data = await gql(`{ configuration { plugins } }`);
    const cfg = (data.configuration.plugins || {})[PLUGIN_ID] || {};
    return {
      performerStoreMap: cfg.performerStoreMap || {},
      proxyUrl: cfg.proxyUrl || "",
      // Never read/written from JS directly (ManyVidsStashDB.py owns this
      // cache entirely), but writeConfig()'s {...current, ...patch} merge
      // means any field readConfig() doesn't round-trip here gets silently
      // dropped on the NEXT writeConfig call from anywhere in this file
      // (e.g. the performerStoreMap write on every "Confirm & Search"
      // click) -- confirmed live this was wiping out the Python-side cache
      // moments before every repeat scrape's Match Clips task even ran,
      // defeating the cache on every call after the first.
      storeCatalogCache: cfg.storeCatalogCache || {},
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

  // ── Run Python task and read result from __mv_result__ tag ────────────────
  // "Match Clips" does a full paginated store crawl (no server-side search
  // exists on ManyVids -- see file header), which can take noticeably
  // longer than a single live search API call, so this polls for longer
  // than IWantClipsStashDB.js's 90s cap before giving up.

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
    if (coverPick === "scraped" && scrapedThumbnail) input.cover_image = scrapedThumbnail;
    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
  }

  // Bumps lastUsedAt on a successful (applied) scrape, for the "Last used
  // stores" quick-pick.
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
      btn.textContent = "ManyVids";
      btn.title = "Scrape ManyVids and match to local Stash";
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
      <div id="mv-box">
        <div id="mv-header">
          <span>ManyVids → Stash</span>
          <button id="mv-close">✕</button>
        </div>
        <div id="mv-tabs">
          <button id="mv-tab-scrape" class="mv-tab mv-tab-active">Scrape</button>
          <button id="mv-tab-manage" class="mv-tab">Manage Known Stores</button>
        </div>
        <div id="mv-error"  style="display:none"></div>
        <div id="mv-status" style="display:none"></div>
        <div id="mv-content"></div>
      </div>
      <div id="mv-hover-preview"><img alt=""></div>`;
    document.body.appendChild(overlay);
    document.getElementById("mv-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    document.getElementById("mv-tab-scrape").onclick = () => switchTab(sceneId, "scrape");
    document.getElementById("mv-tab-manage").onclick = () => switchTab(sceneId, "manage");

    // ── Drag to move (mirrors IWantClipsStashDB.js's implementation) ────────
    const box    = document.getElementById("mv-box");
    const header = document.getElementById("mv-header");
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
    document.getElementById("mv-tab-scrape").classList.toggle("mv-tab-active", tab === "scrape");
    document.getElementById("mv-tab-manage").classList.toggle("mv-tab-active", tab === "manage");
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
    getContent().innerHTML = `<p class="mv-hint">Loading scene info…</p>`;

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
      <div class="mv-section-label">Last used stores</div>
      <div class="mv-suggestions">
        ${recentEntries.map(([key, e]) => `
          <span class="mv-suggestion-chip mv-quickpick-chip" data-key="${esc(key)}">${esc(e.displayName || e.profileId)}</span>
        `).join("")}
      </div>` : "";

    getContent().innerHTML = `
      ${quickPickHtml}
      <p class="mv-hint">Filename to parse (edit if needed):</p>
      <div class="mv-row">
        <input id="mv-filename" class="mv-input" type="text" value="${esc(basename)}" />
        <button id="mv-parse" class="mv-btn mv-btn-primary">Parse</button>
      </div>`;

    document.querySelectorAll(".mv-quickpick-chip").forEach(chip => {
      chip.addEventListener("click", async () => {
        const key = chip.dataset.key;
        const entry = cfg.performerStoreMap[key];
        chip.style.opacity = ".5"; chip.style.pointerEvents = "none";
        setStatus("Parsing filename…");
        try {
          const filename = document.getElementById("mv-filename")?.value.trim() || basename;
          const parsed = await runTask("Parse Filename", { filename });
          setStatus("");
          renderMatchState(sceneId, current,
            { performerCandidate: entry.displayName || entry.profileId, titleCandidate: parsed.titleCandidate },
            { confidence: "confident", source: "quickpick", match: entry, score: 1, suggestions: [] });
        } catch (e) {
          setStatus("");
          setError(e.message);
          chip.style.opacity = ""; chip.style.pointerEvents = "";
        }
      });
    });

    const input = document.getElementById("mv-filename");
    const btn = document.getElementById("mv-parse");

    async function go() {
      const filename = input.value.trim();
      if (!filename) { setError("Enter a filename"); return; }
      setError("");
      btn.disabled = true; btn.textContent = "Parsing…";
      setStatus("Parsing filename…");
      try {
        const parsed = await runTask("Parse Filename", { filename });
        setStatus("Checking known stores…");
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

    // ManyVids has no performer-directory sitemap to fuzzy-match against
    // (unlike IWantClipsStashDB), so match.suggestions is always empty here
    // -- a non-confident match always means "paste a store URL", never
    // "did you mean". The markup still supports rendering suggestion chips
    // for architectural parity/reuse, they just never appear in practice.
    const suggestionsHtml = (match.suggestions || []).map(s => `
      <span class="mv-suggestion-chip" data-id="${esc(s.profileId)}" data-url="${esc(s.storeUrl)}" data-display="${esc(s.displayName)}">
        ${esc(s.displayName)} (${Math.round(s.score * 100)}%)
      </span>`).join("");

    const boxHtml = isConfident ? `
      <div class="mv-confidence-box mv-confidence-confident">
        <div class="mv-confidence-title">✓ Matched known store: ${esc(match.match.displayName)}</div>
        <div class="mv-hint">Source: ${esc(match.source)}${match.score < 1 ? ` (score ${match.score})` : ""}</div>
      </div>` : `
      <div class="mv-confidence-box mv-confidence-none">
        <div class="mv-confidence-title">⚠ No known store yet — paste this performer's store URL</div>
        ${suggestionsHtml ? `<div class="mv-hint">Did you mean:</div><div class="mv-suggestions">${suggestionsHtml}</div>` : ""}
      </div>`;

    getContent().innerHTML = `
      <div class="mv-section-label">Performer</div>
      <div class="mv-row">
        <input id="mv-performer" class="mv-input" type="text" value="${esc(parsed.performerCandidate)}" />
      </div>
      ${boxHtml}
      ${!isConfident ? `
        <div class="mv-row">
          <input id="mv-store-url" class="mv-input" type="url" placeholder="Paste store URL, e.g. https://www.manyvids.com/Profile/1004021302/latexnchill/Store/Videos" />
        </div>` : ""}
      <div class="mv-section-label">Search terms (clip title)</div>
      <div class="mv-row">
        <input id="mv-query" class="mv-input" type="text" value="${esc(parsed.titleCandidate)}" />
      </div>
      <div class="mv-row">
        <button id="mv-confirm" class="mv-btn mv-btn-primary">${isConfident ? "Confirm &amp; Search" : "Search"}</button>
        <button id="mv-back0" class="mv-btn mv-btn-secondary">← Back</button>
      </div>`;

    document.getElementById("mv-back0").onclick = () => renderFilenameInput(sceneId);

    let selectedStore = isConfident ? match.match : null;

    document.querySelectorAll(".mv-suggestion-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        selectedStore = {
          profileId: chip.dataset.id,
          storeUrl: chip.dataset.url,
          displayName: chip.dataset.display,
        };
        document.querySelectorAll(".mv-suggestion-chip").forEach(c => { c.style.outline = ""; });
        chip.style.outline = "2px solid #6ea8fe";
        const urlInput = document.getElementById("mv-store-url");
        if (urlInput) urlInput.value = chip.dataset.url;
      });
    });

    document.getElementById("mv-confirm").onclick = async () => {
      const performerName = document.getElementById("mv-performer").value.trim();
      const queryText = document.getElementById("mv-query").value.trim();
      if (!performerName) { setError("Performer name is required"); return; }

      let storeInfo = selectedStore;
      if (!storeInfo) {
        const urlInput = document.getElementById("mv-store-url");
        const pastedUrl = urlInput?.value.trim();
        if (!pastedUrl) { setError("Confirm a store first — paste a store URL"); return; }
        const profileId = extractProfileIdFromUrl(pastedUrl);
        if (!profileId) { setError("Could not parse a numeric profile id out of that URL"); return; }
        storeInfo = { profileId, storeUrl: pastedUrl, displayName: performerName };
      }

      setError("");
      const btn = document.getElementById("mv-confirm");
      btn.disabled = true; btn.textContent = "Searching…";
      setStatus("Confirming store & fetching clip catalog… (this walks every page of the store, may take a bit for large catalogs)");

      try {
        // Write to performerStoreMap immediately on confirm -- one-time
        // cost per performer going forward.
        const cfg = await readConfig();
        const storeKey = normalize(performerName);
        await writeConfig({
          performerStoreMap: {
            ...cfg.performerStoreMap,
            [storeKey]: storeInfo,
          },
        });

        const searchOutput = await runTask("Match Clips", {
          profile_id: storeInfo.profileId,
          query_text: queryText,
        }, { pollSeconds: 240 });
        setStatus("");
        renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = isConfident ? "Confirm & Search" : "Search"; setStatus("");
      }
    };
  }

  // ── Scrape flow: Step 3 — clip-picker cards ───────────────────────────────
  // No live search box here -- there's no server-side query to send (see
  // file header). These cards are the fuzzy-matched candidates straight
  // from the "Match Clips" task, ranked by score descending.

  function renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput) {
    setError("");
    const hits = searchOutput.hits || [];

    if (!hits.length) {
      getContent().innerHTML = `
        <p class="mv-hint">No clips in ${esc(storeInfo.displayName)}'s store (${searchOutput.totalInStore ?? "?"} total) matched that title closely enough.</p>
        <div class="mv-row"><button id="mv-back1" class="mv-btn mv-btn-secondary">← Back</button></div>`;
      document.getElementById("mv-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
      return;
    }

    function shortDesc(text) {
      if (!text) return "";
      return text.length > 120 ? text.slice(0, 117) + "…" : text;
    }

    const cardsHtml = hits.map((h, i) => `
      <div class="mv-result-card" data-idx="${i}">
        ${thumbWithHover(h.thumbnail, "mv-result-thumb")}
        <div class="mv-result-info">
          <div class="mv-result-title">${esc(h.title || "(no title)")}</div>
          <div class="mv-result-sub">${h.price != null ? `$${h.price}` : ""}${h.score != null ? ` — match ${Math.round(h.score * 100)}%` : ""}</div>
          ${h.description ? `<div class="mv-result-desc">${esc(shortDesc(h.description))}</div>` : ""}
        </div>
      </div>`).join("");

    // Guardrail, not the primary sizing mechanism (all matches above
    // TITLE_MATCH_THRESHOLD are always shown, ranked, never truncated to a
    // fixed top-N) -- surfaced plainly when unusually large, since that
    // usually means the parsed title candidate was too generic.
    const warningHtml = searchOutput.largeResultWarning ? `
      <p class="mv-hint mv-warning">⚠ ${hits.length} matches — that's a lot for a specific title. The parsed title candidate may be too generic, or worth narrowing manually.</p>` : "";

    getContent().innerHTML = `
      <p class="mv-hint">${hits.length} matching clip${hits.length !== 1 ? "s" : ""} out of ${searchOutput.totalInStore ?? "?"} in ${esc(storeInfo.displayName)}'s store — click to select:</p>
      ${warningHtml}
      <div class="mv-results">${cardsHtml}</div>
      <div class="mv-row"><button id="mv-back1" class="mv-btn mv-btn-secondary">← Back</button></div>`;

    bindThumbHovers();

    document.querySelectorAll(".mv-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        const hit = hits[+card.dataset.idx];
        card.classList.add("mv-card-loading");
        setStatus("Scraping clip…");
        try {
          const scrapeOutput = await runTask("Scrape Clip", { url: hit.contentUrl, studio_name: storeInfo.displayName });
          setStatus("");
          renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail);
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("mv-card-loading");
        }
      });
    });

    document.getElementById("mv-back1").onclick = () => renderMatchState(sceneId, current, parsed, match);
  }

  // ── Scrape flow: Step 4 — comparison table ────────────────────────────────

  function matchBadge(found) {
    return found
      ? `<span class="mv-badge mv-badge-found">✓ in Stash</span>`
      : `<span class="mv-badge mv-badge-missing">✗ not found</span>`;
  }

  function renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail) {
    setError("");
    const scraped = scrapeOutput.scraped;
    const resolvedPerformers = scrapeOutput.resolvedPerformers || [];
    const resolvedStudio = scrapeOutput.resolvedStudio;

    const perfRowHtml = resolvedPerformers.length ? `
      <div class="mv-compare-row">
        <div class="mv-compare-label">Performers</div>
        <div class="mv-compare-current">${esc((current.performers || []).map(p => p.name).join(", ") || "—")}</div>
        <div class="mv-compare-incoming">
          ${resolvedPerformers.map(p => `
            <div class="mv-perf-row">
              <label class="mv-item-label">
                <input type="checkbox" class="mv-perf-chk" data-name="${esc(p.name)}" ${p.found ? "checked" : ""} />
                <span>${esc(p.name)} ${matchBadge(p.found)}</span>
              </label>
              ${!p.found ? `
                <button class="mv-btn mv-btn-secondary mv-btn-xs mv-perf-create" data-name="${esc(p.name)}" type="button">Create in Stash</button>
                <span class="mv-perf-inline-msg"></span>` : ""}
            </div>`).join("")}
        </div>
        <div class="mv-compare-toggle"><input type="checkbox" class="mv-field-chk" data-field="performers" checked /></div>
      </div>` : "";

    const studioIncomingHtml = resolvedStudio && resolvedStudio.name ? `
      <div class="mv-perf-row">
        <span>${esc(resolvedStudio.name)} ${matchBadge(resolvedStudio.found)}</span>
        ${!resolvedStudio.found ? `
          <button class="mv-btn mv-btn-secondary mv-btn-xs mv-studio-create" data-name="${esc(resolvedStudio.name)}" type="button">Create in Stash</button>
          <span class="mv-perf-inline-msg"></span>` : ""}
      </div>` : "—";

    const currentImageUrl = current.paths?.screenshot || "";
    const defaultCoverPick = currentImageUrl ? "current" : "scraped";
    const imageRowHtml = (currentImageUrl || scrapedThumbnail) ? `
      <div class="mv-compare-row">
        <div class="mv-compare-label">Cover Image</div>
        <div class="mv-compare-current">
          ${thumbWithHover(currentImageUrl, "mv-result-thumb")}
          ${currentImageUrl ? `
            <label class="mv-item-label" style="margin-top:.3rem">
              <input type="radio" name="mv-cover-pick" value="current" ${defaultCoverPick === "current" ? "checked" : ""} />
              <span>Keep current</span>
            </label>` : ""}
        </div>
        <div class="mv-compare-incoming">
          ${thumbWithHover(scrapedThumbnail, "mv-result-thumb")}
          ${scrapedThumbnail ? `
            <label class="mv-item-label" style="margin-top:.3rem">
              <input type="radio" name="mv-cover-pick" value="scraped" ${defaultCoverPick === "scraped" ? "checked" : ""} />
              <span>Use scraped</span>
            </label>` : ""}
        </div>
        <div class="mv-compare-toggle"></div>
      </div>` : "";

    const scalarFields = [
      ["title",   "Title",              current.title,               scraped.title],
      ["date",    "Date",               current.date,                scraped.date],
      ["studio",  "Studio",             current.studio?.name,        studioIncomingHtml],
      ["urls",    "URLs (will merge)",  (current.urls || []).join(", "), contentUrl],
    ].filter(([, , , inc]) => inc);

    const scalarRowsHtml = scalarFields.map(([field, label, cur, inc]) => `
      <div class="mv-compare-row">
        <div class="mv-compare-label">${esc(label)}</div>
        <div class="mv-compare-current">${esc(cur || "—")}</div>
        <div class="mv-compare-incoming">${field === "studio" ? inc : esc(inc)}</div>
        <div class="mv-compare-toggle"><input type="checkbox" class="mv-field-chk" data-field="${field}" checked /></div>
      </div>`).join("");

    const descriptionRowHtml = scraped.description ? `
      <div class="mv-compare-row mv-compare-row-tall">
        <div class="mv-compare-label">Description</div>
        <div class="mv-compare-current mv-trunc">${esc(current.details || "—")}</div>
        <div class="mv-compare-incoming">
          <textarea id="mv-details-edit" class="mv-textarea">${esc(scraped.description)}</textarea>
        </div>
        <div class="mv-compare-toggle"><input type="checkbox" class="mv-field-chk" data-field="details" checked /></div>
      </div>` : "";

    getContent().innerHTML = `
      <div class="mv-compare-table">
        <div class="mv-compare-header">
          <div class="mv-compare-label"></div>
          <div class="mv-compare-current">Current</div>
          <div class="mv-compare-incoming">Incoming (ManyVids)</div>
          <div class="mv-compare-toggle">Use</div>
        </div>
        ${imageRowHtml}
        ${scalarRowsHtml}
        ${perfRowHtml}
        ${descriptionRowHtml}
      </div>
      <div class="mv-row" style="margin-top:.75rem;flex-shrink:0">
        <button id="mv-back2"   class="mv-btn mv-btn-secondary">← Back</button>
        <button id="mv-selall"  class="mv-btn mv-btn-secondary">All</button>
        <button id="mv-selnone" class="mv-btn mv-btn-secondary">None</button>
        <button id="mv-apply"   class="mv-btn mv-btn-primary">Apply to Scene</button>
      </div>`;

    bindThumbHovers();

    document.getElementById("mv-back2").onclick = () => renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput);
    document.getElementById("mv-selall").onclick  = () =>
      document.querySelectorAll(".mv-field-chk,.mv-perf-chk").forEach(c => { c.checked = true; });
    document.getElementById("mv-selnone").onclick = () =>
      document.querySelectorAll(".mv-field-chk,.mv-perf-chk").forEach(c => { c.checked = false; });

    document.getElementById("mv-apply").onclick = async () => {
      const fieldChecks = {};
      document.querySelectorAll(".mv-field-chk").forEach(cb => { fieldChecks[cb.dataset.field] = cb.checked; });
      const selPerfs = [...document.querySelectorAll(".mv-perf-chk:checked")].map(cb => cb.dataset.name);
      const coverPick = document.querySelector('input[name="mv-cover-pick"]:checked')?.value || "current";
      const detailsTextarea = document.getElementById("mv-details-edit");
      const scrapedForApply = detailsTextarea ? { ...scraped, description: detailsTextarea.value } : scraped;

      if (!Object.values(fieldChecks).some(Boolean) && !selPerfs.length) {
        setError("Select at least one field"); return;
      }

      setError("");
      const btn = document.getElementById("mv-apply");
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

    document.querySelectorAll(".mv-perf-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".mv-perf-row");
        const msgEl = row?.querySelector(".mv-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createPerformerInStash(name);
          const entry = resolvedPerformers.find(p => p.name === name);
          if (entry) { entry.localId = created.id; entry.found = true; }
          const chk = row?.querySelector(".mv-perf-chk");
          const badge = row?.querySelector(".mv-badge");
          if (chk) chk.checked = true;
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "mv-perf-inline-msg mv-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "mv-perf-inline-msg mv-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });

    document.querySelectorAll(".mv-studio-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".mv-perf-row");
        const msgEl = row?.querySelector(".mv-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const created = await createStudioInStash(name);
          if (resolvedStudio) { resolvedStudio.localId = created.id; resolvedStudio.found = true; }
          const badge = row?.querySelector(".mv-badge");
          if (badge) badge.outerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) { msgEl.className = "mv-perf-inline-msg mv-msg-ok"; msgEl.textContent = "✓ Created"; }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create in Stash";
          if (msgEl) { msgEl.className = "mv-perf-inline-msg mv-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });
  }

  // ── Scrape flow: Step 5 — done ────────────────────────────────────────────

  function renderDone() {
    setError(""); setStatus("");
    getContent().innerHTML = `<div class="mv-success">✓ Scene updated! Reloading…</div>`;
    setTimeout(() => window.location.reload(), 1500);
  }

  // ── Manage Known Stores tab ────────────────────────────────────────────────

  function renderStoreList(sceneId) {
    setError("");
    getContent().innerHTML = `<p class="mv-hint">Loading known stores…</p>`;
    readConfig().then(cfg => {
      const map = cfg.performerStoreMap || {};
      const entries = Object.entries(map);
      getContent().innerHTML = `
        <div class="mv-row">
          <span class="mv-section-label" style="margin:0">Known Stores</span>
          <button id="mv-store-new" class="mv-store-manage-btn">+ add store</button>
        </div>
        ${entries.length === 0 ? `<div class="mv-hint">No stores confirmed yet.</div>` : `
          <div class="mv-store-list">
            ${entries.map(([key, entry]) => `
              <div class="mv-store-row" data-key="${esc(key)}">
                <span class="mv-store-name">${esc(entry.displayName || entry.profileId)}</span>
                <a class="mv-store-url" href="${esc(entry.storeUrl)}" target="_blank" rel="noopener">${esc(entry.storeUrl)}</a>
                <button class="mv-store-manage-btn mv-store-edit" data-key="${esc(key)}">edit</button>
                <button class="mv-store-manage-btn mv-store-delete" data-key="${esc(key)}">delete</button>
              </div>`).join("")}
          </div>`}`;

      document.getElementById("mv-store-new").onclick = () => renderStoreEditor(sceneId, null);
      document.querySelectorAll(".mv-store-edit").forEach(btn =>
        btn.addEventListener("click", () =>
          renderStoreEditor(sceneId, { key: btn.dataset.key, ...map[btn.dataset.key] })));
      document.querySelectorAll(".mv-store-delete").forEach(btn =>
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
      <div class="mv-row">
        <input id="mv-edit-name" class="mv-input" placeholder="Performer name" value="${esc(item?.displayName || "")}" />
      </div>
      <div class="mv-row">
        <input id="mv-edit-url" class="mv-input" placeholder="Store URL, e.g. https://www.manyvids.com/Profile/1004021302/latexnchill/Store/Videos" value="${esc(item?.storeUrl || "")}" />
      </div>
      <div class="mv-row">
        <button id="mv-edit-save" class="mv-btn mv-btn-primary">${item ? "Save" : "Create"}</button>
        ${item ? `<button id="mv-edit-delete" class="mv-btn mv-btn-danger">Delete</button>` : ""}
        <button id="mv-edit-cancel" class="mv-btn mv-btn-secondary">Cancel</button>
      </div>`;

    document.getElementById("mv-edit-cancel").onclick = () => renderStoreList(sceneId);

    document.getElementById("mv-edit-save").onclick = async () => {
      const name = document.getElementById("mv-edit-name").value.trim();
      const url = document.getElementById("mv-edit-url").value.trim();
      if (!name || !url) { setError("Performer name and store URL are both required"); return; }
      const profileId = extractProfileIdFromUrl(url);
      if (!profileId) { setError("Could not parse a numeric profile id out of that URL"); return; }

      const current = await readConfig();
      const next = { ...current.performerStoreMap };
      if (item && item.key && item.key !== normalize(name)) delete next[item.key];
      next[normalize(name)] = { profileId, storeUrl: url, displayName: name };
      await writeConfig({ performerStoreMap: next });
      renderStoreList(sceneId);
    };

    if (item) {
      document.getElementById("mv-edit-delete").onclick = async () => {
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
