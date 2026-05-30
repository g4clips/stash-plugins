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
          studio { id name }
          performers { id name }
          tags { id name }
          paths { screenshot }
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
                               resolvedPerfs, studioMatch, resolvedTags) {
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

    await gql(`mutation U($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}`, { input });
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
        <div id="d18-status" style="display:none"></div>
        <div id="d18-content"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("d18-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    renderInput(sceneId);
  }

  // ── Step 1: URL input ──────────────────────────────────────────────────────

  function renderInput(sceneId) {
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
            { mode: "scrape_scene", url }, "Scraping scene + searching StashDB…");
          setStatus("");
          renderResults(sceneId, data.scraped, data.candidates, data.query);
        } catch (e) {
          setError(e.message); btn.disabled = false; btn.textContent = "Go"; setStatus("");
        }
      }
    }

    btn.onclick = go;
    input.addEventListener("keydown", e => e.key === "Enter" && go());
    input.focus();
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
            "Scraping scene + searching StashDB…");
          setStatus("");
          renderResults(sceneId, data.scraped, data.candidates, data.query);
        } catch (e) {
          setError(e.message); setStatus("");
          card.classList.remove("d18-card-loading");
        }
      });
    });
    document.getElementById("d18-back-pick").onclick = () => renderInput(sceneId);
  }

  // ── Step 2: StashDB results ────────────────────────────────────────────────

  function renderResults(sceneId, scraped, results, query) {
    setError("");

    const changeQueryHtml = `
      <div class="d18-row" style="margin-bottom:.5rem">
        <input id="d18-requery-input" class="d18-input" type="text"
               value="${esc(query)}" placeholder="Search query…" />
        <button id="d18-requery-btn" class="d18-btn d18-btn-secondary">Re-search</button>
      </div>`;

    const cards = results.map((r, i) => `
      <div class="d18-result-card" data-idx="${i}">
        ${r.image ? `<img class="d18-result-thumb" src="${esc(r.image)}" alt="">` : `<div class="d18-result-thumb d18-no-img"></div>`}
        <div class="d18-result-info">
          <div class="d18-result-title">${esc(r.title || "(no title)")}</div>
          ${r.studio?.name       ? `<div class="d18-result-sub">${esc(r.studio.name)}</div>` : ""}
          ${r.performers?.length ? `<div class="d18-result-sub">${esc(r.performers.map(p=>p.name).join(", "))}</div>` : ""}
          ${r.date               ? `<div class="d18-result-sub">${esc(r.date)}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      ${changeQueryHtml}
      <p class="d18-hint">${results.length} result${results.length !== 1 ? "s" : ""} — click to select:</p>
      <div class="d18-results">${cards}</div>
      <div class="d18-row" style="margin-top:.5rem">
        <button id="d18-back2" class="d18-btn d18-btn-secondary">← Back</button>
      </div>`;

    // Re-search with custom query
    document.getElementById("d18-requery-btn").onclick = async () => {
      const q = document.getElementById("d18-requery-input").value.trim();
      if (!q) return;
      const btn = document.getElementById("d18-requery-btn");
      btn.disabled = true; btn.textContent = "Searching…";
      setStatus("Searching StashDB…");
      document.getElementById("d18-status").style.display = "block";
      try {
        // Run a search-only task by using scrape_scene with a fake flag
        // Actually: just re-run the full task with the scene URL and the user can edit again
        // Simpler: store scraped and call search directly
        // Since Python does the search, we need to pass a custom query.
        // We handle this by running scrape_scene with query_override arg:
        const data = await runTask("Scrape Data18 Scene",
          { mode: "scrape_scene", url: scraped.url, query_override: q },
          "Searching StashDB…");
        setStatus("");
        renderResults(sceneId, data.scraped || scraped, data.candidates, data.query || q);
      } catch (e) {
        setError(e.message); btn.disabled = false; btn.textContent = "Re-search"; setStatus("");
      }
    };

    document.querySelectorAll(".d18-result-card").forEach(card => {
      card.addEventListener("click", async () => {
        const match = results[+card.dataset.idx];
        setStatus("Resolving against local Stash…");
        document.getElementById("d18-status").style.display = "block";
        try {
          const perfNames = (match.performers || []).map(p => p.name);
          const tagNames  = (match.tags || []).map(t => t.name);
          const [current, resolvedPerfs, resolvedStudio, resolvedTags] = await Promise.all([
            fetchCurrentScene(sceneId),
            resolveLocally("performer", perfNames),
            resolveLocally("studio", match.studio?.name ? [match.studio.name] : []),
            resolveLocally("tag", tagNames),
          ]);
          setStatus("");
          renderApply(sceneId, current, match, scraped, results, query,
                      resolvedPerfs, resolvedStudio[0] || null, resolvedTags);
        } catch(e) {
          setError(e.message); setStatus("");
        }
      });
    });

    document.getElementById("d18-back2").onclick = () => renderInput(sceneId);
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
            <label class="d18-item-label">
              <input type="checkbox" class="d18-perf-chk" data-name="${esc(p.name)}" ${p.found ? "checked" : ""} />
              <span>${esc(p.name)} ${matchBadge(p.found)}</span>
            </label>`).join("")}
        </div>
        <div class="d18-compare-toggle">
          <input type="checkbox" class="d18-field-chk" data-field="performers" checked />
        </div>
      </div>` : "";

    const tagsRowHtml = resolvedTags.length ? `
      <div class="d18-compare-row">
        <div class="d18-compare-label">Tags</div>
        <div class="d18-compare-current">${esc(currentTags.join(", ") || "—")}</div>
        <div class="d18-compare-incoming">
          ${resolvedTags.map(t => `
            <label class="d18-item-label">
              <input type="checkbox" class="d18-tag-chk" data-name="${esc(t.name)}" ${t.found ? "checked" : ""} />
              <span>${esc(t.name)} ${matchBadge(t.found)}</span>
            </label>`).join("")}
        </div>
        <div class="d18-compare-toggle">
          <input type="checkbox" class="d18-field-chk" data-field="tags" checked />
        </div>
      </div>` : "";

    const scalarFields = [
      ["title",   "Title",       current.title,                  match.title],
      ["date",    "Date",        current.date,                   match.date],
      ["details", "Description", current.details,                match.details],
      ["studio",  "Studio",      current.studio?.name,
        studioMatch ? `${esc(studioMatch.name)} ${matchBadge(studioMatch.found)}` : null],
      ["urls",    "URLs",        (current.urls||[]).join(", "),  (match.urls||[]).join(", ")],
      ["image",   "Cover Image", current.paths?.screenshot ? "Current image" : "—",
        match.image ? "StashDB image" : null],
    ].filter(([,,,inc]) => inc);

    const scalarRowsHtml = scalarFields.map(([field, label, cur, inc]) => `
      <div class="d18-compare-row">
        <div class="d18-compare-label">${esc(label)}</div>
        <div class="d18-compare-current ${field === "details" ? "d18-trunc" : ""}">${esc(cur || "—")}</div>
        <div class="d18-compare-incoming ${field === "details" ? "d18-trunc" : ""}">${inc}</div>
        <div class="d18-compare-toggle">
          <input type="checkbox" class="d18-field-chk" data-field="${field}" checked />
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
                           resolvedPerfs, studioMatch, resolvedTags);
        setStatus("");
        renderDone();
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Apply to Scene";
        setStatus("");
      }
    };
  }

  // ── Step 4: Done ───────────────────────────────────────────────────────────

  function renderDone() {
    setError(""); setStatus("");
    getContent().innerHTML = `
      <div class="d18-success">✓ Scene updated! Reload the page to see changes.</div>
      <div class="d18-row" style="margin-top:.75rem">
        <button id="d18-reload" class="d18-btn d18-btn-primary">Reload Page</button>
        <button id="d18-again"  class="d18-btn d18-btn-secondary">Scrape Another</button>
      </div>`;
    document.getElementById("d18-reload").onclick = () => window.location.reload();
    document.getElementById("d18-again").onclick  = () => renderInput(getSceneId());
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  startListening();

})();
