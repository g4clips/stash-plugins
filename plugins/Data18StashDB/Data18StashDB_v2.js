// Data18StashDB Plugin v2.1 — simplified
// Python handles all scraping + StashDB search.
// JS handles UI and applies metadata directly via GraphQL.

(function () {
  "use strict";

  const BTN_ID     = "d18-open-btn";
  const MODAL_ID   = "d18-modal-overlay";
  const RESULT_TAG = "__d18_result__";

  // ── Utilities ──────────────────────────────────────────────────────────────

  function getSceneId()  { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage() { return !!getSceneId(); }
  function getModal()    { return document.getElementById(MODAL_ID); }
  function getContent()  { return document.getElementById("d18-content"); }

  function setStatus(msg) {
    const el = document.getElementById("d18-status");
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function setError(msg) {
    const el = document.getElementById("d18-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  function setInfo(html) {
    const el = document.getElementById("d18-info");
    if (!el) return;
    if (!html) { el.style.display = "none"; el.innerHTML = ""; return; }
    el.innerHTML = `<span>${html}</span><button id="d18-info-dismiss" title="Dismiss">✕</button>`;
    el.style.display = "flex";
    document.getElementById("d18-info-dismiss").onclick = () => setInfo("");
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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

  // ── Run Python task and read result from __d18_result__ tag ───────────────

  async function runTask(taskName, args, statusMsg) {
    if (statusMsg) setStatus(statusMsg);

    const argsArray = Object.entries(args).map(([key, value]) => ({
      key,
      value: { str: typeof value === "string" ? value : JSON.stringify(value) },
    }));

    const startData = await gql(`
      mutation RunTask($name: String!, $args: [PluginArgInput!]) {
        runPluginTask(plugin_id: "Data18StashDB", task_name: $name, args: $args)
      }
    `, { name: taskName, args: argsArray });

    const jobId = startData.runPluginTask;
    if (!jobId) throw new Error(`Could not start task: ${taskName}`);

    // Poll until job disappears from queue
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (statusMsg) setStatus(`${statusMsg} (${i + 1}s)`);
      try {
        const jd = await gql(`
          query FindJob($input: FindJobInput!) {
            findJob(input: $input) { id status description }
          }
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

    // Read result from __d18_result__ tag
    const td = await gql(`
      query {
        findTags(filter: { q: ${JSON.stringify(RESULT_TAG)}, per_page: 1 }) {
          tags { id name description }
        }
      }
    `);

    const tag = (td.findTags.tags || []).find(t => t.name === RESULT_TAG);
    if (!tag?.description) {
      throw new Error(`Task completed but returned no result. Check Settings → Logs.`);
    }

    // Clean up temp tag
    try { await gql(`mutation D($id:ID!){tagDestroy(input:{id:$id})}`, { id: tag.id }); } catch (_) {}

    const result = JSON.parse(tag.description);
    if (result.error) throw new Error(result.error);
    return result.output;
  }

  // ── Fetch current scene ────────────────────────────────────────────────────

  async function fetchCurrentScene(sceneId) {
    const data = await gql(`
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id title date details urls
          stash_ids { stash_id endpoint }
          studio { id name }
          performers { id name }
          tags { id name }
          paths { screenshot }
          groups { group { id name urls } scene_index }
        }
      }
    `, { id: sceneId });
    return data.findScene;
  }

  // ── Resolve local Stash IDs ────────────────────────────────────────────────

  async function resolveLocally(entityType, names) {
    const q = {
      performer: `query F($q:String){findPerformers(filter:{q:$q,per_page:5}){performers{id name}}}`,
      studio:    `query F($q:String){findStudios(filter:{q:$q,per_page:1}){studios{id name}}}`,
      tag:       `query F($q:String){findTags(filter:{q:$q,per_page:5}){tags{id name}}}`,
    };
    const rk = { performer:"findPerformers", studio:"findStudios", tag:"findTags" };
    const lk = { performer:"performers",     studio:"studios",     tag:"tags"     };

    const results = [];
    for (const name of names) {
      const data  = await gql(q[entityType], { q: name });
      const items = data[rk[entityType]][lk[entityType]];
      const found = items.find(x => x.name.toLowerCase() === name.toLowerCase());
      results.push({ name, localId: found?.id || null, found: !!found });
    }
    return results;
  }

  // ── Apply metadata directly via GraphQL ───────────────────────────────────

  async function applyToScene(sceneId, match, fieldChecks, selPerfs, selTags,
                               resolvedPerfs, studioMatch, resolvedTags, current) {
    setStatus("Applying metadata…");
    const input = { id: sceneId };

    if (fieldChecks.title   && match.title)   input.title       = match.title;
    if (fieldChecks.date    && match.date)     input.date        = match.date;
    if (fieldChecks.details && match.details)  input.details     = match.details;
    if (fieldChecks.image   && match.image)    input.cover_image = match.image;
    if (fieldChecks.urls    && match.urls?.length) input.urls    = match.urls;

    if (fieldChecks.studio && studioMatch?.found) {
      input.studio_id = studioMatch.localId;
    }

    if (fieldChecks.performers && selPerfs.length) {
      const ids = resolvedPerfs
        .filter(p => selPerfs.includes(p.name) && p.localId)
        .map(p => p.localId);
      if (ids.length) input.performer_ids = ids;
    }

    if (fieldChecks.tags && selTags.length) {
      const ids = resolvedTags
        .filter(t => selTags.includes(t.name) && t.localId)
        .map(t => t.localId);
      if (ids.length) input.tag_ids = ids;
    }

    if (fieldChecks.stash_id && match.remote_site_id) {
      // Merge with existing stash_ids, replacing any existing stashdb.org entry
      const existing = (current.stash_ids || [])
        .filter(s => s.endpoint !== "https://stashdb.org/graphql")
        .map(s => ({ stash_id: s.stash_id, endpoint: s.endpoint }));
      input.stash_ids = [
        ...existing,
        { stash_id: match.remote_site_id, endpoint: "https://stashdb.org/graphql" },
      ];
    }

    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
  }

  // ── Create performer in local Stash from StashDB ──────────────────────────

  async function createPerformerInStash(name) {
    const cfg   = await gql(`query { configuration { general { stashBoxes { endpoint } } } }`);
    const boxes = cfg.configuration.general.stashBoxes || [];
    const idx   = boxes.findIndex(b => b.endpoint.includes("stashdb.org"));
    if (idx === -1) throw new Error("StashDB not configured in Stash-Box settings");

    const scrapeData = await gql(`
      query($src: ScraperSourceInput!, $input: ScrapeSinglePerformerInput!) {
        scrapeSinglePerformer(source: $src, input: $input) {
          name gender birthdate death_date urls details ethnicity
          country hair_color eye_color height weight
          measurements fake_tits tattoos piercings aliases
          career_start career_end images remote_site_id
        }
      }
    `, {
      src:   { stash_box_index: idx },
      input: { query: name },
    });

    const list = [].concat(scrapeData.scrapeSinglePerformer || []).filter(Boolean);
    if (!list.length) throw new Error(`Not found on StashDB: ${name}`);
    const p = list[0];

    const input = { name: p.name || name };
    if (p.gender)       input.gender       = p.gender;
    if (p.birthdate)    input.birthdate    = p.birthdate;
    if (p.death_date)   input.death_date   = p.death_date;
    if (p.details)      input.details      = p.details;
    if (p.country)      input.country      = p.country;
    if (p.hair_color)   input.hair_color   = p.hair_color;
    if (p.eye_color)    input.eye_color    = p.eye_color;
    if (p.height)       input.height_cm    = parseInt(p.height, 10) || undefined;
    if (p.weight)       input.weight       = parseInt(p.weight, 10) || undefined;
    if (p.measurements) input.measurements = p.measurements;
    if (p.fake_tits)    input.fake_tits    = p.fake_tits;
    if (p.tattoos)      input.tattoos      = p.tattoos;
    if (p.piercings)    input.piercings    = p.piercings;
    if (p.aliases)      input.alias_list   = p.aliases.split(",").map(a => a.trim()).filter(Boolean);
    if (p.career_start) input.career_start = p.career_start;
    if (p.career_end)   input.career_end   = p.career_end;
    if (p.images?.length) input.image      = p.images[0];
    if (p.urls?.length)   input.urls       = p.urls;
    if (p.remote_site_id) input.stash_ids  = [
      { stash_id: p.remote_site_id, endpoint: boxes[idx].endpoint },
    ];

    const result = await gql(`
      mutation($input: PerformerCreateInput!) {
        performerCreate(input: $input) { id name }
      }
    `, { input });

    if (!result.performerCreate) throw new Error(`Create mutation returned no result`);
    return result.performerCreate;
  }

  // ── Button injection ───────────────────────────────────────────────────────

  function injectButton() {
    if (!isScenePage() || document.getElementById(BTN_ID)) return;
    const tryInsert = () => {
      const target =
        document.querySelector(".scene-toolbar") ||
        document.querySelector(".details-edit .buttons-container") ||
        document.querySelector(".scene-header .d-flex") ||
        document.querySelector(".VideoPlayer");
      if (!target) return false;
      const btn = document.createElement("button");
      btn.id = BTN_ID;
      btn.className = "btn btn-secondary";
      btn.textContent = "Data18";
      btn.title = "Scrape Data18 and match to StashDB";
      btn.style.cssText = "margin-left:8px;font-size:.85rem;";
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
      setInterval(() => {
        if (window.location.pathname !== last) { last = window.location.pathname; onLocationChange(); }
      }, 500);
    }
    onLocationChange();
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  function closeModal() { getModal()?.remove(); }

  function openModal(sceneId) {
    if (getModal()) return;
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div id="d18-box">
        <div id="d18-header">
          <span>Data18 → StashDB Matcher</span>
          <button id="d18-close">✕</button>
        </div>
        <div id="d18-error"  style="display:none"></div>
        <div id="d18-info"   style="display:none"></div>
        <div id="d18-status" style="display:none"></div>
        <div id="d18-content"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("d18-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

    // ── Drag to move ────────────────────────────────────────────────────────
    const box    = document.getElementById("d18-box");
    const header = document.getElementById("d18-header");
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

    // Quick fetch to check for a linked group with a Data18 movie URL
    setStatus("Loading…");
    fetchCurrentScene(sceneId).then(scene => {
      setStatus("");
      let groupUrl = null, groupName = null;
      for (const g of (scene?.groups || [])) {
        const u = (g.group?.urls || []).find(url => url.includes("data18.com/movies/"));
        if (u) { groupUrl = u; groupName = g.group.name; break; }
      }
      renderInput(sceneId, groupUrl, groupName);
    }).catch(() => {
      setStatus("");
      renderInput(sceneId);
    });
  }

  // ── Step 1: URL input ──────────────────────────────────────────────────────

  function renderInput(sceneId, prefillUrl, groupName) {
    setError(""); setStatus("");
    getContent().innerHTML = `
      <p class="d18-hint">
        Paste a <strong>data18.com/scenes/</strong> or <strong>data18.com/movies/</strong> URL.
        Movie URLs show a scene picker first.
      </p>
      <div class="d18-row">
        <input id="d18-url" class="d18-input" type="url"
               placeholder="https://www.data18.com/movies/1259710-horny-hotwife" />
        <button id="d18-go" class="d18-btn d18-btn-primary">Go</button>
      </div>`;

    const input = document.getElementById("d18-url");
    const btn   = document.getElementById("d18-go");

    async function go() {
      const url = input.value.trim();
      const isMovie = url.includes("data18.com/movies/");
      const isScene = url.includes("data18.com/scenes/");
      if (!isMovie && !isScene) {
        setError("Please enter a data18.com/scenes/ or data18.com/movies/ URL"); return;
      }
      setError(""); btn.disabled = true; btn.textContent = "Loading…";

      if (isMovie) {
        try {
          const movie = await runTask("Scrape Data18 Movie",
            { mode: "scrape_movie", url }, "Scraping movie page…");
          setStatus("");
          renderScenePicker(sceneId, movie);
        } catch (e) {
          setError(e.message); btn.disabled = false; btn.textContent = "Go"; setStatus("");
        }
      } else {
        try {
          const data = await runTask("Scrape Data18 Scene",
            { mode: "scrape_scene", url }, "Scraping scene…");
          setStatus("");
          renderQuery(sceneId, data.scraped, data.query);
        } catch (e) {
          setError(e.message); btn.disabled = false; btn.textContent = "Go"; setStatus("");
        }
      }
    }

    btn.onclick = go;
    input.addEventListener("keydown", e => e.key === "Enter" && go());
    if (prefillUrl) {
      input.value = prefillUrl;
      setInfo(`Auto-filled from linked group: <strong>${esc(groupName || "unknown")}</strong>`);
      setTimeout(go, 0);
    } else {
      setInfo("");
      input.focus();
    }
  }

  // ── Step 1b: Movie scene picker ────────────────────────────────────────────

  function renderScenePicker(sceneId, movie) {
    setError("");
    const cardsHtml = movie.scenes.map((s, i) => `
      <div class="d18-scene-pick-card" data-idx="${i}">
        <div class="d18-scene-pick-thumb">
          ${s.image ? `<img src="${esc(s.image)}" alt="">` : `<div class="d18-no-img"></div>`}
          <span class="d18-scene-num">Scene ${s.sceneIndex}</span>
        </div>
        <div class="d18-scene-pick-info">
          <div class="d18-scene-pick-title">${esc(s.title || "Scene " + s.sceneIndex)}</div>
          ${s.performers.length ? `<div class="d18-scene-pick-sub">${esc(s.performers.join(", "))}</div>` : ""}
          ${s.date ? `<div class="d18-scene-pick-sub">${esc(s.date)}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      ${movie.movieTitle ? `
        <div class="d18-movie-header">
          ${movie.movieImage ? `<img class="d18-movie-thumb" src="${esc(movie.movieImage)}" alt="">` : ""}
          <div class="d18-movie-title">${esc(movie.movieTitle)}</div>
        </div>` : ""}
      <p class="d18-hint">Select the scene that matches the one you are editing:</p>
      <div class="d18-scene-pick-list">${cardsHtml}</div>
      <div class="d18-row" style="margin-top:.5rem">
        <button id="d18-back-pick" class="d18-btn d18-btn-secondary">← Back</button>
      </div>`;

    document.querySelectorAll(".d18-scene-pick-card").forEach(card => {
      card.addEventListener("click", async () => {
        const scene = movie.scenes[+card.dataset.idx];
        card.classList.add("d18-card-loading");
        try {
          const data = await runTask("Scrape Data18 Scene",
            { mode: "scrape_scene", url: scene.sceneUrl },
            "Scraping scene…");
          setStatus("");
          renderQuery(sceneId, data.scraped, data.query);
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("d18-card-loading");
        }
      });
    });
    document.getElementById("d18-back-pick").onclick = () => renderInput(sceneId);
  }

  // ── Step 2: Query builder ─────────────────────────────────────────────────

  function renderQuery(sceneId, scraped, initialQuery) {
    setError("");
    const perfs = scraped.performers || [];
    const parts = [];
    if (scraped.studio) parts.push(scraped.studio);
    parts.push(...perfs.slice(0, 2));
    const initial = initialQuery || parts.join(" ") || scraped.title || "";

    const pillsHtml = [
      scraped.studio ? `<span class="d18-pill d18-pill-studio" data-w="${esc(scraped.studio)}">${esc(scraped.studio)}</span>` : "",
      ...perfs.map(p  => `<span class="d18-pill d18-pill-performer" data-w="${esc(p)}">${esc(p)}</span>`),
      scraped.title  ? `<span class="d18-pill d18-pill-title"  data-w="${esc(scraped.title)}">${esc(scraped.title)}</span>` : "",
    ].join("");

    getContent().innerHTML = `
      <div class="d18-preview">
        ${scraped.image ? `<img class="d18-thumb" src="${esc(scraped.image)}" alt="">` : ""}
        <div class="d18-preview-meta">
          ${scraped.title  ? `<div><strong>Title:</strong> ${esc(scraped.title)}</div>`             : ""}
          ${scraped.studio ? `<div><strong>Studio:</strong> ${esc(scraped.studio)}</div>`           : ""}
          ${perfs.length   ? `<div><strong>Performers:</strong> ${esc(perfs.join(", "))}</div>`     : ""}
          ${scraped.date   ? `<div><strong>Date:</strong> ${esc(scraped.date)}</div>`               : ""}
        </div>
      </div>
      <p class="d18-hint" style="margin-top:.6rem">Click tokens to add/remove from query, or edit freely:</p>
      <div class="d18-pills">${pillsHtml}</div>
      <div class="d18-row">
        <input id="d18-query" class="d18-input" type="text"
               value="${esc(initial)}" placeholder="Search query…" />
        <button id="d18-search" class="d18-btn d18-btn-primary">Search StashDB</button>
      </div>
      <div class="d18-row" style="margin-top:.3rem">
        <button id="d18-back1" class="d18-btn d18-btn-secondary">← Back</button>
      </div>`;

    const qEl = document.getElementById("d18-query");

    document.querySelectorAll(".d18-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        const words = pill.dataset.w.trim().split(/\s+/);
        let parts = qEl.value.trim().split(/\s+/).filter(Boolean);
        const allIn = words.every(w => parts.includes(w));
        parts = allIn ? parts.filter(p => !words.includes(p))
                      : [...parts, ...words.filter(w => !parts.includes(w))];
        qEl.value = parts.join(" ");
        pill.classList.toggle("d18-pill-on", !allIn);
      });
    });

    async function search() {
      const q = qEl.value.trim();
      if (!q) { setError("Enter a search query"); return; }
      setError("");
      const btn = document.getElementById("d18-search");
      btn.disabled = true; btn.textContent = "Searching…";
      setStatus("Searching StashDB…");
      document.getElementById("d18-status").style.display = "block";
      try {
        const data = await runTask("Scrape Data18 Scene",
          { mode: "scrape_scene", url: scraped.url, query_override: q },
          "Searching StashDB…");
        setStatus("");
        if (!data.candidates.length) {
          setError("No results — try a different query");
          btn.disabled = false; btn.textContent = "Search StashDB";
          return;
        }
        renderResults(sceneId, data.scraped || scraped, data.candidates, data.query || q);
      } catch (e) {
        setError(e.message); btn.disabled = false; btn.textContent = "Search StashDB"; setStatus("");
      }
    }

    document.getElementById("d18-search").onclick = search;
    qEl.addEventListener("keydown", e => e.key === "Enter" && search());
    document.getElementById("d18-back1").onclick = () => renderInput(sceneId);
  }

  // ── Step 3: StashDB results ────────────────────────────────────────────────

  function renderResults(sceneId, scraped, results, query) {
    setError("");

    // Helper: truncate description to first ~120 chars for preview
    function shortDesc(text) {
      if (!text) return "";
      return text.length > 120 ? text.slice(0, 117) + "…" : text;
    }

    // Data18 reference panel shown above results for comparison
    const d18Html = `
      <div class="d18-compare-ref">
        <div class="d18-compare-ref-label">Data18 reference</div>
        <div class="d18-preview" style="margin:0">
          ${scraped.image ? `<div class="d18-thumb-wrap"><img class="d18-thumb" src="${esc(scraped.image)}" alt=""><div class="d18-thumb-hover"><img src="${esc(scraped.image)}" alt=""></div></div>` : ""}
          <div class="d18-preview-meta">
            ${scraped.title  ? `<div><strong>Title:</strong> ${esc(scraped.title)}</div>` : ""}
            ${scraped.studio ? `<div><strong>Studio:</strong> ${esc(scraped.studio)}</div>` : ""}
            ${scraped.performers?.length ? `<div><strong>Performers:</strong> ${esc(scraped.performers.join(", "))}</div>` : ""}
            ${scraped.date   ? `<div><strong>Date:</strong> ${esc(scraped.date)}</div>` : ""}
            ${scraped.description ? `<div class="d18-result-desc">${esc(shortDesc(scraped.description))}</div>` : ""}
          </div>
        </div>
      </div>`;

    const cards = results.map((r, i) => `
      <div class="d18-result-card" data-idx="${i}">
        ${r.image
          ? `<div class="d18-thumb-wrap"><img class="d18-result-thumb" src="${esc(r.image)}" alt=""><div class="d18-thumb-hover"><img src="${esc(r.image)}" alt=""></div></div>`
          : `<div class="d18-result-thumb d18-no-img"></div>`}
        <div class="d18-result-info">
          <div class="d18-result-title">${esc(r.title || "(no title)")}</div>
          ${r.studio?.name       ? `<div class="d18-result-sub">${esc(r.studio.name)}</div>` : ""}
          ${r.performers?.length ? `<div class="d18-result-sub">${esc(r.performers.map(p=>p.name).join(", "))}</div>` : ""}
          ${r.date               ? `<div class="d18-result-sub">${esc(r.date)}</div>` : ""}
          ${r.details            ? `<div class="d18-result-desc">${esc(shortDesc(r.details))}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      ${d18Html}
      <p class="d18-hint" style="margin-top:.5rem">${results.length} result${results.length !== 1 ? "s" : ""} — click to select:</p>
      <div class="d18-results">${cards}</div>
      <div class="d18-row" style="margin-top:.5rem">
        <button id="d18-back2" class="d18-btn d18-btn-secondary">← Back</button>
      </div>`;

    document.querySelectorAll(".d18-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        const match = results[+card.dataset.idx];
        setStatus("Checking for duplicates…");
        document.getElementById("d18-status").style.display = "block";
        try {
          const resolvedPerfs  = match.resolved_performers || [];
          const resolvedStudio = match.resolved_studio     || null;
          const resolvedTags   = match.resolved_tags       || [];
          const [current, allDupes] = await Promise.all([
            fetchCurrentScene(sceneId),
            findDuplicates(match, resolvedPerfs),
          ]);
          setStatus("");
          const dupes = allDupes.filter(d => d.id !== sceneId);
          if (dupes.length) {
            renderDuplicates(sceneId, current, match, scraped, results, query,
                             resolvedPerfs, resolvedStudio, resolvedTags, dupes);
          } else {
            renderApply(sceneId, current, match, scraped, results, query,
                        resolvedPerfs, resolvedStudio, resolvedTags);
          }
        } catch(e) {
          setError(e.message); setStatus("");
        }
      });
    });

    document.getElementById("d18-back2").onclick = () => renderQuery(sceneId, scraped, query);
  }

  // ── Duplicate detection ───────────────────────────────────────────────────

  async function findDuplicates(match, resolvedPerfs) {
    if (match.remote_site_id) {
      const d = await gql(`
        query($stash_id: String!) {
          findScenes(
            scene_filter: {
              stash_id_endpoint: {
                stash_id: $stash_id
                endpoint: "https://stashdb.org/graphql"
                modifier: EQUALS
              }
            }
            filter: { per_page: 5 }
          ) {
            scenes {
              id title date
              paths { screenshot }
              files { size }
              performers { id name }
              groups { group { id name } scene_index }
            }
          }
        }
      `, { stash_id: match.remote_site_id });
      const scenes = d.findScenes?.scenes || [];
      if (scenes.length) return scenes;
    }

    const perfIds = (resolvedPerfs || []).filter(p => p.localId).map(p => p.localId);
    if (!perfIds.length || !match.date) return [];

    const d2 = await gql(`
      query($ids: [ID!], $date: String!) {
        findScenes(
          scene_filter: {
            performers: { value: $ids, modifier: INCLUDES }
            date: { value: $date, modifier: EQUALS }
          }
          filter: { per_page: 5 }
        ) {
          scenes {
            id title date
            paths { screenshot }
            files { size }
            performers { id name }
            groups { group { id name } scene_index }
          }
        }
      }
    `, { ids: perfIds, date: match.date });
    return d2.findScenes?.scenes || [];
  }

  // ── Step 2b: Duplicate scene warning ─────────────────────────────────────

  function renderDuplicates(sceneId, current, match, scraped, results, query,
                            resolvedPerfs, studioMatch, resolvedTags, dupes) {
    setError("");

    function fmtSize(bytes) {
      if (!bytes) return null;
      return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
    }

    const currentGroup = (current.groups || [])[0] || null;

    const goApply = (targetId, targetCurrent) =>
      renderApply(targetId, targetCurrent, match, scraped, results, query,
                  resolvedPerfs, studioMatch, resolvedTags);

    const cardsHtml = dupes.map((d, i) => {
      const groupLabels = (d.groups || [])
        .map(g => g.group.name + (g.scene_index ? ` #${g.scene_index}` : ""))
        .join(", ");
      const size  = fmtSize((d.files || [])[0]?.size);
      const thumb = d.paths?.screenshot;
      return `
        <div class="d18-dupe-card">
          <div class="d18-thumb-wrap">
            ${thumb
              ? `<img class="d18-result-thumb" src="${esc(thumb)}" alt=""><div class="d18-thumb-hover"><img src="${esc(thumb)}" alt=""></div>`
              : `<div class="d18-result-thumb d18-no-img"></div>`}
          </div>
          <div class="d18-result-info" style="flex:1">
            <div class="d18-result-title">${esc(d.title || "(no title)")}</div>
            ${d.date      ? `<div class="d18-result-sub">${esc(d.date)}</div>` : ""}
            ${groupLabels ? `<div class="d18-result-sub">Group: ${esc(groupLabels)}</div>` : ""}
            ${size        ? `<div class="d18-result-sub">Size: ${size}</div>` : ""}
          </div>
          <div class="d18-dupe-actions">
            ${currentGroup ? `
              <button class="d18-btn d18-btn-secondary d18-btn-xs d18-dupe-link" data-idx="${i}">Keep existing &amp; link to group</button>
              <div class="d18-dupe-replace-wrap">
                <button class="d18-btn d18-btn-danger d18-btn-xs d18-dupe-replace" data-idx="${i}">Keep existing &amp; delete current</button>
                <label class="d18-dupe-del-label">
                  <input type="checkbox" class="d18-dupe-del-chk" data-idx="${i}" />
                  <span>also delete current file from disk</span>
                </label>
              </div>
            ` : `
              <button class="d18-btn d18-btn-secondary d18-btn-xs d18-dupe-use" data-idx="${i}">Apply metadata to existing scene</button>
            `}
            <button class="d18-btn d18-btn-secondary d18-btn-xs d18-dupe-ignore" data-idx="${i}">Keep current scene</button>
            <span class="d18-dupe-msg d18-perf-inline-msg"></span>
          </div>
        </div>`;
    }).join("");

    getContent().innerHTML = `
      <div class="d18-dupe-header">⚠ This scene may already exist in your library — keep the existing file?</div>
      <div class="d18-dupe-list">${cardsHtml}</div>
      <div class="d18-row" style="margin-top:.5rem;flex-shrink:0">
        <button id="d18-dupe-back" class="d18-btn d18-btn-secondary">← Back</button>
        <button id="d18-dupe-skip" class="d18-btn d18-btn-secondary">Keep current scene for all</button>
      </div>`;

    document.getElementById("d18-dupe-back").onclick = () => renderResults(sceneId, scraped, results, query);
    document.getElementById("d18-dupe-skip").onclick = () => goApply(sceneId, current);

    document.querySelectorAll(".d18-dupe-ignore").forEach(btn =>
      btn.addEventListener("click", () => goApply(sceneId, current)));

    document.querySelectorAll(".d18-dupe-use").forEach(btn => {
      btn.addEventListener("click", async () => {
        const dupe = dupes[+btn.dataset.idx];
        const msg  = btn.closest(".d18-dupe-actions")?.querySelector(".d18-dupe-msg");
        btn.disabled = true; btn.textContent = "Loading…";
        try {
          const dupeScene = await fetchCurrentScene(dupe.id);
          goApply(dupe.id, dupeScene);
        } catch(e) {
          btn.disabled = false; btn.textContent = "Apply metadata to existing scene";
          if (msg) { msg.className = "d18-dupe-msg d18-perf-inline-msg d18-msg-err"; msg.textContent = `✗ ${e.message}`; }
        }
      });
    });

    document.querySelectorAll(".d18-dupe-link").forEach(btn => {
      btn.addEventListener("click", async () => {
        const dupe = dupes[+btn.dataset.idx];
        const msg  = btn.closest(".d18-dupe-actions")?.querySelector(".d18-dupe-msg");
        btn.disabled = true; btn.textContent = "Linking…";
        try {
          const existing = (dupe.groups || []).map(g => ({ group_id: g.group.id, scene_index: g.scene_index }));
          const newEntry = { group_id: currentGroup.group.id, scene_index: currentGroup.scene_index };
          const merged   = existing.some(g => g.group_id === newEntry.group_id) ? existing : [...existing, newEntry];
          await gql(`mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
            { input: { id: dupe.id, groups: merged } });
          const dupeScene = await fetchCurrentScene(dupe.id);
          goApply(dupe.id, dupeScene);
        } catch(e) {
          btn.disabled = false; btn.textContent = "Keep existing & link to group";
          if (msg) { msg.className = "d18-dupe-msg d18-perf-inline-msg d18-msg-err"; msg.textContent = `✗ ${e.message}`; }
        }
      });
    });

    document.querySelectorAll(".d18-dupe-replace").forEach(btn => {
      btn.addEventListener("click", async () => {
        const dupe    = dupes[+btn.dataset.idx];
        const delChk  = document.querySelector(`.d18-dupe-del-chk[data-idx="${btn.dataset.idx}"]`);
        const delFile = delChk?.checked || false;
        const msg     = btn.closest(".d18-dupe-actions")?.querySelector(".d18-dupe-msg");
        btn.disabled = true; btn.textContent = "Replacing…";
        try {
          const existing = (dupe.groups || []).map(g => ({ group_id: g.group.id, scene_index: g.scene_index }));
          const newEntry = { group_id: currentGroup.group.id, scene_index: currentGroup.scene_index };
          const merged   = existing.some(g => g.group_id === newEntry.group_id) ? existing : [...existing, newEntry];
          await gql(`mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
            { input: { id: dupe.id, groups: merged } });
          await gql(`mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
            { input: { ids: [sceneId], delete_file: delFile } });
          getContent().innerHTML = `
            <div class="d18-success">
              ✓ Current scene deleted. Existing scene kept and linked to group.
            </div>
            ${merged.length ? `
              <div style="margin-top:.75rem">
                <strong>Linked to:</strong>
                ${merged.map(g => `
                  <div style="margin-top:.25rem">
                    <a href="/groups/${esc(g.group_id)}" class="d18-group-link">
                      ${esc((dupe.groups || []).find(og => og.group.id === g.group_id)?.group.name
                            || currentGroup?.group.name
                            || g.group_id)}${g.scene_index ? ` — Scene ${g.scene_index}` : ""}
                    </a>
                  </div>`).join("")}
              </div>` : ""}
            <div class="d18-row" style="margin-top:.75rem">
              <button id="d18-close-done" class="d18-btn d18-btn-primary">Close</button>
            </div>`;
          document.getElementById("d18-close-done").onclick = closeModal;
        } catch(e) {
          btn.disabled = false; btn.textContent = "Keep existing & delete current";
          if (msg) { msg.className = "d18-dupe-msg d18-perf-inline-msg d18-msg-err"; msg.textContent = `✗ ${e.message}`; }
        }
      });
    });
  }

  // ── Step 3: Side-by-side comparison ───────────────────────────────────────

  function matchBadge(found) {
    return found
      ? `<span class="d18-badge d18-badge-found">✓ in Stash</span>`
      : `<span class="d18-badge d18-badge-missing">✗ not found</span>`;
  }

  function renderApply(sceneId, current, match, scraped, results, query,
                       resolvedPerfs, studioMatch, resolvedTags) {
    setError("");

    const currentPerfs = (current.performers || []).map(p => p.name);
    const currentTags  = (current.tags || []).map(t => t.name);

    const perfRowHtml = resolvedPerfs.length ? `
      <div class="d18-compare-row">
        <div class="d18-compare-label">Performers</div>
        <div class="d18-compare-current">${esc(currentPerfs.join(", ") || "—")}</div>
        <div class="d18-compare-incoming">
          ${resolvedPerfs.map(p => `
            <div class="d18-perf-row">
              <label class="d18-item-label">
                <input type="checkbox" class="d18-perf-chk" data-name="${esc(p.name)}" ${p.found ? "checked" : ""} />
                <span>${esc(p.name)} <span class="d18-perf-badge">${matchBadge(p.found)}</span></span>
              </label>
              ${!p.found ? `
                <button class="d18-btn d18-btn-secondary d18-btn-xs d18-perf-create"
                        data-name="${esc(p.name)}" type="button">Create in Stash</button>
                <span class="d18-perf-inline-msg"></span>` : ""}
            </div>`).join("")}
        </div>
        <div class="d18-compare-toggle">
          <input type="checkbox" class="d18-field-chk" data-field="performers" checked />
        </div>
      </div>` : "";

    const tagsRowHtml = resolvedTags.length ? (() => {
      const matched   = resolvedTags.filter(t =>  t.found);
      const unmatched = resolvedTags.filter(t => !t.found);
      return `
        <div class="d18-compare-row">
          <div class="d18-compare-label">Tags</div>
          <div class="d18-compare-current">${esc(currentTags.join(", ") || "—")}</div>
          <div class="d18-compare-incoming">
            ${matched.map(t => `
              <label class="d18-item-label">
                <input type="checkbox" class="d18-tag-chk" data-name="${esc(t.name)}" checked />
                <span>${esc(t.name)} ${matchBadge(true)}</span>
              </label>`).join("")}
            ${unmatched.length ? `
              <details>
                <summary class="d18-unmatched-toggle">${unmatched.length} not found in Stash</summary>
                ${unmatched.map(t => `
                  <label class="d18-item-label">
                    <input type="checkbox" class="d18-tag-chk" data-name="${esc(t.name)}" />
                    <span>${esc(t.name)} ${matchBadge(false)}</span>
                  </label>`).join("")}
              </details>` : ""}
          </div>
          <div class="d18-compare-toggle">
            <input type="checkbox" class="d18-field-chk" data-field="tags" checked />
          </div>
        </div>`;
    })() : "";

    // Find existing stash_id for this endpoint if any
    const existingStashId = (current.stash_ids || [])
      .find(s => s.endpoint === "https://stashdb.org/graphql")?.stash_id || "";

    const scalarFields = [
      ["title",   "Title",       current.title,                  match.title, false],
      ["date",    "Date",        current.date,                   match.date],
      ["details", "Description", current.details,                match.details],
      ["studio",  "Studio",      current.studio?.name,
        studioMatch ? `${esc(studioMatch.name)} ${matchBadge(studioMatch.found)}` : null],
      ["urls",    "URLs",        (current.urls||[]).join(", "),  (match.urls||[]).join(", ")],
      ["image",   "Cover Image", current.paths?.screenshot ? "Current image" : "—",
        match.image ? "StashDB image" : null],
      ["stash_id", "StashDB ID", existingStashId || "—",
        match.remote_site_id || null],
    ].filter(([,,,inc]) => inc);

    const scalarRowsHtml = scalarFields.map(([field, label, cur, inc, defaultChecked]) => `
      <div class="d18-compare-row">
        <div class="d18-compare-label">${esc(label)}</div>
        <div class="d18-compare-current ${field === "details" ? "d18-trunc" : ""}">${esc(cur || "—")}</div>
        <div class="d18-compare-incoming ${field === "details" ? "d18-trunc" : ""}">${inc}</div>
        <div class="d18-compare-toggle">
          <input type="checkbox" class="d18-field-chk" data-field="${field}" ${defaultChecked !== false ? "checked" : ""} />
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      <div class="d18-compare-table">
        <div class="d18-compare-header">
          <div class="d18-compare-label"></div>
          <div class="d18-compare-current">Current</div>
          <div class="d18-compare-incoming">Incoming (StashDB)</div>
          <div class="d18-compare-toggle">Use</div>
        </div>
        ${scalarRowsHtml}
        ${perfRowHtml}
        ${tagsRowHtml}
      </div>
      <div class="d18-row" style="margin-top:.75rem;flex-shrink:0">
        <button id="d18-back3"   class="d18-btn d18-btn-secondary">← Back</button>
        <button id="d18-selall"  class="d18-btn d18-btn-secondary">All</button>
        <button id="d18-selnone" class="d18-btn d18-btn-secondary">None</button>
        <button id="d18-apply"   class="d18-btn d18-btn-primary">Apply to Scene</button>
      </div>`;

    document.getElementById("d18-back3").onclick   = () => renderResults(sceneId, scraped, results, query);
    document.getElementById("d18-selall").onclick  = () =>
      document.querySelectorAll(".d18-field-chk,.d18-perf-chk,.d18-tag-chk").forEach(c => c.checked = true);
    document.getElementById("d18-selnone").onclick = () =>
      document.querySelectorAll(".d18-field-chk,.d18-perf-chk,.d18-tag-chk").forEach(c => c.checked = false);

    document.getElementById("d18-apply").onclick = async () => {
      const fieldChecks = {};
      document.querySelectorAll(".d18-field-chk").forEach(cb => { fieldChecks[cb.dataset.field] = cb.checked; });
      const selPerfs = [...document.querySelectorAll(".d18-perf-chk:checked")].map(cb => cb.dataset.name);
      const selTags  = [...document.querySelectorAll(".d18-tag-chk:checked")].map(cb => cb.dataset.name);

      if (!Object.values(fieldChecks).some(Boolean) && !selPerfs.length && !selTags.length) {
        setError("Select at least one field"); return;
      }

      setError("");
      const btn = document.getElementById("d18-apply");
      btn.disabled = true; btn.textContent = "Applying…";
      document.getElementById("d18-status").style.display = "block";
      setStatus("Writing to scene…");

      try {
        await applyToScene(sceneId, match, fieldChecks, selPerfs, selTags,
                           resolvedPerfs, studioMatch, resolvedTags, current);
        setStatus("");
        renderDone(sceneId);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Apply to Scene";
        setStatus("");
      }
    };

    document.querySelectorAll(".d18-perf-create").forEach(btn => {
      btn.addEventListener("click", async () => {
        const name  = btn.dataset.name;
        const row   = btn.closest(".d18-perf-row");
        const msgEl = row?.querySelector(".d18-perf-inline-msg");
        btn.disabled    = true;
        btn.textContent = "Creating…";
        if (msgEl) { msgEl.className = "d18-perf-inline-msg"; msgEl.textContent = ""; }

        try {
          const created = await createPerformerInStash(name);

          const entry = resolvedPerfs.find(p => p.name === name);
          if (entry) { entry.localId = created.id; entry.found = true; }

          const chk   = row?.querySelector(".d18-perf-chk");
          const badge = row?.querySelector(".d18-perf-badge");
          if (chk)   chk.checked    = true;
          if (badge) badge.innerHTML = matchBadge(true);
          btn.style.display = "none";
          if (msgEl) {
            msgEl.className   = "d18-perf-inline-msg d18-msg-ok";
            msgEl.textContent = "✓ Created";
          }
        } catch (e) {
          btn.disabled    = false;
          btn.textContent = "Create in Stash";
          if (msgEl) {
            msgEl.className   = "d18-perf-inline-msg d18-msg-err";
            msgEl.textContent = `✗ ${e.message}`;
          }
        }
      });
    });
  }

  // ── Step 4: Done ───────────────────────────────────────────────────────────

  function renderDone(appliedSceneId) {
    setError(""); setStatus("");
    const sameScene = !appliedSceneId || appliedSceneId === getSceneId();
    getContent().innerHTML = `
      <div class="d18-success">✓ Scene updated! Reloading…</div>`;
    setTimeout(() => {
      if (sameScene) window.location.reload();
      else window.location.href = `/scenes/${appliedSceneId}`;
    }, 1500);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  startListening();

})();
