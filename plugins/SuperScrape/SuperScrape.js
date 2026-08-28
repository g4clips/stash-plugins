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
  const LIBRARY_BTN_ID = "ss-batch-toolbar-btn";
  const BATCH_MODAL_ID = "ss-batch-modal-overlay";

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
    if (site === "stashdb") return "StashDB";
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
      stashDbFirstEnabled: cfg.stashDbFirstEnabled !== undefined ? !!cfg.stashDbFirstEnabled : true,
      markOrganizedDefault: !!cfg.markOrganizedDefault,
      addZzzUploadTagDefault: !!cfg.addZzzUploadTagDefault,
      skipZzzUploadForStashDbDefault: cfg.skipZzzUploadForStashDbDefault !== undefined ? !!cfg.skipZzzUploadForStashDbDefault : true,
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
          stash_ids { stash_id endpoint }
          files { basename fingerprints { type value } }
          studio { id name }
          performers { id name }
          tags { id name }
          groups { group { id name } scene_index }
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

  function primaryPhash(current) {
    return currentScenePhashes(current)[0] || null;
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

  // Look up a tag by exact name, creating it if it doesn't exist yet --
  // same find-or-create shape as marker-scenes' zzz-virtual lookup, but
  // this one creates on miss instead of erroring, since zzz-upload is a
  // plugin-owned marker tag rather than something the user is expected to
  // have pre-created.
  async function findOrCreateTagByName(name) {
    const data = await gql(
      `query F($name:String!){ findTags(tag_filter:{ name:{ value:$name, modifier: EQUALS } }, filter:{ per_page: 1 }){ tags{ id name } } }`,
      { name }
    );
    const found = (data.findTags.tags || [])[0];
    if (found) return found.id;
    const result = await gql(
      `mutation($input: TagCreateInput!){ tagCreate(input:$input){ id name } }`,
      { input: { name } }
    );
    if (!result.tagCreate) throw new Error("Create mutation returned no result");
    return result.tagCreate.id;
  }

  // ── Tags (flat picker -- see renderApply) ──────────────────────────────────

  async function fetchAllTags() {
    // Server already sorts by name (ASC); this client-side re-sort just
    // guarantees a case-insensitive ordering regardless of the server's
    // collation, and gives drawTagGrid's flat/filtered views a stable,
    // predictable order (previously sorted by scene_count desc, which made
    // chips jump around unpredictably between scenes -- alphabetical fixes
    // that).
    const data = await gql(`
      query SuperScrapeAllTags {
        findTags(filter: { per_page: -1, sort: "name", direction: ASC }) {
          tags { id name scene_count }
        }
      }
    `);
    return data.findTags.tags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  // Batched by id (confirmed live: PerformerFilterType has no `id`
  // field to filter by, but findPerformers' top-level `performer_ids`
  // arg -- typed [Int!], not [ID!] -- does the job in one query instead
  // of one per matched performer).
  async function fetchPerformerTags(ids) {
    if (!ids.length) return [];
    const data = await gql(`
      query SuperScrapePerformerTags($ids: [Int!]) {
        findPerformers(performer_ids: $ids) {
          performers { id tags { id } }
        }
      }
    `, { ids });
    return data.findPerformers.performers;
  }

  // ── Apply scraped metadata directly via GraphQL ───────────────────────────

  async function applyToScene(sceneId, fieldChecks, selPerfNames, scraped, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail, selectedTagIds, organized, addZzzUploadTag, stashDbIds) {
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
    const extraTagIds = selectedTagIds ? [...selectedTagIds] : [];
    if (addZzzUploadTag) {
      try {
        extraTagIds.push(await findOrCreateTagByName("zzz-upload"));
      } catch (e) {
        throw new Error(`Failed to find/create "zzz-upload" tag: ${e.message}`);
      }
    }
    if (extraTagIds.length) {
      const existingIds = (current.tags || []).map(t => t.id);
      input.tag_ids = Array.from(new Set([...existingIds, ...extraTagIds]));
    }
    if (organized) input.organized = true;
    // StashDB-sourced matches (opts.viaStashDb) write their remote scene id
    // into stash_ids, merged with (not replacing) whatever endpoints the
    // scene already has, so find_duplicate_scenes' stash_id tier picks up
    // scenes scraped via SuperScrape, not just Data18StashDB.
    if (stashDbIds) {
      const existing = (current.stash_ids || [])
        .filter(s => !(s.stash_id === stashDbIds.stash_id && s.endpoint === stashDbIds.endpoint))
        .map(s => ({ stash_id: s.stash_id, endpoint: s.endpoint }));
      input.stash_ids = [...existing, { stash_id: stashDbIds.stash_id, endpoint: stashDbIds.endpoint }];
    }
    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
  }

  // ── Bulk-apply one confident queue item, reusing the exact same
  // applyToScene mutation the single-scene wizard's "Apply to Scene" button
  // calls -- no parallel apply path. Field selection mirrors renderApply's
  // DEFAULT (untouched) state: every field checkbox starts checked, only
  // performers already found in Stash start checked, cover defaults to
  // "keep current" if a current image exists (or to the StashDB-scraped
  // cover, unconditionally, when item.viaStashDb -- a StashDB fingerprint
  // hit is treated as more authoritative than whatever cover the scene
  // already has, same rationale as the rest of its fields; skipped if
  // that cover is a GIF, matching renderApply's GIF guard), and tags are whatever
  // computePreselectedTagIds already chose during queue-building. This is
  // deliberately "what Apply would do if you changed nothing," matching the
  // premise that a "confident" item needs no manual review.
  async function applyConfidentBatchItem(item) {
    const scraped = item.scrapeOutput.scraped;
    const resolvedPerformers = item.scrapeOutput.resolvedPerformers || [];
    const resolvedStudio = item.scrapeOutput.resolvedStudio;
    const fieldChecks = { title: true, date: true, studio: true, urls: true, details: true, performers: true };
    const selPerfNames = resolvedPerformers.filter(p => p.found).map(p => p.name);
    const currentImageUrl = item.current.paths?.screenshot || "";
    const scrapedCoverUsable = !!item.scrapedThumbnail && !scraped.thumbnailIsGif;
    const coverPick = (item.viaStashDb && scrapedCoverUsable)
      ? "scraped"
      : currentImageUrl ? "current" : (scrapedCoverUsable ? "scraped" : "current");
    const stashDbIds = (item.viaStashDb && item.scrapeOutput?.remoteSiteId && item.stashDbBox?.endpoint)
      ? { stash_id: item.scrapeOutput.remoteSiteId, endpoint: item.stashDbBox.endpoint }
      : null;
    const effectiveZzzUpload = item.addZzzUploadTag && !(item.skipZzzUploadForStashDb && item.viaStashDb);
    await applyToScene(
      item.sceneId, fieldChecks, selPerfNames, scraped, resolvedPerformers, resolvedStudio,
      item.current, item.contentUrl, coverPick, item.scrapedThumbnail, item.preselectedTagIds, item.markOrganized,
      effectiveZzzUpload, stashDbIds
    );
    await bumpLastUsed(item.storeKey, item.storeInfo);
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
    tryInjectBatchToolbarButton();
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

  function openModal(sceneId, initialRender) {
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
        <div id="ss-steps" class="ss-steps" style="display:none"></div>
        <div id="ss-error"  style="display:none"></div>
        <div id="ss-status" style="display:none"></div>
        <div id="ss-content"></div>
        <div id="ss-footer" class="ss-footer" style="display:none"></div>
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

    if (initialRender) {
      initialRender();
    } else {
      switchTab(sceneId, "scrape");
    }
  }

  function switchTab(sceneId, tab) {
    document.getElementById("ss-tab-scrape").classList.toggle("ss-tab-active", tab === "scrape");
    document.getElementById("ss-tab-manage").classList.toggle("ss-tab-active", tab === "manage");
    setError(""); setStatus("");
    if (tab === "scrape") {
      startScrapeFlow(sceneId);
    } else {
      renderStoreList(sceneId);
    }
  }

  // ── Wizard chrome: persistent step tracker + sticky footer, shared by
  // every screen in the single-scene wizard (Parse/Match/Search/Compare &
  // Apply -- Compare and Apply are one merged step since they already
  // share a screen). Each render* function below owns its own chrome
  // state and calls these at render time; screens outside the 4-step
  // wizard (Manage Known Stores, the terminal done/deleted screens) clear
  // both so no stale tracker/footer lingers from the previous screen. ────

  const WIZARD_STEPS = [
    { key: "parse", label: "Parse" },
    { key: "match", label: "Match" },
    { key: "search", label: "Search" },
    { key: "apply", label: "Compare & Apply" },
  ];

  const STASHDB_STEP = { key: "stashdb", label: "StashDB" };

  // showStashDb prepends STASHDB_STEP for this render only -- callers pass
  // opts.stashDbStepShown (true whenever a phash lookup actually ran this
  // session, set once in startScrapeFlow/processBatchScene and threaded
  // through opts everywhere else, regardless of whether the lookup found
  // anything). No phash to check at all -- the common/expected case for
  // now -- and this stays false, so the tracker looks exactly like it did
  // before this feature existed.
  function renderStepTracker(activeKey, showStashDb = false) {
    const el = document.getElementById("ss-steps");
    if (!el) return;
    if (!activeKey) { el.style.display = "none"; el.innerHTML = ""; return; }
    const steps = showStashDb ? [STASHDB_STEP, ...WIZARD_STEPS] : WIZARD_STEPS;
    const activeIdx = steps.findIndex(s => s.key === activeKey);
    el.style.display = "flex";
    el.innerHTML = steps.map((s, i) => {
      const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
      const dot = state === "done" ? "✓" : String(i + 1);
      const line = i < steps.length - 1
        ? `<div class="ss-step-line ${i < activeIdx ? "ss-line-done" : "ss-line-todo"}"></div>`
        : "";
      return `<div class="ss-step ss-step-${state}"><span class="ss-step-dot">${dot}</span><span class="ss-step-label">${esc(s.label)}</span></div>${line}`;
    }).join("");
  }

  // ── StashDB-first: fingerprint pre-check, replaces the old direct
  // renderFilenameInput(sceneId) entry point when a phash exists locally
  // and the "Check StashDB fingerprint match first" toggle is on. Calls
  // Stash's own native fingerprint path (findScenesBySceneFingerprints,
  // via the new "StashDB Fingerprint Match" task -- see SuperScrape.py)
  // rather than the fuzzy searchScene text search. Never hardcodes a
  // stash-box index: scans configuration.general.stashBoxes for an
  // endpoint containing "stashdb.org", same pattern Data18StashDB's
  // createPerformerInStash uses. Any failure to check (not configured, no
  // phash, lookup errors) falls straight through to today's flow with no
  // message -- only a phash that actually gets checked earns a leading
  // tracker step, whatever the outcome. ─────────────────────────────────

  async function findStashDbBox() {
    const data = await gql(`{ configuration { general { stashBoxes { endpoint api_key } } } }`);
    const boxes = data.configuration.general.stashBoxes || [];
    return boxes.find(b => b.endpoint.includes("stashdb.org")) || null;
  }

  function renderStashDbChecking() {
    setError("");
    renderStepTracker("stashdb", true);
    setFooter(null);
    getContent().innerHTML = `<p class="ss-hint">Checking StashDB for a fingerprint match…</p>`;
  }

  async function startScrapeFlow(sceneId) {
    setError(""); setStatus("");
    renderStepTracker(null);
    setFooter(null);

    let cfg;
    try { cfg = await readConfig(); } catch (_) { cfg = { stashDbFirstEnabled: true, markOrganizedDefault: false, addZzzUploadTagDefault: false, skipZzzUploadForStashDbDefault: true }; }
    const baseOpts = { markOrganized: !!cfg.markOrganizedDefault, addZzzUploadTag: !!cfg.addZzzUploadTagDefault, skipZzzUploadForStashDb: !!cfg.skipZzzUploadForStashDbDefault };

    if (!cfg.stashDbFirstEnabled) {
      renderFilenameInput(sceneId, baseOpts);
      return;
    }

    let current;
    try {
      current = await fetchCurrentScene(sceneId);
    } catch (_) {
      renderFilenameInput(sceneId, baseOpts);
      return;
    }

    const phash = primaryPhash(current);
    if (!phash) {
      renderFilenameInput(sceneId, baseOpts);
      return;
    }

    let box;
    try { box = await findStashDbBox(); } catch (_) { box = null; }
    if (!box) {
      renderFilenameInput(sceneId, baseOpts);
      return;
    }

    renderStashDbChecking();
    setStatus("Checking StashDB…");
    let output;
    try {
      output = await runTask("StashDB Fingerprint Match", {
        phash, stashbox_endpoint: box.endpoint, stashbox_api_key: box.api_key,
      });
    } catch (_) {
      setStatus("");
      renderFilenameInput(sceneId, baseOpts);
      return;
    }
    setStatus("");

    const scenes = output.scenes || [];
    const checkedOpts = { ...baseOpts, stashDbStepShown: true };

    if (!scenes.length) {
      renderFilenameInput(sceneId, checkedOpts);
      return;
    }

    const matchOpts = { ...checkedOpts, viaStashDb: true, stashDbBox: box };
    if (scenes.length === 1) {
      await resolveStashDbHit(sceneId, current, scenes[0], matchOpts, () => renderFilenameInput(sceneId, checkedOpts));
      return;
    }
    renderStashDbResults(sceneId, current, scenes, matchOpts);
  }

  // Multiple fingerprint hits -- visually identical to renderResults'
  // card list (same ss-result-card/-thumb/-info classes) with a badge
  // marking these as StashDB fingerprint matches rather than a fuzzy text
  // search. A new sibling function rather than a branch inside
  // renderResults: that function's click handler runs the site-adapter
  // "Scrape Clip" task, which doesn't apply here -- StashDB already gave
  // us full scene data, so a click goes straight to dupe-check/apply.
  function renderStashDbResults(sceneId, current, scenes, opts) {
    setError("");
    renderStepTracker("search", opts.stashDbStepShown);

    const cardsHtml = scenes.map((s, i) => `
      <div class="ss-result-card" data-idx="${i}">
        ${thumbWithHover(s.thumbnail, "ss-result-thumb")}
        <div class="ss-result-info">
          <div class="ss-result-title">${esc(s.scraped.title || "(no title)")} <span class="ss-badge ss-badge-stashdb">via StashDB fingerprint</span></div>
          <div class="ss-result-sub">${esc(s.scraped.date || "")}</div>
          ${s.scraped.description ? `<div class="ss-result-desc">${esc(s.scraped.description.length > 120 ? s.scraped.description.slice(0, 117) + "…" : s.scraped.description)}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      <p class="ss-hint">${scenes.length} StashDB fingerprint matches — click to select:</p>
      <div class="ss-results">${cardsHtml}</div>`;
    setFooter(`<button id="ss-back1" class="ss-btn ss-btn-secondary">← Back</button>`);

    bindThumbHovers();

    document.querySelectorAll(".ss-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        card.classList.add("ss-card-loading");
        await resolveStashDbHit(sceneId, current, scenes[+card.dataset.idx], opts,
          () => renderStashDbResults(sceneId, current, scenes, opts));
      });
    });

    document.getElementById("ss-back1").onclick = () =>
      renderFilenameInput(sceneId, { markOrganized: opts.markOrganized, addZzzUploadTag: opts.addZzzUploadTag, stashDbStepShown: opts.stashDbStepShown });
  }

  // Runs the (extended) "Check Duplicates" task with remote_site_id/
  // endpoint set, so find_duplicate_scenes' stash_id tier fires, then
  // routes to the existing renderDuplicates/renderApply exactly like the
  // site-adapter path does -- no parallel dupe-resolution screen.
  async function resolveStashDbHit(sceneId, current, sceneMatch, opts, onBack) {
    setError("");
    setStatus("Checking for duplicates…");
    const storeInfo = { site: "stashdb", displayName: "StashDB" };
    const applyOpts = { ...opts, onBack };
    try {
      const resolvedPerfs = sceneMatch.resolvedPerformers || [];
      const perfIds = resolvedPerfs.filter(p => p.localId).map(p => p.localId);
      const dupeOutput = await runTask("Check Duplicates", {
        scraped_title: sceneMatch.scraped.title || "",
        performer_ids: perfIds,
        current_scene_id: sceneId,
        current_phashes: currentScenePhashes(current),
        remote_site_id: sceneMatch.remoteSiteId,
        endpoint: opts.stashDbBox.endpoint,
      });
      setStatus("");
      const dupes = (dupeOutput.duplicates || []).filter(d => d.id !== sceneId);
      if (dupes.length) {
        renderDuplicates(sceneId, current, null, null, storeInfo, null, null, sceneMatch, sceneMatch.contentUrl, sceneMatch.thumbnail, dupes, applyOpts);
      } else {
        renderApply(sceneId, current, null, null, storeInfo, null, null, sceneMatch, sceneMatch.contentUrl, sceneMatch.thumbnail, applyOpts);
      }
    } catch (e) {
      setStatus("");
      setError(e.message);
    }
  }

  function setFooter(html) {
    const el = document.getElementById("ss-footer");
    if (!el) return;
    if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "flex";
    el.innerHTML = html;
  }

  function setBatchFooter(html) {
    const el = document.getElementById("ss-batch-footer");
    if (!el) return;
    if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.style.display = "flex";
    el.innerHTML = html;
  }

  // ── Scrape flow: Step 1 — filename input ──────────────────────────────────

  async function renderFilenameInput(sceneId, opts = {}) {
    setError(""); setStatus("Loading…");
    renderStepTracker("parse", opts.stashDbStepShown);
    setFooter(null);
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
      cfg = { performerStoreMap: {}, stashDbFirstEnabled: true, markOrganizedDefault: false, addZzzUploadTagDefault: false, skipZzzUploadForStashDbDefault: true };
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

    renderStepTracker("parse", opts.stashDbStepShown);
    getContent().innerHTML = `
      <div class="ss-row">
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-toggle-stashdb-first" ${cfg.stashDbFirstEnabled ? "checked" : ""} />
          <span>Check StashDB fingerprint match first</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-toggle-mark-organized" ${cfg.markOrganizedDefault ? "checked" : ""} />
          <span>Mark scene as Organized when applying</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-toggle-zzz-upload" ${cfg.addZzzUploadTagDefault ? "checked" : ""} />
          <span>Add "zzz-upload" tag when applying</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-toggle-skip-zzz-stashdb" ${cfg.skipZzzUploadForStashDbDefault ? "checked" : ""} />
          <span>Skip zzz-upload tag for StashDB matches</span>
        </label>
      </div>
      ${quickPickHtml}
      <p class="ss-hint">Filename to parse (edit if needed):</p>
      <div class="ss-row">
        <input id="ss-filename" class="ss-input" type="text" value="${esc(basename)}" />
      </div>`;
    setFooter(`<button id="ss-parse" class="ss-btn ss-btn-primary">Parse</button>`);

    document.getElementById("ss-toggle-stashdb-first").addEventListener("change", e => {
      writeConfig({ stashDbFirstEnabled: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-toggle-mark-organized").addEventListener("change", e => {
      writeConfig({ markOrganizedDefault: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-toggle-zzz-upload").addEventListener("change", e => {
      writeConfig({ addZzzUploadTagDefault: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-toggle-skip-zzz-stashdb").addEventListener("change", e => {
      writeConfig({ skipZzzUploadForStashDbDefault: e.target.checked }).catch(() => {});
    });

    function currentOpts() {
      return {
        ...opts,
        markOrganized: document.getElementById("ss-toggle-mark-organized")?.checked ?? cfg.markOrganizedDefault,
        addZzzUploadTag: document.getElementById("ss-toggle-zzz-upload")?.checked ?? cfg.addZzzUploadTagDefault,
        skipZzzUploadForStashDb: document.getElementById("ss-toggle-skip-zzz-stashdb")?.checked ?? cfg.skipZzzUploadForStashDbDefault,
      };
    }

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
            { confidence: "confident", source: "quickpick", match: entry, score: 1, suggestions: [] },
            /* autoSearch */ true, currentOpts());
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
        renderMatchState(sceneId, current, parsed, match, false, currentOpts());
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Parse"; setStatus("");
      }
    }

    btn.onclick = go;
    input.addEventListener("keydown", e => e.key === "Enter" && go());
  }

  // ── Scrape flow: Step 2 — confidence state + confirm ──────────────────────

  function renderMatchState(sceneId, current, parsed, match, autoSearch = false, opts = {}) {
    setError("");
    renderStepTracker("match", opts.stashDbStepShown);
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
      </div>`;

    setFooter(`
      <button id="ss-back0" class="ss-btn ss-btn-secondary">← Back</button>
      ${opts.onDismiss ? `<button id="ss-dismiss0" class="ss-btn ss-btn-danger">Dismiss</button>` : ""}
      <button id="ss-confirm" class="ss-btn ss-btn-primary">${isConfident ? "Confirm &amp; Search" : "Search"}</button>`);

    document.getElementById("ss-back0").onclick = opts.onBack || (() => renderFilenameInput(sceneId, opts));
    if (opts.onDismiss) document.getElementById("ss-dismiss0").onclick = opts.onDismiss;

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

    async function runSearch() {
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
        renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, opts);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = isConfident ? "Confirm & Search" : "Search"; setStatus("");
      }
    }

    document.getElementById("ss-confirm").onclick = runSearch;

    // Quick-pick-only auto-run: performer is already confirmed (from
    // performerStoreMap, not parsed), so the only real gate is whether
    // parse_filename actually found a usable title. parse_filename has
    // no dedicated title-confidence field (its "method" field describes
    // how the PERFORMER was found, not the title) -- non-empty-after-
    // trim is the simplest reasonable stand-in. Does NOT touch the
    // normal (non-quick-pick) flow: autoSearch defaults to false, and
    // both "Back" buttons in renderResults call this function with only
    // 4 args, so returning here after an auto-run never re-triggers one.
    if (autoSearch && isConfident && parsed.titleCandidate && parsed.titleCandidate.trim()) {
      runSearch();
    }
  }

  // ── Scrape flow: Step 3 — clip-picker cards ───────────────────────────────

  function renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, opts = {}) {
    setError("");
    renderStepTracker("search", opts.stashDbStepShown);
    const hits = searchOutput.hits || [];

    if (!hits.length) {
      const totalHint = searchOutput.totalInStore != null ? ` (${searchOutput.totalInStore} total)` : "";
      const staleHtml = searchOutput.catalogStale ? `
        <p class="ss-hint ss-warning">⚠ Showing cached results — the last live catalog refresh for this store failed, so this list may be out of date.</p>` : "";
      getContent().innerHTML = `
        <p class="ss-hint">No results in ${esc(storeInfo.displayName)}'s store${totalHint} for that search.</p>
        ${staleHtml}`;
      setFooter(`<button id="ss-back1" class="ss-btn ss-btn-secondary">← Back</button>`);
      document.getElementById("ss-back1").onclick = () => renderMatchState(sceneId, current, parsed, match, false, opts);
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

    const staleHtml = searchOutput.catalogStale ? `
      <p class="ss-hint ss-warning">⚠ Showing cached results — the last live catalog refresh for this store failed, so this list may be out of date.</p>` : "";

    const countLabel = searchOutput.totalInStore != null
      ? `${hits.length} matching clip${hits.length !== 1 ? "s" : ""} out of ${searchOutput.totalInStore}`
      : `${searchOutput.found} result${searchOutput.found !== 1 ? "s" : ""}`;

    getContent().innerHTML = `
      <p class="ss-hint">${countLabel} in ${esc(storeInfo.displayName)}'s store — click to select:</p>
      ${warningHtml}
      ${staleHtml}
      <div class="ss-results">${cardsHtml}</div>`;
    setFooter(`<button id="ss-back1" class="ss-btn ss-btn-secondary">← Back</button>`);

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
            renderDuplicates(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail, dupes, opts);
          } else {
            renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, hit.contentUrl, hit.thumbnail, opts);
          }
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("ss-card-loading");
        }
      });
    });

    document.getElementById("ss-back1").onclick = () => renderMatchState(sceneId, current, parsed, match, false, opts);
  }

  // ── Scrape flow: Step 3b — duplicate warning (mirrors Data18StashDB's
  // pattern, adapted: no stash_id concept here, and the only destructive
  // action offered is deleting the CURRENT scene -- the one about to be
  // scraped into -- not the found duplicate, since the premise is "this
  // scene turns out to already exist elsewhere, remove the redundant one
  // I was about to process". When opts.viaStashDb is set (this dupe came
  // from a StashDB fingerprint match, so the existing scene may carry a
  // matching stash_id/group), two extra actions become available,
  // reusing the SAME dupes/renderApply plumbing -- not a parallel screen:
  // "apply metadata to existing scene" and, if the current scene already
  // belongs to a local group, "link existing to that group" too. ─────────

  function renderDuplicates(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail, dupes, opts = {}) {
    setError("");
    renderStepTracker("search", opts.stashDbStepShown);

    function fmtSize(bytes) {
      if (!bytes) return null;
      return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
    }

    const currentGroup = (current.groups || [])[0] || null;
    const richActions = !!opts.viaStashDb;

    const goApply = (targetId, targetCurrent) =>
      renderApply(targetId, targetCurrent, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail, opts);

    const cardsHtml = dupes.map((d, i) => {
      const size = fmtSize((d.files || [])[0]?.size);
      const thumb = d.paths?.screenshot;
      const groupLabels = (d.groups || []).map(g => g.group.name + (g.scene_index ? ` #${g.scene_index}` : "")).join(", ");
      return `
        <div class="ss-dupe-card">
          ${thumbWithHover(thumb, "ss-result-thumb")}
          <div class="ss-result-info" style="flex:1">
            <div class="ss-result-title">${esc(d.title || "(no title)")}</div>
            <div class="ss-result-sub">${esc(d.matchReason || "")}</div>
            ${d.date ? `<div class="ss-result-sub">${esc(d.date)}</div>` : ""}
            ${groupLabels ? `<div class="ss-result-sub">Group: ${esc(groupLabels)}</div>` : ""}
            ${size  ? `<div class="ss-result-sub">Size: ${size}</div>` : ""}
          </div>
          <div class="ss-dupe-actions">
            <a class="ss-btn ss-btn-secondary ss-btn-xs" href="/scenes/${esc(d.id)}" target="_blank" rel="noopener">View existing</a>
            ${richActions ? `
              <button class="ss-btn ss-btn-secondary ss-btn-xs ss-dupe-use" data-idx="${i}" type="button">Apply metadata to existing scene</button>
              ${currentGroup ? `<button class="ss-btn ss-btn-secondary ss-btn-xs ss-dupe-link" data-idx="${i}" type="button">Keep existing &amp; link to group</button>` : ""}
              <span class="ss-perf-inline-msg" data-idx="${i}"></span>` : ""}
          </div>
        </div>`;
    }).join("");

    getContent().innerHTML = `
      <div class="ss-dupe-header">⚠ This scene may already exist in your library.</div>
      <div class="ss-dupe-list">${cardsHtml}</div>`;
    setFooter(`
      <button id="ss-dupe-delete" class="ss-btn ss-btn-danger">Delete current scene</button>
      <button id="ss-dupe-keep" class="ss-btn ss-btn-secondary">Keep current scene &amp; continue</button>`);

    bindThumbHovers();

    document.getElementById("ss-dupe-keep").onclick = () => goApply(sceneId, current);

    document.getElementById("ss-dupe-delete").onclick = () =>
      renderDeleteConfirm(sceneId, current, renderDupesStep);

    function renderDupesStep() {
      renderDuplicates(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail, dupes, opts);
    }

    if (richActions) {
      document.querySelectorAll(".ss-dupe-use").forEach(btn => {
        btn.addEventListener("click", async () => {
          const dupe = dupes[+btn.dataset.idx];
          const msg = btn.closest(".ss-dupe-actions")?.querySelector(".ss-perf-inline-msg");
          btn.disabled = true; btn.textContent = "Loading…";
          try {
            const dupeScene = await fetchCurrentScene(dupe.id);
            goApply(dupe.id, dupeScene);
          } catch (e) {
            btn.disabled = false; btn.textContent = "Apply metadata to existing scene";
            if (msg) { msg.className = "ss-perf-inline-msg ss-msg-err"; msg.textContent = `✗ ${e.message}`; }
          }
        });
      });

      document.querySelectorAll(".ss-dupe-link").forEach(btn => {
        btn.addEventListener("click", async () => {
          const dupe = dupes[+btn.dataset.idx];
          const msg = btn.closest(".ss-dupe-actions")?.querySelector(".ss-perf-inline-msg");
          btn.disabled = true; btn.textContent = "Linking…";
          try {
            const existing = (dupe.groups || []).map(g => ({ group_id: g.group.id, scene_index: g.scene_index }));
            const newEntry = { group_id: currentGroup.group.id, scene_index: currentGroup.scene_index };
            const merged = existing.some(g => g.group_id === newEntry.group_id) ? existing : [...existing, newEntry];
            await gql(`mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
              { input: { id: dupe.id, groups: merged } });
            const dupeScene = await fetchCurrentScene(dupe.id);
            goApply(dupe.id, dupeScene);
          } catch (e) {
            btn.disabled = false; btn.textContent = "Keep existing & link to group";
            if (msg) { msg.className = "ss-perf-inline-msg ss-msg-err"; msg.textContent = `✗ ${e.message}`; }
          }
        });
      });
    }
  }

  // ── Duplicate-flow: confirm & delete the CURRENT scene ─────────────────
  // Mirrors Stash's own DeleteScenesDialog (ui/v2.5/src/components/Scenes/
  // DeleteScenesDialog.tsx): same two options (delete_file, delete_generated),
  // same danger-alert-with-path-list pattern shown once delete_file is
  // checked. Deliberately deviates from Stash's own default on ONE option:
  // delete_file defaults CHECKED here (Stash defaults it unchecked), because
  // by the time this screen appears we've already confirmed this scene is a
  // duplicate of one already in the library -- the whole point of the action
  // is removing the redundant file, not just the DB record.
  function renderDeleteConfirm(sceneId, current, onCancel) {
    const basename = (current.files || [])[0]?.basename || "";
    const thumb = current.paths?.screenshot;

    function bodyHtml(deleteFile) {
      return `
        <div class="ss-dupe-header">Delete this scene?</div>
        <div class="ss-dupe-card">
          ${thumbWithHover(thumb, "ss-result-thumb")}
          <div class="ss-result-info" style="flex:1">
            <div class="ss-result-title">${esc(current.title || basename || "(no title)")}</div>
            ${basename ? `<div class="ss-result-sub">${esc(basename)}</div>` : ""}
          </div>
        </div>
        <div class="ss-section-label">
          <label class="ss-item-label">
            <input type="checkbox" id="ss-del-file" ${deleteFile ? "checked" : ""} />
            <span>Delete file from disk</span>
          </label>
        </div>
        <div class="ss-section-label">
          <label class="ss-item-label">
            <input type="checkbox" id="ss-del-generated" checked />
            <span>Delete generated files (previews, sprites, markers)</span>
          </label>
        </div>
        ${deleteFile ? `
          <div class="ss-dupe-header ss-msg-err">
            ⚠ This will permanently delete this file from disk:
            <div class="ss-result-sub">${esc(basename || "(unknown path)")}</div>
          </div>` : ""}`;
    }

    function render(deleteFile) {
      getContent().innerHTML = bodyHtml(deleteFile);
      setFooter(`
        <button id="ss-del-cancel" class="ss-btn ss-btn-secondary">Cancel</button>
        <button id="ss-del-confirm" class="ss-btn ss-btn-danger">Delete</button>`);
      bindThumbHovers();

      document.getElementById("ss-del-file").onchange = (e) => render(e.target.checked);
      document.getElementById("ss-del-cancel").onclick = onCancel;

      document.getElementById("ss-del-confirm").onclick = async () => {
        const deleteFileNow = document.getElementById("ss-del-file").checked;
        const deleteGenerated = document.getElementById("ss-del-generated").checked;
        const btn = document.getElementById("ss-del-confirm");
        btn.disabled = true; btn.textContent = "Deleting…";
        setStatus(deleteFileNow ? "Deleting current scene and file from disk…" : "Deleting current scene…");
        try {
          await gql(`mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
            { input: { ids: [sceneId], delete_file: deleteFileNow, delete_generated: deleteGenerated } });
          setStatus("");
          renderStepTracker(null);
          getContent().innerHTML = `<div class="ss-success">✓ Current scene${deleteFileNow ? " and file" : ""} deleted${deleteFileNow ? " from disk" : ""}.</div>`;
          setFooter(`<button id="ss-dupe-close" class="ss-btn ss-btn-primary">Close</button>`);
          document.getElementById("ss-dupe-close").onclick = closeModal;
        } catch (e) {
          btn.disabled = false; btn.textContent = "Delete";
          setStatus("");
          setError(e.message);
        }
      };
    }

    render(/* deleteFile default */ true);
  }

  // ── Scrape flow: Step 4 — comparison table (unified: used regardless of
  // which site produced the scraped data) ───────────────────────────────────

  function matchBadge(found) {
    return found
      ? `<span class="ss-badge ss-badge-found">✓ in Stash</span>`
      : `<span class="ss-badge ss-badge-missing">✗ not found</span>`;
  }

  function renderApply(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, scrapeOutput, contentUrl, scrapedThumbnail, opts = {}) {
    setError("");
    renderStepTracker("apply", opts.stashDbStepShown);
    const scraped = scrapeOutput.scraped;
    const resolvedPerformers = scrapeOutput.resolvedPerformers || [];
    const resolvedStudio = scrapeOutput.resolvedStudio;
    const currentBasename = (current.files || [])[0]?.basename || "";

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

    // stash-box scene covers can't be GIFs -- scraped.thumbnailIsGif is
    // computed once server-side in extract() (Content-Type / magic-byte
    // check via the proxied session, see SuperScrape.py) so this never
    // needs a browser-side fetch. currentIsGif is a defensive extension
    // check only: Stash's own screenshot generator never actually emits a
    // GIF, but the fallback below still needs to degrade sanely if that
    // assumption is ever wrong.
    const currentImageUrl = current.paths?.screenshot || "";
    const currentIsGif = /\.gif(\?|$)/i.test(currentImageUrl);
    const incomingIsGif = !!scraped.thumbnailIsGif;
    const currentUsable = !!currentImageUrl && !currentIsGif;
    const incomingUsable = !!scrapedThumbnail && !incomingIsGif;
    const defaultCoverPick = (opts.viaStashDb && incomingUsable)
      ? "scraped"
      : currentUsable ? "current" : incomingUsable ? "scraped" : null;
    const noValidCover = (currentImageUrl || scrapedThumbnail) && !currentUsable && !incomingUsable;

    function coverBoxHtml(kind, url, usable, tag, selected) {
      if (!url) return `<div class="ss-cover-box ss-cover-empty"><span class="ss-hint">No image</span></div>`;
      return `
        <div class="ss-cover-box${selected ? " ss-cover-selected" : ""}${usable ? "" : " ss-cover-disabled"}" data-cover="${kind}">
          ${thumbWithHover(url, "ss-result-thumb")}
          <span class="ss-cover-tag${usable ? "" : " ss-cover-tag-warn"}">${tag}</span>
          <input type="radio" name="ss-cover-pick" value="${kind}" style="display:none" ${usable ? "" : "disabled"} ${selected ? "checked" : ""} />
        </div>`;
    }

    const currentTag = currentIsGif ? "⚠ GIF — unusable" : (defaultCoverPick === "current" ? "Current ✓" : "Current");
    const incomingTag = incomingIsGif ? "⚠ GIF — will be skipped" : (defaultCoverPick === "scraped" ? "Incoming ✓" : "Incoming");

    const imageRowHtml = (currentImageUrl || scrapedThumbnail) ? `
      <div class="ss-compare-row">
        <div class="ss-compare-label">Cover Image</div>
        <div class="ss-compare-current">
          ${coverBoxHtml("current", currentImageUrl, currentUsable, currentTag, defaultCoverPick === "current")}
        </div>
        <div class="ss-compare-incoming">
          ${coverBoxHtml("scraped", scrapedThumbnail, incomingUsable, incomingTag, defaultCoverPick === "scraped")}
          ${noValidCover ? `<p class="ss-hint ss-warning" style="margin-top:.3rem">⚠ No valid cover available — GIFs can't be used as stash-box covers. Cover will be left unchanged.</p>` : ""}
        </div>
        <div class="ss-compare-toggle"></div>
      </div>` : "";

    const scalarFields = [
      ["title",   "Title",              current.title || currentBasename, scraped.title],
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

    const currentDescriptionBlank = !current.details;
    const descriptionRowHtml = scraped.description ? `
      <div class="ss-compare-row ss-compare-row-tall${currentDescriptionBlank ? " ss-compare-row-full" : ""}">
        <div class="ss-compare-label">Description</div>
        ${currentDescriptionBlank ? "" : `<div class="ss-compare-current ss-trunc">${esc(current.details)}</div>`}
        <div class="ss-compare-incoming${currentDescriptionBlank ? " ss-compare-incoming-full" : ""}">
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
      <div id="ss-tagpicker-wrap" class="ss-tags-block">
        <div id="ss-tags-head" class="ss-tags-head">
          <span class="ss-tags-title">Add tags</span>
          <span id="ss-tags-chev" class="ss-tags-chev">▼</span>
        </div>
        <div id="ss-tags-body" class="ss-tags-body">
          <div class="ss-row" style="margin-bottom:.4rem">
            <input id="ss-tag-filter" class="ss-input" type="text" placeholder="Filter tags…" />
            <button id="ss-tag-filter-clear" class="ss-btn ss-btn-secondary ss-btn-xs" type="button" style="display:none" title="Clear filter">✕</button>
          </div>
          <div id="ss-tag-grid"><span class="ss-hint">Loading tags…</span></div>
        </div>
      </div>
      <div id="ss-unmatched-wrap" class="ss-tags-block ss-unmatched-block" style="display:none"></div>`;

    setFooter(`
      <button id="ss-back2"   class="ss-btn ss-btn-secondary">← Back</button>
      <button id="ss-selall"  class="ss-btn ss-btn-secondary">All</button>
      <button id="ss-selnone" class="ss-btn ss-btn-secondary">None</button>
      ${opts.onDismiss ? `<button id="ss-dismiss2" class="ss-btn ss-btn-danger">Dismiss</button>` : ""}
      <button id="ss-apply"   class="ss-btn ss-btn-primary">Apply to Scene</button>`);

    bindThumbHovers();
    renderTagPicker(resolvedPerformers, scrapeOutput.resolvedTags);

    // Whole-thumbnail click-to-select for the cover boxes -- the actual
    // selection state still lives on the hidden ss-cover-pick radios (so
    // ss-apply's existing querySelector('input[name="ss-cover-pick"]:checked')
    // read doesn't need to change), this just gives each box a bigger,
    // more obvious click target than the radio input alone. Disabled
    // boxes (GIF-flagged incoming cover) are never wired up -- clicking
    // them does nothing, matching their disabled radio underneath.
    document.querySelectorAll(".ss-cover-box[data-cover]:not(.ss-cover-disabled)").forEach(box => {
      box.addEventListener("click", () => {
        const kind = box.dataset.cover;
        document.querySelectorAll('input[name="ss-cover-pick"]').forEach(r => { r.checked = (r.value === kind); });
        document.querySelectorAll(".ss-cover-box[data-cover]").forEach(b => b.classList.toggle("ss-cover-selected", b.dataset.cover === kind));
      });
    });

    document.getElementById("ss-back2").onclick = opts.onBack || (() => renderResults(sceneId, current, parsed, match, storeInfo, storeKey, searchOutput, opts));
    if (opts.onDismiss) document.getElementById("ss-dismiss2").onclick = opts.onDismiss;
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
        const stashDbIds = (opts.viaStashDb && scrapeOutput?.remoteSiteId && opts.stashDbBox?.endpoint)
          ? { stash_id: scrapeOutput.remoteSiteId, endpoint: opts.stashDbBox.endpoint }
          : null;
        const effectiveZzzUpload = opts.addZzzUploadTag && !(opts.skipZzzUploadForStashDb && opts.viaStashDb);
        await applyToScene(sceneId, fieldChecks, selPerfs, scrapedForApply, resolvedPerformers, resolvedStudio, current, contentUrl, coverPick, scrapedThumbnail, selectedTagIds, opts.markOrganized, effectiveZzzUpload, stashDbIds);
        await bumpLastUsed(storeKey, storeInfo);
        setStatus("");
        if (opts.onApplied) opts.onApplied(); else renderDone();
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
  // TagChips' own categories (id/label/tagIds), read straight out of
  // configuration.plugins.TagChips -- confirmed live that
  // `{ configuration { plugins } }` returns EVERY plugin's config in one
  // response (not scoped to the calling plugin), the same query shape
  // SuperScrape's own readConfig() already uses for its own key. null
  // means "not fetched yet" (distinct from [] = fetched, TagChips not
  // installed or has zero categories configured), checked once and
  // cached like _allTagsCache.
  let _tagChipsCategoriesCache = null;

  async function fetchTagChipsCategories() {
    try {
      const data = await gql(`{ configuration { plugins } }`);
      const cfg = (data.configuration.plugins || {})["TagChips"] || {};
      return Array.isArray(cfg.categories) ? cfg.categories : [];
    } catch (e) {
      return [];
    }
  }

  // Mirrors TagChips' own buildCategorizedSections (TagChips.js) for
  // category structure only: categories in TagChips' stored array order,
  // anything not in any category falls into an "Uncategorized" section
  // appended last. Tags within each section are sorted alphabetically
  // (case-insensitive) rather than by scene_count like TagChips does --
  // SuperScrape intentionally diverges here (usage-based order made chips
  // jump around unpredictably between scenes). Duplicated rather than
  // imported -- Stash loads each plugin's JS as an independent bundle
  // with no cross-plugin import mechanism, same reasoning as this file's
  // existing "visual language only, no cross-import" tag-grid CSS.
  function buildCategorizedSections(tags, categories) {
    const tagById = new Map(tags.map(t => [t.id, t]));
    const usedIds = new Set();
    const sections = categories.map(cat => {
      const catTags = (cat.tagIds || []).map(id => tagById.get(id)).filter(Boolean);
      catTags.forEach(t => usedIds.add(t.id));
      catTags.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return { id: cat.id, label: cat.label, tags: catTags };
    });
    const uncategorized = tags.filter(t => !usedIds.has(t.id));
    uncategorized.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    sections.push({ id: "__uncategorized", label: "Uncategorized", tags: uncategorized });
    return sections;
  }

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

  // Pre-select the UNION of tags already on any MATCHED (found: true)
  // performer -- i.e. an existing local Stash performer resolved via
  // resolve_performer's exact/alias/fuzzy tiers, NOT one newly created via
  // "Create in Stash" during this same scrape (no localId to look up tags
  // against yet). Extracted out of renderTagPicker so the batch queue-
  // builder can run the exact same pre-selection at queue time (per its
  // own "tags carry through" requirement) without duplicating this logic.
  async function computePreselectedTagIds(resolvedPerformers, resolvedTags) {
    const ids = new Set();
    const matchedIds = [...new Set((resolvedPerformers || [])
      .filter(p => p.found && p.localId)
      .map(p => Number(p.localId)))];
    if (matchedIds.length) {
      try {
        const performers = await fetchPerformerTags(matchedIds);
        for (const p of performers) {
          for (const t of (p.tags || [])) ids.add(t.id);
        }
      } catch (e) {
        // Non-fatal -- pre-selection is a convenience, not required for
        // the picker to function; falls through with nothing pre-checked.
      }
    }
    // Additive: matched scraped keywords (resolve_tags found:true entries)
    // join whatever performer-tag pre-selection already produced above --
    // never a replacement for it.
    for (const t of (resolvedTags || [])) {
      if (t.found && t.localId) ids.add(t.localId);
    }
    return ids;
  }

  async function renderTagPicker(resolvedPerformers, resolvedTags) {
    // Deliberately does NOT pre-highlight tags the scene already has: the
    // picker only ever ADDS (see applyToScene's merge, never a replace),
    // so pre-checking an existing tag and letting the user "uncheck" it
    // would falsely imply removal is possible here.
    const grid = document.getElementById("ss-tag-grid");
    if (!grid) return;
    try {
      if (!_allTagsCache) _allTagsCache = await fetchAllTags();
    } catch (e) {
      grid.innerHTML = `<span class="ss-hint">Could not load tags: ${esc(e.message)}</span>`;
      return;
    }
    if (_tagChipsCategoriesCache === null) {
      _tagChipsCategoriesCache = await fetchTagChipsCategories();
    }

    // One-time pre-population at render time only -- does not re-run if
    // performer checkboxes change later elsewhere in the comparison table
    // (re-syncing on every toggle would clobber manual chip edits). Chips
    // pre-selected this way are exactly as toggleable as any manually-
    // clicked chip -- same "picker only ever adds" invariant as above,
    // nothing locked.
    _selectedTagIds = await computePreselectedTagIds(resolvedPerformers, resolvedTags);

    drawTagGrid(_allTagsCache);
    renderUnmatchedKeywords(resolvedTags);

    const filterInput = document.getElementById("ss-tag-filter");
    const filterClearBtn = document.getElementById("ss-tag-filter-clear");
    if (filterInput) {
      filterInput.addEventListener("input", () => {
        const q = normalize(filterInput.value);
        const filtered = q ? _allTagsCache.filter(t => normalize(t.name).includes(q)) : _allTagsCache;
        // While a filter is active, show matches as one flat list regardless
        // of category -- a match could span several categories, and forcing
        // the grouped/collapsible layout on a short filtered result would
        // just add visual noise for no benefit. Clearing the filter (empty
        // query) reverts to the normal grouped view.
        drawTagGrid(filtered, /* flat */ !!q);
        if (filterClearBtn) filterClearBtn.style.display = filterInput.value ? "" : "none";
      });
    }
    if (filterClearBtn) {
      filterClearBtn.addEventListener("click", () => {
        filterInput.value = "";
        drawTagGrid(_allTagsCache);
        filterClearBtn.style.display = "none";
        filterInput.focus();
      });
    }

    const tagsHead = document.getElementById("ss-tags-head");
    if (tagsHead) {
      tagsHead.addEventListener("click", () => {
        const body = document.getElementById("ss-tags-body");
        const chev = document.getElementById("ss-tags-chev");
        if (!body) return;
        const collapsed = body.style.display === "none";
        body.style.display = collapsed ? "" : "none";
        if (chev) chev.textContent = collapsed ? "▼" : "▶";
      });
    }
  }

  function drawTagGrid(tags, flat = false) {
    const grid = document.getElementById("ss-tag-grid");
    if (!grid) return;
    if (!tags.length) { grid.innerHTML = `<span class="ss-hint">No tags match.</span>`; return; }

    const chipHtml = t =>
      `<span class="ss-tag-chip${_selectedTagIds.has(t.id) ? " ss-chip-on" : ""}" data-id="${esc(t.id)}" title="${esc(t.name)}">${esc(t.name)}</span>`;

    const categories = _tagChipsCategoriesCache || [];
    if (flat || !categories.length) {
      // Flat fallback also covers "TagChips isn't installed / has no
      // categories configured" -- same rendering path as an active filter.
      grid.innerHTML = `<div class="ss-tag-grid">${tags.map(chipHtml).join("")}</div>`;
    } else {
      const sections = buildCategorizedSections(tags, categories);
      grid.innerHTML = sections
        .filter(s => s.tags.length)
        .map(s => `
          <p class="ss-cat-heading">${esc(s.label)}</p>
          <hr class="ss-cat-divider" />
          <div class="ss-tag-grid">${s.tags.map(chipHtml).join("")}</div>
        `).join("");
    }

    grid.querySelectorAll(".ss-tag-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const id = chip.dataset.id;
        if (_selectedTagIds.has(id)) { _selectedTagIds.delete(id); chip.classList.remove("ss-chip-on"); }
        else { _selectedTagIds.add(id); chip.classList.add("ss-chip-on"); }
      });
    });
  }

  // ── Unmatched-keyword section — collapsible, BELOW the tag-chip picker,
  // collapsed by default (unlike the "Add tags" picker above): these are
  // scraped keywords with no local Stash tag match at all, so an expanded
  // default would just be noise on the common case where everything
  // already matched. Uses <details>/<summary> -- same proven collapsible
  // pattern as Data18StashDB's own unmatched-tags section (.d18-unmatched-
  // toggle), not a hand-rolled click-toggle -- native disclosure state,
  // no JS needed for expand/collapse. Each keyword gets its own Create
  // button (not a bulk button), same inline find-or-create pattern as
  // ss-perf-create/ss-studio-create above: clicking Create makes the tag
  // in Stash, adds it to the chip grid pre-checked, and removes the
  // keyword's own unmatched row, all without a full re-render.
  function renderUnmatchedKeywords(resolvedTags) {
    const wrap = document.getElementById("ss-unmatched-wrap");
    if (!wrap) return;
    const unmatched = (resolvedTags || []).filter(t => !t.found);
    if (!unmatched.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
    wrap.style.display = "";

    const rowsHtml = unmatched.map(t => `
      <div class="ss-perf-row">
        <span>${esc(t.name)}</span>
        <button class="ss-btn ss-btn-secondary ss-btn-xs ss-keyword-create" data-name="${esc(t.name)}" type="button">Create</button>
        <span class="ss-perf-inline-msg"></span>
      </div>`).join("");

    wrap.innerHTML = `
      <details id="ss-unmatched-details">
        <summary id="ss-unmatched-summary" class="ss-unmatched-toggle">Unmatched keywords (${unmatched.length})</summary>
        <div id="ss-unmatched-body" class="ss-tags-body">${rowsHtml}</div>
      </details>`;

    wrap.querySelectorAll(".ss-keyword-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const row = btn.closest(".ss-perf-row");
        const msgEl = row?.querySelector(".ss-perf-inline-msg");
        btn.disabled = true; btn.textContent = "Creating…";
        try {
          const id = await findOrCreateTagByName(name);
          if (!_allTagsCache.some(t => t.id === id)) {
            _allTagsCache.push({ id, name, scene_count: 0 });
          }
          _selectedTagIds.add(id);
          drawTagGrid(_allTagsCache);
          row.remove();
          const remaining = wrap.querySelectorAll(".ss-perf-row").length;
          if (!remaining) {
            wrap.style.display = "none"; wrap.innerHTML = "";
          } else {
            const summaryEl = document.getElementById("ss-unmatched-summary");
            if (summaryEl) summaryEl.textContent = `Unmatched keywords (${remaining})`;
          }
        } catch (e) {
          btn.disabled = false; btn.textContent = "Create";
          if (msgEl) { msgEl.className = "ss-perf-inline-msg ss-msg-err"; msgEl.textContent = `✗ ${e.message}`; }
        }
      });
    });
  }

  // ── Scrape flow: Step 5 — done ────────────────────────────────────────────

  function renderDone() {
    setError(""); setStatus("");
    renderStepTracker(null);
    setFooter(null);
    getContent().innerHTML = `<div class="ss-success">✓ Scene updated! Reloading…</div>`;
    setTimeout(() => window.location.reload(), 1500);
  }

  // ── Manage Known Stores tab ────────────────────────────────────────────────

  function renderStoreList(sceneId) {
    setError("");
    renderStepTracker(null);
    setFooter(null);
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

  // ── Batch scrape: entry point ───────────────────────────────────────────────
  // Investigated: FilteredListToolbar (the .filtered-list-toolbar div) is a
  // shared component with no PatchComponent hook of its own, and the one
  // patchable ancestor (FilteredSceneList) only lets patch.after append
  // AFTER the whole page, not merge into that toolbar's row -- so reaching
  // inside it requires DOM injection. That toolbar is reused verbatim on
  // performer/studio/tag/group "Scenes" detail-panel tabs, but those live on
  // their own routes (/performers/:id etc.), never on the literal /scenes
  // path -- so an exact pathname check is sufficient to scope this to the
  // real library page without any React-side prop inspection. React
  // re-renders this toolbar on every filter/sort/page change, which can wipe
  // an unmanaged child node, so injection runs off a PERSISTENT (never
  // disconnected) MutationObserver rather than the per-scene button's
  // time-boxed one -- it just re-inserts whenever a mutation leaves the
  // button missing.

  function isScenesLibraryPage() {
    return window.location.pathname === "/scenes";
  }

  function tryInjectBatchToolbarButton() {
    if (!isScenesLibraryPage()) return;
    const toolbar = document.querySelector(".filtered-list-toolbar");
    if (!toolbar || document.getElementById(LIBRARY_BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = LIBRARY_BTN_ID;
    btn.type = "button";
    btn.className = "btn btn-secondary ss-batch-toolbar-btn";
    btn.textContent = "Batch Scrape";
    btn.title = "Queue multiple untagged scenes for SuperScrape review";
    btn.addEventListener("click", e => { e.preventDefault(); openBatchModal(); });
    toolbar.appendChild(btn);
  }

  function startBatchToolbarWatcher() {
    tryInjectBatchToolbarButton();
    const observer = new MutationObserver(() => tryInjectBatchToolbarButton());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function closeBatchModal() { document.getElementById(BATCH_MODAL_ID)?.remove(); }

  function setBatchError(msg) {
    const el = document.getElementById("ss-batch-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  function setBatchStatus(msg) {
    const el = document.getElementById("ss-batch-status");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function openBatchModal() {
    if (document.getElementById(BATCH_MODAL_ID)) return;
    const overlay = document.createElement("div");
    overlay.id = BATCH_MODAL_ID;
    overlay.className = "ss-overlay";
    overlay.innerHTML = `
      <div id="ss-batch-box" class="ss-dialog">
        <div class="ss-dialog-header">
          <span>SuperScrape → Batch Scrape</span>
          <button id="ss-batch-close" class="ss-dialog-close">✕</button>
        </div>
        <div id="ss-batch-error"  class="ss-dialog-error"  style="display:none"></div>
        <div id="ss-batch-status" class="ss-dialog-status" style="display:none"></div>
        <div id="ss-batch-content" class="ss-dialog-content"></div>
        <div id="ss-batch-footer" class="ss-footer" style="display:none"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("ss-batch-close").onclick = closeBatchModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeBatchModal(); });
    renderBatchSceneSelect();
  }

  // ── Batch scrape: Step 1 ─ candidate scene selection ────────────────────────────
  // Candidate definition is "still needs tagging" (zero tags) -- confirmed
  // live: SceneFilterType.tag_count is an IntCriterionInput, { modifier:
  // EQUALS, value: 0 } returns only zero-tag scenes and correctly excludes
  // a scene with tags. This is a permanent baseline, always AND-ed with
  // whatever else applies below -- it never gets replaced.
  //
  // Best-effort Stash-filter-honoring: Stash encodes the scenes list's live
  // filter into the URL (?q=...&c=...), each `c` being
  // JSON.stringify({type, modifier, value}) with `{`/`}` swapped for
  // `(`/`)` outside quoted strings (see stash-source's
  // ListFilterModel.translateJSON/getEncodedParams) -- an internal,
  // undocumented scheme, not a public API, so this could stop matching on
  // a future Stash UI update. Only performers, studios, and title/search
  // criteria are decoded (explicit scope decision); anything else is left
  // unmapped and simply ignored -- if nothing decodes, this falls back to
  // the zero-tags baseline alone.

  let _batchAllScenes = [];
  let _batchSelectedIds = new Set();
  let _batchNameFilter = "";

  // Mirrors ListFilterModel's own { }<->( ) substitution outside quoted
  // strings -- decoding direction only (this plugin never re-encodes).
  function translateStashFilterJSON(str) {
    let inString = false, escaped = false, out = "";
    for (const c of str) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === "\\" && inString) { escaped = true; out += c; continue; }
      if (c === '"') { inString = !inString; out += c; continue; }
      if (c === "(" && !inString) { out += "{"; continue; }
      if (c === ")" && !inString) { out += "}"; continue; }
      out += c;
    }
    return out;
  }

  function decodeStashFilterCriteria() {
    const decoded = { performers: null, studios: null, title: null, searchTerm: null };
    const params = new URLSearchParams(window.location.search);

    const q = params.get("q");
    if (q) decoded.searchTerm = q;

    for (const raw of params.getAll("c")) {
      try {
        const crit = JSON.parse(translateStashFilterJSON(raw));
        if (crit.type === "performers" && crit.value?.items?.length) {
          decoded.performers = {
            value: crit.value.items.map(i => Number(i.id)),
            modifier: crit.modifier,
            labels: crit.value.items.map(i => i.label),
          };
        } else if (crit.type === "studios" && crit.value?.items?.length) {
          decoded.studios = {
            value: crit.value.items.map(i => Number(i.id)),
            modifier: crit.modifier,
            labels: crit.value.items.map(i => i.label),
          };
        } else if (crit.type === "title" && crit.value != null) {
          decoded.title = { value: crit.value, modifier: crit.modifier };
        }
        // Any other criterion type is left unmapped -- deliberately not
        // tracked or surfaced, per the narrow scope for this feature.
      } catch (_) {
        // Undecodable -- skip this criterion, don't fail the whole batch.
      }
    }
    return decoded;
  }

  function summarizeDecodedFilter(decoded) {
    const bits = [];
    if (decoded.performers?.labels?.length) bits.push(`performer ${decoded.performers.labels.join(", ")}`);
    if (decoded.studios?.labels?.length) bits.push(`studio ${decoded.studios.labels.join(", ")}`);
    if (decoded.title) bits.push(`title "${decoded.title.value}"`);
    if (decoded.searchTerm) bits.push(`search "${decoded.searchTerm}"`);
    return bits;
  }

  async function fetchBatchCandidateScenes(decoded) {
    const sceneFilter = { tag_count: { modifier: "EQUALS", value: 0 } };
    if (decoded.performers) sceneFilter.performers = { value: decoded.performers.value, modifier: decoded.performers.modifier };
    if (decoded.studios) sceneFilter.studios = { value: decoded.studios.value, modifier: decoded.studios.modifier };
    if (decoded.title) sceneFilter.title = { value: decoded.title.value, modifier: decoded.title.modifier };

    const findFilter = { per_page: -1, sort: "created_at", direction: "DESC" };
    if (decoded.searchTerm) findFilter.q = decoded.searchTerm;

    const data = await gql(`
      query SuperScrapeBatchCandidates($sceneFilter: SceneFilterType, $findFilter: FindFilterType) {
        findScenes(scene_filter: $sceneFilter, filter: $findFilter) {
          scenes { id title files { basename } paths { screenshot } }
        }
      }
    `, { sceneFilter, findFilter });
    return data.findScenes.scenes;
  }

  function visibleBatchScenes() {
    const q = normalize(_batchNameFilter);
    if (!q) return _batchAllScenes;
    return _batchAllScenes.filter(s => normalize(s.title || (s.files || [])[0]?.basename || "").includes(q));
  }

  function updateBatchSelectionUI(visible) {
    const countEl = document.getElementById("ss-batch-count");
    const selAllEl = document.getElementById("ss-batch-selall");
    const startBtn = document.getElementById("ss-batch-start");
    if (countEl) countEl.textContent = `${_batchSelectedIds.size} selected`;
    if (startBtn) startBtn.disabled = _batchSelectedIds.size === 0;
    if (selAllEl) selAllEl.checked = visible.length > 0 && visible.every(s => _batchSelectedIds.has(s.id));
  }

  function drawBatchSceneList() {
    const listEl = document.getElementById("ss-batch-scene-list");
    if (!listEl) return;

    const visible = visibleBatchScenes();
    listEl.innerHTML = visible.length ? visible.map(s => `
      <label class="ss-batch-scene-row" data-id="${esc(s.id)}">
        <input type="checkbox" class="ss-batch-scene-chk" data-id="${esc(s.id)}" ${_batchSelectedIds.has(s.id) ? "checked" : ""} />
        ${thumbWithHover(s.paths?.screenshot, "ss-result-thumb")}
        <span class="ss-batch-scene-name">${esc(s.title || (s.files || [])[0]?.basename || `Scene ${s.id}`)}</span>
      </label>`).join("") : `<p class="ss-hint">No scenes match that filter.</p>`;

    bindThumbHovers();

    document.querySelectorAll(".ss-batch-scene-chk").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) _batchSelectedIds.add(cb.dataset.id);
        else _batchSelectedIds.delete(cb.dataset.id);
        updateBatchSelectionUI(visible);
      });
    });

    updateBatchSelectionUI(visible);
  }

  // ── Batch scrape: Step 2 ─ queue-building ───────────────────────────────────
  // In-memory only, module scope -- same pattern as _batchAllScenes/
  // _batchSelectedIds -- NOT persisted via configurePlugin (this repo's
  // config-store is meant for small key-value settings, not per-scene
  // scraped payloads for a whole batch -- see the documented drift-risk
  // warning above readConfig/writeConfig) and NOT written to a tag/temp
  // file. Lost on refresh, same limitation the single-scene wizard already
  // has today -- an accepted tradeoff, not a gap to fix here.
  //
  // Reuses the exact single-scene pipeline (Parse Filename / Search Store /
  // Scrape Clip / Check Duplicates tasks, computePreselectedTagIds) one
  // scene at a time -- no parallel requests against target sites or the
  // local Stash instance. The one deliberate divergence from the single-
  // scene wizard: it never calls the "Discover Store" task. That task
  // itself does real discovery (sitemap fuzzy-matching across iwantclips/
  // clips4sale/goddesssnow) even for performers absent from
  // performerStoreMap -- out of scope for batch mode per the earlier
  // decision, so the map is checked directly (already-fetched config,
  // plain object lookup) and anything not already in it goes straight to
  // needs-review instead.

  let _batchQueue = [];
  let _batchStopRequested = false;

  function tallyBatchQueue() {
    const tally = { confident: 0, "needs-review": 0, "no-match": 0, error: 0 };
    for (const item of _batchQueue) tally[item.classification] = (tally[item.classification] || 0) + 1;
    return tally;
  }

  // Runs the existing per-scene pipeline for one scene and returns a queue
  // item carrying everything a later review screen needs (scene id/data,
  // parsed candidate, matched store, search/scrape output, duplicates,
  // pre-selected tags) plus a classification + human-readable reason.
  // Never throws -- any failing step is caught and turns into an "error"
  // classification so one bad scene can't take down the whole batch.
  async function processBatchScene(sceneId, performerStoreMap, runOpts = {}) {
    const item = {
      sceneId, current: null, parsed: null, storeInfo: null, storeKey: null,
      searchOutput: null, scrapeOutput: null, contentUrl: null, scrapedThumbnail: null,
      duplicates: [], preselectedTagIds: [], classification: "no-match", reason: "",
      viaStashDb: false, stashDbScenes: null, stashDbBox: null, markOrganized: !!runOpts.markOrganized,
      addZzzUploadTag: !!runOpts.addZzzUploadTag,
      skipZzzUploadForStashDb: !!runOpts.skipZzzUploadForStashDb,
    };

    try {
      item.current = await fetchCurrentScene(sceneId);
    } catch (e) {
      item.classification = "error";
      item.reason = e.message;
      return item;
    }

    if (runOpts.stashDbFirstEnabled && runOpts.stashDbBox) {
      const phash = primaryPhash(item.current);
      if (phash) {
        try {
          const output = await runTask("StashDB Fingerprint Match", {
            phash, stashbox_endpoint: runOpts.stashDbBox.endpoint, stashbox_api_key: runOpts.stashDbBox.api_key,
          });
          const scenes = output.scenes || [];
          if (scenes.length === 1) {
            const sceneMatch = scenes[0];
            const resolvedPerfs = sceneMatch.resolvedPerformers || [];
            const perfIds = resolvedPerfs.filter(p => p.localId).map(p => p.localId);
            const dupeOutput = await runTask("Check Duplicates", {
              scraped_title: sceneMatch.scraped.title || "",
              performer_ids: perfIds,
              current_scene_id: sceneId,
              current_phashes: currentScenePhashes(item.current),
              remote_site_id: sceneMatch.remoteSiteId,
              endpoint: runOpts.stashDbBox.endpoint,
            });
            const dupes = (dupeOutput.duplicates || []).filter(d => d.id !== sceneId);
            item.viaStashDb = true;
            item.stashDbBox = runOpts.stashDbBox;
            item.storeInfo = { site: "stashdb", displayName: "StashDB" };
            item.scrapeOutput = sceneMatch;
            item.contentUrl = sceneMatch.contentUrl;
            item.scrapedThumbnail = sceneMatch.thumbnail;
            item.duplicates = dupes;
            try {
              item.preselectedTagIds = [...(await computePreselectedTagIds(resolvedPerfs, sceneMatch.resolvedTags))];
            } catch (_) {
              item.preselectedTagIds = [];
            }
            if (dupes.length) {
              item.classification = "needs-review";
              item.reason = `Possible duplicate (StashDB match): ${dupes[0].title || dupes[0].matchReason || "existing scene"}`;
            } else {
              item.classification = "confident";
              item.reason = "Matched via StashDB fingerprint";
            }
            return item;
          }
          if (scenes.length > 1) {
            item.viaStashDb = true;
            item.stashDbBox = runOpts.stashDbBox;
            item.stashDbScenes = scenes;
            item.classification = "needs-review";
            item.reason = `${scenes.length} StashDB fingerprint matches — ambiguous, needs a manual pick`;
            return item;
          }
          // zero hits -- fall through to the normal per-scene pipeline below
        } catch (_) {
          // StashDB check failed (offline, misconfigured, etc.) -- non-fatal,
          // fall through rather than losing the whole scene to an outage.
        }
      }
    }

    const basename = (item.current.files || [])[0]?.basename || "";

    let parsed;
    try {
      parsed = await runTask("Parse Filename", { filename: basename });
    } catch (e) {
      item.classification = "error";
      item.reason = e.message;
      return item;
    }
    item.parsed = parsed;

    if (!parsed.performerCandidate || !parsed.performerCandidate.trim()) {
      item.classification = "no-match";
      item.reason = "Filename didn't parse into a usable performer/title candidate";
      return item;
    }

    const storeKey = normalize(parsed.performerCandidate);
    item.storeKey = storeKey;
    const storeInfo = performerStoreMap[storeKey];
    if (!storeInfo) {
      item.classification = "needs-review";
      item.reason = `Unknown performer/store: "${parsed.performerCandidate}" (not in performerStoreMap -- batch mode doesn't attempt discovery)`;
      return item;
    }
    item.storeInfo = storeInfo;

    let searchOutput;
    try {
      searchOutput = await runTask("Search Store", {
        store_info: storeInfo,
        title_candidate: parsed.titleCandidate,
      }, { pollSeconds: storeInfo.site === "manyvids" ? 240 : 90 });
    } catch (e) {
      item.classification = "error";
      item.reason = e.message;
      return item;
    }
    item.searchOutput = searchOutput;

    const hits = searchOutput.hits || [];
    if (hits.length === 0) {
      item.classification = "needs-review";
      item.reason = `No results found in ${storeInfo.displayName}'s store for "${parsed.titleCandidate}"`;
      return item;
    }
    if (hits.length > 1) {
      item.classification = "needs-review";
      item.reason = `${hits.length} candidate matches found — ambiguous, needs a manual pick`;
      return item;
    }

    const hit = hits[0];
    item.contentUrl = hit.contentUrl;
    item.scrapedThumbnail = hit.thumbnail;

    let scrapeOutput;
    try {
      scrapeOutput = await runTask("Scrape Clip", {
        url: hit.contentUrl,
        site: storeInfo.site,
        studio_name: storeInfo.displayName,
        hit,
      });
    } catch (e) {
      item.classification = "error";
      item.reason = e.message;
      return item;
    }
    item.scrapeOutput = scrapeOutput;

    const resolvedPerfs = scrapeOutput.resolvedPerformers || [];
    const perfIds = resolvedPerfs.filter(p => p.localId).map(p => p.localId);

    let dupeOutput;
    try {
      dupeOutput = await runTask("Check Duplicates", {
        scraped_title: scrapeOutput.scraped.title || "",
        performer_ids: perfIds,
        current_scene_id: sceneId,
        current_phashes: currentScenePhashes(item.current),
      });
    } catch (e) {
      item.classification = "error";
      item.reason = e.message;
      return item;
    }
    const dupes = (dupeOutput.duplicates || []).filter(d => d.id !== sceneId);
    item.duplicates = dupes;

    try {
      item.preselectedTagIds = [...(await computePreselectedTagIds(resolvedPerfs, scrapeOutput.resolvedTags))];
    } catch (_) {
      item.preselectedTagIds = [];
    }

    if (dupes.length) {
      item.classification = "needs-review";
      item.reason = `Possible duplicate: ${dupes[0].title || dupes[0].matchReason || "existing scene"}`;
    } else {
      item.classification = "confident";
      item.reason = `Matched ${storeInfo.displayName} (${siteLabel(storeInfo.site)})`;
    }

    return item;
  }

  // Live-processing screen -- called once at the start of a run (done=0)
  // and again after every scene finishes, so the count/percentage/bar/
  // tally all advance scene-by-scene rather than jumping straight to a
  // final state. No step tracker here (renderStepTracker(null) is a
  // no-op in the batch modal today -- it has no #ss-steps element at
  // all, this represents many scenes, not one linear per-scene flow) --
  // called anyway so nothing stale could leak in if these shells are
  // ever unified later. The tally deliberately shows only confident/
  // needs-review/error, matching the approved mockup -- no-match stays
  // tracked in _batchQueue same as before, just not surfaced here (it's
  // already visible on the batch results dashboard once the run ends).
  function renderBatchProgress(done, total) {
    const content = document.getElementById("ss-batch-content");
    if (!content) return;
    renderStepTracker(null);
    const tally = tallyBatchQueue();
    const pct = total ? Math.round((done / total) * 100) : 0;
    content.innerHTML = `
      <div class="ss-live-status">
        <span>Processing ${done} of ${total} scene${total !== 1 ? "s" : ""}…</span>
        <span>${pct}%</span>
      </div>
      <div class="ss-live-bar-track"><div class="ss-live-bar-fill" style="width:${pct}%"></div></div>
      <p class="ss-live-tally">So far: <b class="ss-live-c">${tally.confident} confident</b> · <b class="ss-live-r">${tally["needs-review"]} needs review</b> · <b class="ss-live-e">${tally.error} error${tally.error !== 1 ? "s" : ""}</b></p>`;

    setBatchFooter(`<button id="ss-batch-stop" class="ss-btn ss-btn-secondary" ${_batchStopRequested ? "disabled" : ""}>${_batchStopRequested ? "Stopping after current scene…" : "Stop"}</button>`);
    const stopBtn = document.getElementById("ss-batch-stop");
    if (stopBtn && !_batchStopRequested) {
      stopBtn.onclick = () => {
        _batchStopRequested = true;
        renderBatchProgress(done, total);
      };
    }
  }

  function batchClassificationBadge(item) {
    if (item.status === "applied") {
      return `<span class="ss-batch-badge ss-batch-badge-applied">Applied</span>`;
    }
    const classification = item.classification;
    const label = classification === "confident" ? "Confident"
      : classification === "needs-review" ? "Needs Review"
      : classification === "error" ? "Error"
      : "No Match";
    return `<span class="ss-batch-badge ss-batch-badge-${classification}">${label}</span>`;
  }

  // One row's markup, shared by all three sections below -- idx is the
  // item's index in _batchQueue (not section-local), so the delegated
  // click handlers can look it up directly the same way the old flat
  // list already did. Thumbnail source: scraped thumbnail if the scene
  // got that far, else the local scene's own existing cover, else
  // thumbWithHover's normal empty state -- no new fetch, both fields
  // already live on the item from processBatchScene.
  function batchRowHtml(item, idx) {
    const name = item.current?.title || (item.current?.files || [])[0]?.basename || `Scene ${item.sceneId}`;
    const storeBit = item.storeInfo ? ` — ${esc(item.storeInfo.displayName)} (${siteLabel(item.storeInfo.site)})` : "";
    const thumbUrl = item.scrapedThumbnail || item.current?.paths?.screenshot || "";
    const stashDbBadge = item.viaStashDb ? `<span class="ss-batch-badge ss-batch-badge-stashdb">via StashDB</span>` : "";
    let actionHtml = "";
    if (item.classification === "confident" && item.status !== "applied") {
      actionHtml = `<button class="ss-batch-row-next" data-action="apply-next" data-idx="${idx}" type="button">Apply &amp; Next →</button>`;
    } else if (item.classification === "needs-review") {
      actionHtml = `<button class="ss-batch-row-next" data-action="review-next" data-idx="${idx}" type="button">Review &amp; Next →</button>`;
    }
    return `
      <div class="ss-batch-queue-row" data-idx="${idx}" role="button" tabindex="0">
        ${thumbWithHover(thumbUrl, "ss-batch-row-thumb")}
        ${batchClassificationBadge(item)}
        ${stashDbBadge}
        <span class="ss-batch-queue-name">${esc(name)}${storeBit}</span>
        <span class="ss-batch-queue-reason">${esc(item.reason || "")}</span>
        ${actionHtml}
      </div>`;
  }

  function renderBatchQueueResults() {
    const content = document.getElementById("ss-batch-content");
    if (!content) return;
    // The processing screen's Stop button lives in #ss-batch-footer -- clear it
    // here so it doesn't linger once the run finishes and this results
    // screen (unchanged otherwise; its own footer/actions are Stage 5)
    // takes over.
    setBatchFooter(null);
    const tally = tallyBatchQueue();
    const headerMsg = _batchQueue.length
      ? `Processed ${_batchQueue.length} scene${_batchQueue.length !== 1 ? "s" : ""}${_batchStopRequested ? " (stopped early)" : ""} — ${tally.confident} confident, ${tally["needs-review"]} needs review, ${tally["no-match"]} no match, ${tally.error} error${tally.error !== 1 ? "s" : ""}`
      : "No scenes processed.";

    // Split into the mockup's Ready to Approve / Needs Review sections,
    // plus a third (not in the mockup, kept so no-match/error items don't
    // silently lose the click-to-review access they already have today)
    // "Other" bucket for anything that's neither. Original _batchQueue
    // indices are preserved through the filter so the row/button handlers
    // below can still look items up the same way the old flat list did.
    const withIdx = _batchQueue.map((item, idx) => ({ item, idx }));
    const confidentRows = withIdx.filter(x => x.item.classification === "confident");
    const needsReviewRows = withIdx.filter(x => x.item.classification === "needs-review");
    const otherRows = withIdx.filter(x => x.item.classification !== "confident" && x.item.classification !== "needs-review");
    const pendingConfidentCount = confidentRows.filter(x => x.item.status !== "applied").length;

    const readySectionHtml = confidentRows.length ? `
      <div class="ss-batch-section-header">
        <span class="ss-batch-section-title ss-batch-section-ready">Ready to Approve (${pendingConfidentCount})</span>
        ${pendingConfidentCount ? `<div class="ss-batch-section-actions"><button id="ss-batch-approve-all" class="ss-btn ss-btn-primary ss-btn-xs">Approve All →</button></div>` : ""}
      </div>
      <div class="ss-batch-queue-list">${confidentRows.map(x => batchRowHtml(x.item, x.idx)).join("")}</div>` : "";

    const reviewSectionHtml = needsReviewRows.length ? `
      <div class="ss-batch-section-header">
        <span class="ss-batch-section-title ss-batch-section-review">Needs Review (${needsReviewRows.length})</span>
      </div>
      <div class="ss-batch-queue-list">${needsReviewRows.map(x => batchRowHtml(x.item, x.idx)).join("")}</div>` : "";

    const otherSectionHtml = otherRows.length ? `
      <div class="ss-batch-section-header">
        <span class="ss-batch-section-title">Other (${otherRows.length})</span>
      </div>
      <div class="ss-batch-queue-list">${otherRows.map(x => batchRowHtml(x.item, x.idx)).join("")}</div>` : "";

    content.innerHTML = `
      <p class="ss-hint">${esc(headerMsg)}</p>
      ${readySectionHtml}
      ${reviewSectionHtml}
      ${otherSectionHtml}`;

    const approveBtn = document.getElementById("ss-batch-approve-all");
    if (approveBtn) approveBtn.onclick = runBulkApproveConfident;

    document.querySelectorAll('.ss-batch-row-next[data-action="apply-next"]').forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        applyBatchItemAndNext(+btn.dataset.idx, btn);
      });
    });
    document.querySelectorAll('.ss-batch-row-next[data-action="review-next"]').forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const item = _batchQueue[+btn.dataset.idx];
        if (item) openQueueItemReview(item);
      });
    });

    document.querySelectorAll(".ss-batch-queue-row").forEach(row => {
      row.addEventListener("click", () => {
        const item = _batchQueue[+row.dataset.idx];
        if (item) openQueueItemReview(item);
      });
    });
  }

  // ── Bulk-apply all confident queue items in place, sequentially (same
  // "don't hammer local Stash / target sites concurrently" reasoning as
  // the queue-building pass). needs-review/no-match/error items are never
  // touched -- the array itself is never filtered or replaced, only
  // confident items get mutated (status: "applied", or reclassified to
  // "error" on a failed apply so it's visible and reuses the exact same
  // badge/render path the queue-building engine's own error items use).
  async function runBulkApproveConfident() {
    const confidentItems = _batchQueue.filter(i => i.classification === "confident" && i.status !== "applied");
    if (!confidentItems.length) return;
    if (!window.confirm(`Apply ${confidentItems.length} confident scene${confidentItems.length !== 1 ? "s" : ""} now?`)) return;

    setBatchError("");
    let succeeded = 0;
    const failures = [];

    for (let i = 0; i < confidentItems.length; i++) {
      const item = confidentItems[i];
      setBatchStatus(`Applying ${i + 1} of ${confidentItems.length} confident scene${confidentItems.length !== 1 ? "s" : ""}…`);
      try {
        await applyConfidentBatchItem(item);
        item.status = "applied";
        succeeded++;
      } catch (e) {
        item.classification = "error";
        item.reason = `Apply failed: ${e.message}`;
        failures.push(e.message);
      }
      renderBatchQueueResults();
    }

    setBatchStatus(failures.length
      ? `${succeeded} of ${confidentItems.length} applied successfully, ${failures.length} failed: ${failures.join("; ")}`
      : `✓ ${succeeded} of ${confidentItems.length} confident scene${confidentItems.length !== 1 ? "s" : ""} applied.`);
  }

  // ── Apply & Next -- applies exactly one confident row via the same
  // applyConfidentBatchItem call runBulkApproveConfident already uses (no
  // parallel apply path), then re-renders the results screen. "Next" is
  // deliberately just that re-render: the applied item drops out of the
  // pending set (same status:"applied" convention as the bulk path), so
  // whatever's now first in the Ready to Approve section is simply what's
  // next -- no separate current-item/index tracking needed, mirroring how
  // runBulkApproveConfident already re-renders after every single item.
  async function applyBatchItemAndNext(idx, btn) {
    const item = _batchQueue[idx];
    if (!item) return;
    setBatchError("");
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
      await applyConfidentBatchItem(item);
      item.status = "applied";
    } catch (e) {
      item.classification = "error";
      item.reason = `Apply failed: ${e.message}`;
      setBatchError(e.message);
    }
    renderBatchQueueResults();
  }

  // ── Individual review: opens the single-scene modal directly at the
  // comparison-table (item has scrapeOutput) or manual confirm/search step
  // (item doesn't), reusing renderApply/renderMatchState verbatim instead of
  // a parallel review UI. opts.onBack leaves the item untouched; onDismiss
  // and the reused Apply path both remove it from _batchQueue and re-render
  // the queue -- bulk-approve reads _batchQueue fresh every render, so its
  // confident count/button reflect the removal automatically.
  function removeFromBatchQueue(item) {
    _batchQueue = _batchQueue.filter(i => i !== item);
  }

  function openQueueItemReview(item) {
    setBatchError("");
    if (!item.current) {
      setBatchError("Can't review this item — its scene data failed to load earlier.");
      return;
    }

    const opts = {
      stashDbStepShown: item.viaStashDb,
      viaStashDb: item.viaStashDb,
      markOrganized: item.markOrganized,
      addZzzUploadTag: item.addZzzUploadTag,
      skipZzzUploadForStashDb: item.skipZzzUploadForStashDb,
      stashDbBox: item.stashDbBox,
      onBack: () => { closeModal(); renderBatchQueueResults(); },
      onDismiss: () => { removeFromBatchQueue(item); closeModal(); renderBatchQueueResults(); },
      onApplied: () => { removeFromBatchQueue(item); closeModal(); renderBatchQueueResults(); },
    };

    if (item.viaStashDb && item.stashDbScenes) {
      openModal(item.sceneId, () => renderStashDbResults(item.sceneId, item.current, item.stashDbScenes, opts));
    } else if (item.scrapeOutput && item.duplicates?.length) {
      // Pre-existing gap, not new to this session: this branch never
      // checked item.duplicates before, so ANY batch item flagged
      // needs-review for a duplicate (site-adapter or StashDB-sourced)
      // jumped straight to renderApply on review, skipping dupe
      // resolution entirely. renderDuplicates itself already routes into
      // renderApply via its Keep/Delete/(rich) buttons using the same
      // opts, so this needs no further wiring beyond the branch itself.
      openModal(item.sceneId, () => renderDuplicates(
        item.sceneId, item.current, item.parsed, null, item.storeInfo, item.storeKey,
        item.searchOutput, item.scrapeOutput, item.contentUrl, item.scrapedThumbnail, item.duplicates, opts
      ));
    } else if (item.scrapeOutput) {
      openModal(item.sceneId, () => renderApply(
        item.sceneId, item.current, item.parsed, null, item.storeInfo, item.storeKey,
        item.searchOutput, item.scrapeOutput, item.contentUrl, item.scrapedThumbnail, opts
      ));
    } else {
      const parsed = item.parsed || { performerCandidate: "", titleCandidate: item.current.title || "" };
      const match = item.storeInfo
        ? { confidence: "confident", source: "batch_queue", match: item.storeInfo, score: 1, suggestions: [] }
        : { confidence: "no-match", source: "batch_queue", match: null, score: 0, suggestions: [] };
      openModal(item.sceneId, () => renderMatchState(item.sceneId, item.current, parsed, match, false, opts));
    }
  }

  async function runBatchQueue(selectedIds) {
    _batchQueue = [];
    _batchStopRequested = false;

    let cfg;
    try {
      cfg = await readConfig();
    } catch (e) {
      setBatchError(e.message);
      return;
    }

    let stashDbBox = null;
    if (cfg.stashDbFirstEnabled) {
      try { stashDbBox = await findStashDbBox(); } catch (_) { stashDbBox = null; }
    }
    const runOpts = { stashDbFirstEnabled: !!cfg.stashDbFirstEnabled, stashDbBox, markOrganized: !!cfg.markOrganizedDefault, addZzzUploadTag: !!cfg.addZzzUploadTagDefault, skipZzzUploadForStashDb: !!cfg.skipZzzUploadForStashDbDefault };

    const total = selectedIds.length;
    renderBatchProgress(0, total);

    for (let i = 0; i < total; i++) {
      if (_batchStopRequested) break;
      const item = await processBatchScene(selectedIds[i], cfg.performerStoreMap, runOpts);
      _batchQueue.push(item);
      renderBatchProgress(i + 1, total);
    }

    renderBatchQueueResults();
  }

  async function renderBatchSceneSelect() {
    setBatchError(""); setBatchStatus("Loading untagged scenes…");
    const content = document.getElementById("ss-batch-content");
    content.innerHTML = `<p class="ss-hint">Loading scenes…</p>`;

    const decoded = isScenesLibraryPage() ? decodeStashFilterCriteria() : {};
    let cfg, scenes;
    try {
      [cfg, scenes] = await Promise.all([
        readConfig().catch(() => ({ stashDbFirstEnabled: true, markOrganizedDefault: false, addZzzUploadTagDefault: false, skipZzzUploadForStashDbDefault: true })),
        fetchBatchCandidateScenes(decoded),
      ]);
    } catch (e) {
      setBatchStatus("");
      setBatchError(e.message);
      return;
    }
    setBatchStatus("");
    _batchAllScenes = scenes;
    _batchSelectedIds = new Set();
    _batchNameFilter = "";

    const summaryBits = summarizeDecodedFilter(decoded);
    const summaryHtml = summaryBits.length
      ? `<p class="ss-hint">Showing untagged scenes matching your current filter: ${esc(summaryBits.join("; "))}</p>`
      : `<p class="ss-hint">Showing all untagged scenes.</p>`;

    if (!_batchAllScenes.length) {
      content.innerHTML = `${summaryHtml}<p class="ss-hint">No untagged scenes found — nothing to batch scrape.</p>`;
      return;
    }

    content.innerHTML = `
      ${summaryHtml}
      <div class="ss-row">
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-batch-toggle-stashdb-first" ${cfg.stashDbFirstEnabled ? "checked" : ""} />
          <span>Check StashDB fingerprint match first</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-batch-toggle-mark-organized" ${cfg.markOrganizedDefault ? "checked" : ""} />
          <span>Mark scenes as Organized when applying</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-batch-toggle-zzz-upload" ${cfg.addZzzUploadTagDefault ? "checked" : ""} />
          <span>Add "zzz-upload" tag when applying</span>
        </label>
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-batch-toggle-skip-zzz-stashdb" ${cfg.skipZzzUploadForStashDbDefault ? "checked" : ""} />
          <span>Skip zzz-upload tag for StashDB matches</span>
        </label>
      </div>
      <div class="ss-row">
        <input id="ss-batch-namefilter" class="ss-input" type="text" placeholder="Filter by filename/title…" />
      </div>
      <div class="ss-row" style="justify-content:space-between">
        <label class="ss-item-label" style="margin:0">
          <input type="checkbox" id="ss-batch-selall" />
          <span>Select all</span>
        </label>
        <span id="ss-batch-count" class="ss-hint">0 selected</span>
      </div>
      <div id="ss-batch-scene-list" class="ss-batch-scene-list"></div>
      <div class="ss-row" style="margin-top:.5rem;flex-shrink:0">
        <button id="ss-batch-start" class="ss-btn ss-btn-primary" disabled>Start Batch</button>
      </div>`;

    drawBatchSceneList();

    document.getElementById("ss-batch-toggle-stashdb-first").addEventListener("change", e => {
      writeConfig({ stashDbFirstEnabled: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-batch-toggle-mark-organized").addEventListener("change", e => {
      writeConfig({ markOrganizedDefault: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-batch-toggle-zzz-upload").addEventListener("change", e => {
      writeConfig({ addZzzUploadTagDefault: e.target.checked }).catch(() => {});
    });
    document.getElementById("ss-batch-toggle-skip-zzz-stashdb").addEventListener("change", e => {
      writeConfig({ skipZzzUploadForStashDbDefault: e.target.checked }).catch(() => {});
    });

    document.getElementById("ss-batch-namefilter").addEventListener("input", e => {
      _batchNameFilter = e.target.value;
      drawBatchSceneList();
    });

    document.getElementById("ss-batch-selall").addEventListener("change", e => {
      const checked = e.target.checked;
      const visible = visibleBatchScenes();
      visible.forEach(s => { if (checked) _batchSelectedIds.add(s.id); else _batchSelectedIds.delete(s.id); });
      drawBatchSceneList();
    });

    document.getElementById("ss-batch-start").onclick = () => {
      runBatchQueue([..._batchSelectedIds]);
    };
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  startListening();
  startBatchToolbarWatcher();

})();
