// Data18StashDB Plugin v1.2
// Scrapes Data18 directly via Stash's server-side scrapeURL proxy (avoids CORS),
// then searches StashDB and applies metadata back to the scene.
// No Python task polling needed.

(function () {
  "use strict";

  const BTN_ID   = "d18-open-btn";
  const MODAL_ID = "d18-modal-overlay";

  // ── Utilities ──────────────────────────────────────────────────────────────

  function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
  function getSceneId()   { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage()  { return !!getSceneId(); }
  function getModal()     { return document.getElementById(MODAL_ID); }
  function getContent()   { return document.getElementById("d18-content"); }

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
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // ── GraphQL helper (calls local Stash) ─────────────────────────────────────

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

  // ── Scrape Data18 via Stash's server-side scrapeURL proxy ─────────────────
  // This uses Stash's own HTTP client to fetch Data18, bypassing browser CORS.
  // Stash parses the raw HTML and returns what it can via the generic scraper.

  async function scrapeData18(url) {
    setStatus("Fetching Data18 page…");

    // scrapeURL with ty: SCENE asks Stash to fetch + parse the URL as a scene.
    // Even without a registered scraper for data18, Stash returns raw HTML
    // which we parse client-side using a DOMParser.
    // We use two approaches in sequence:
    //   1. scrapeURL (if a data18 scraper is installed)
    //   2. fetch via Stash's /scrape/html proxy (internal endpoint)

    // First try the GraphQL scrapeURL approach
    try {
      const data = await gql(`
        query ScrapeURL($url: String!) {
          scrapeURL(url: $url, ty: SCENE) {
            ... on ScrapedScene {
              title date details urls
              studio { name }
              performers { name }
              image
            }
          }
        }
      `, { url });

      const s = data.scrapeURL;
      if (s && s.title) {
        return {
          url,
          title:       s.title || "",
          date:        s.date  || "",
          description: s.details || "",
          studio:      s.studio?.name || "",
          performers:  (s.performers || []).map(p => p.name),
          image:       s.image || "",
        };
      }
    } catch (_) {
      // scrapeURL not available or no scraper configured — fall through
    }

    // Fallback: fetch the raw HTML via the Stash proxy endpoint
    // Stash exposes GET /scrape/html?url=<encoded> for internal use
    setStatus("Fetching via Stash proxy…");

    const proxyResp = await fetch(`/scrape/html?url=${encodeURIComponent(url)}`, {
      credentials: "include",
    });

    if (!proxyResp.ok) {
      throw new Error(`Could not fetch Data18 page (HTTP ${proxyResp.status}). ` +
        `Try installing the data18 scraper from the community scrapers list first.`);
    }

    const html = await proxyResp.text();
    return parseData18HTML(html, url);
  }

  // ── Parse Data18 HTML client-side ─────────────────────────────────────────

  function parseData18HTML(html, url) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const result = { url };

    // Title: <h1 itemprop="name"> or page <title> minus "| DATA18"
    const h1 = doc.querySelector("h1[itemprop='name'], h1");
    if (h1) {
      result.title = h1.textContent.trim();
    } else {
      const pt = doc.title || "";
      result.title = pt.replace(/\s*[|\-–]\s*DATA18.*/i, "").trim();
    }

    // Performers: <span itemprop="actor">
    const performers = [];
    const seen = new Set();
    doc.querySelectorAll("span[itemprop='actor']").forEach(tag => {
      const ns = tag.querySelector("[itemprop='name']");
      const name = (ns || tag).textContent.trim();
      if (name && !seen.has(name)) { seen.add(name); performers.push(name); }
    });
    // Fallback: links to /name/
    if (!performers.length) {
      doc.querySelectorAll("a[href*='/name/']").forEach(a => {
        const name = a.textContent.trim();
        if (name && !seen.has(name)) { seen.add(name); performers.push(name); }
      });
    }
    result.performers = performers;

    // Studio: <span itemprop="productionCompany"> or label + link
    const studioTag = doc.querySelector("span[itemprop='productionCompany'], a[itemprop='productionCompany']");
    if (studioTag) {
      result.studio = studioTag.textContent.trim();
    } else {
      const labels = doc.querySelectorAll("b, strong");
      for (const b of labels) {
        if (/studio|network/i.test(b.textContent)) {
          const a = b.nextElementSibling?.tagName === "A" ? b.nextElementSibling
                  : b.parentElement?.querySelector("a");
          if (a) { result.studio = a.textContent.trim(); break; }
        }
      }
    }

    // Date: <* itemprop="datePublished"> or content attr
    const dateMeta = doc.querySelector("[itemprop='datePublished']");
    if (dateMeta) {
      result.date = (dateMeta.getAttribute("content") || dateMeta.textContent).trim().slice(0, 10);
    }

    // Description: <* itemprop="description">
    const desc = doc.querySelector("[itemprop='description']");
    if (desc) {
      result.description = desc.textContent.replace(/\s+/g, " ").trim();
    }

    // Image: <img itemprop="image">
    const img = doc.querySelector("img[itemprop='image'], #player-wrap img, .player img");
    if (img) {
      const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
      result.image = src.startsWith("http") ? src : src ? `https:${src}` : "";
    }

    return result;
  }

  // ── Search StashDB ─────────────────────────────────────────────────────────

  async function searchStashDB(query) {
    setStatus("Searching StashDB…");
    const data = await gql(`
      query Search($q: String!) {
        scrapeMultiScenes(source: {stash_box_index: 0}, input: {query: $q}) {
          title date details urls
          studio { name }
          performers { name }
          tags { name }
          image
          remote_site_id
        }
      }
    `, { q: query });
    return data.scrapeMultiScenes || [];
  }

  // ── Apply metadata to scene ────────────────────────────────────────────────

  async function applyToScene(sceneId, match, fields) {
    setStatus("Applying metadata…");
    const input = { id: sceneId };

    if (fields.title   && match.title)   input.title   = match.title;
    if (fields.date    && match.date)    input.date    = match.date;
    if (fields.details && match.details) input.details = match.details;
    if (fields.image   && match.image)   input.cover_image = match.image;

    if (fields.studio && match.studio?.name) {
      const sd = await gql(
        `query F($q:String){findStudios(filter:{q:$q,per_page:1}){studios{id}}}`,
        { q: match.studio.name }
      );
      if (sd.findStudios.studios.length) input.studio_id = sd.findStudios.studios[0].id;
    }

    if (fields.performers && match.performers?.length) {
      const ids = [];
      for (const p of match.performers) {
        const pd = await gql(
          `query F($q:String){findPerformers(filter:{q:$q,per_page:5}){performers{id name}}}`,
          { q: p.name }
        );
        const found = pd.findPerformers.performers
          .find(x => x.name.toLowerCase() === p.name.toLowerCase());
        if (found) ids.push(found.id);
      }
      if (ids.length) input.performer_ids = ids;
    }

    if (fields.tags && match.tags?.length) {
      const ids = [];
      for (const t of match.tags) {
        const td = await gql(
          `query F($q:String){findTags(filter:{q:$q,per_page:5}){tags{id name}}}`,
          { q: t.name }
        );
        const found = td.findTags.tags
          .find(x => x.name.toLowerCase() === t.name.toLowerCase());
        if (found) ids.push(found.id);
      }
      if (ids.length) input.tag_ids = ids;
    }

    await gql(
      `mutation U($i:SceneUpdateInput!){sceneUpdate(input:$i){id}}`,
      { i: input }
    );
  }

  // ── Button injection ───────────────────────────────────────────────────────

  function injectButton() {
    if (!isScenePage() || document.getElementById(BTN_ID)) return;

    const tryInsert = () => {
      // Target the scene detail header area — works across Stash versions
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
      // Element not ready yet — wait for it
      const deadline = Date.now() + 15000;
      const obs = new MutationObserver(() => {
        if (tryInsert() || Date.now() > deadline) obs.disconnect();
      });
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
        if (window.location.pathname !== last) {
          last = window.location.pathname;
          onLocationChange();
        }
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
      <p class="d18-hint">Paste a <strong>data18.com/scenes/</strong> URL to scrape and match against StashDB.</p>
      <div class="d18-row">
        <input id="d18-url" class="d18-input" type="url"
               placeholder="https://www.data18.com/scenes/1256472" />
        <button id="d18-go" class="d18-btn d18-btn-primary">Scrape</button>
      </div>`;

    const input = document.getElementById("d18-url");
    const btn   = document.getElementById("d18-go");

    async function go() {
      const url = input.value.trim();
      if (!url.includes("data18.com/scenes/")) {
        setError("Please enter a data18.com/scenes/ URL"); return;
      }
      setError("");
      btn.disabled = true; btn.textContent = "Scraping…";
      try {
        const scraped = await scrapeData18(url);
        setStatus("");
        renderQuery(sceneId, scraped);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Scrape";
        setStatus("");
      }
    }

    btn.onclick = go;
    input.addEventListener("keydown", e => e.key === "Enter" && go());
    input.focus();
  }

  // ── Step 2: Query builder ──────────────────────────────────────────────────

  function renderQuery(sceneId, scraped) {
    setError("");
    const perfs = scraped.performers || [];
    const parts = [...perfs.slice(0, 2)];
    if (scraped.studio) parts.push(scraped.studio.split(" ")[0]);
    const initial = parts.join(" ") || scraped.title || "";

    const pillsHtml = [
      ...perfs.map(p  => `<span class="d18-pill d18-pill-performer" data-w="${esc(p)}">${esc(p)}</span>`),
      scraped.studio ? `<span class="d18-pill d18-pill-studio" data-w="${esc(scraped.studio)}">${esc(scraped.studio)}</span>` : "",
      scraped.title  ? `<span class="d18-pill d18-pill-title"  data-w="${esc(scraped.title)}">${esc(scraped.title)}</span>`   : "",
    ].join("");

    getContent().innerHTML = `
      <div class="d18-preview">
        ${scraped.image ? `<img class="d18-thumb" src="${esc(scraped.image)}" alt="">` : ""}
        <div class="d18-preview-meta">
          ${scraped.title  ? `<div><strong>Title:</strong> ${esc(scraped.title)}</div>` : ""}
          ${scraped.studio ? `<div><strong>Studio:</strong> ${esc(scraped.studio)}</div>` : ""}
          ${perfs.length   ? `<div><strong>Performers:</strong> ${esc(perfs.join(", "))}</div>` : ""}
          ${scraped.date   ? `<div><strong>Date:</strong> ${esc(scraped.date)}</div>` : ""}
        </div>
      </div>
      <p class="d18-hint" style="margin-top:.6rem">Click tokens to toggle in/out of query, or type freely:</p>
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
        parts = allIn
          ? parts.filter(p => !words.includes(p))
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
      try {
        const results = await searchStashDB(q);
        setStatus("");
        if (!results.length) {
          setError("No results — try a different query");
          btn.disabled = false; btn.textContent = "Search StashDB";
          return;
        }
        renderResults(sceneId, scraped, results);
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Search StashDB";
        setStatus("");
      }
    }

    document.getElementById("d18-search").onclick = search;
    qEl.addEventListener("keydown", e => e.key === "Enter" && search());
    document.getElementById("d18-back1").onclick = () => renderInput(sceneId);
  }

  // ── Step 3: Results ────────────────────────────────────────────────────────

  function renderResults(sceneId, scraped, results) {
    setError("");
    const cards = results.map((r, i) => `
      <div class="d18-result-card" data-idx="${i}">
        ${r.image
          ? `<img class="d18-result-thumb" src="${esc(r.image)}" alt="">`
          : `<div class="d18-result-thumb d18-no-img"></div>`}
        <div class="d18-result-info">
          <div class="d18-result-title">${esc(r.title || "(no title)")}</div>
          ${r.studio?.name ? `<div class="d18-result-sub">${esc(r.studio.name)}</div>` : ""}
          ${r.performers?.length ? `<div class="d18-result-sub">${esc(r.performers.map(p=>p.name).join(", "))}</div>` : ""}
          ${r.date ? `<div class="d18-result-sub">${esc(r.date)}</div>` : ""}
        </div>
      </div>`).join("");

    getContent().innerHTML = `
      <p class="d18-hint">${results.length} result${results.length !== 1 ? "s" : ""} — click to select:</p>
      <div class="d18-results">${cards}</div>
      <div class="d18-row" style="margin-top:.5rem">
        <button id="d18-back2"   class="d18-btn d18-btn-secondary">← Back</button>
        <button id="d18-requery" class="d18-btn d18-btn-secondary">Change query</button>
      </div>`;

    document.querySelectorAll(".d18-result-card").forEach(card => {
      card.addEventListener("click", () => renderApply(sceneId, results[+card.dataset.idx]));
    });
    document.getElementById("d18-back2").onclick   = () => renderQuery(sceneId, scraped);
    document.getElementById("d18-requery").onclick = () => renderQuery(sceneId, scraped);
  }

  // ── Step 4: Apply ──────────────────────────────────────────────────────────

  function renderApply(sceneId, match) {
    setError("");
    const fieldDefs = [
      ["title",      "Title",       match.title],
      ["date",       "Date",        match.date],
      ["details",    "Description", match.details],
      ["studio",     "Studio",      match.studio?.name],
      ["performers", "Performers",  match.performers?.map(p=>p.name).join(", ")],
      ["tags",       "Tags",        match.tags?.map(t=>t.name).join(", ")],
      ["image",      "Cover Image", match.image ? "(yes)" : null],
    ].filter(([,,v]) => v);

    getContent().innerHTML = `
      <div class="d18-preview">
        ${match.image ? `<img class="d18-thumb" src="${esc(match.image)}" alt="">` : ""}
        <div class="d18-preview-meta">
          ${match.title ? `<div><strong>${esc(match.title)}</strong></div>` : ""}
          ${match.studio?.name ? `<div>${esc(match.studio.name)}</div>` : ""}
          ${match.performers?.length ? `<div>${esc(match.performers.map(p=>p.name).join(", "))}</div>` : ""}
          ${match.date ? `<div>${esc(match.date)}</div>` : ""}
        </div>
      </div>
      <p class="d18-hint" style="margin-top:.6rem">Choose fields to apply:</p>
      <div class="d18-field-checks">
        ${fieldDefs.map(([k,l,v]) => `
          <label class="d18-check-label">
            <input type="checkbox" class="d18-chk" data-field="${k}" checked />
            <span><strong>${l}:</strong> <span class="d18-field-val">${esc(String(v))}</span></span>
          </label>`).join("")}
      </div>
      <div class="d18-row" style="margin-top:.75rem">
        <button id="d18-back3"  class="d18-btn d18-btn-secondary">← Back</button>
        <button id="d18-apply"  class="d18-btn d18-btn-primary">Apply to Scene</button>
      </div>`;

    document.getElementById("d18-back3").onclick = () => renderResults(sceneId, null, [match]);

    document.getElementById("d18-apply").onclick = async () => {
      const checked = {};
      document.querySelectorAll(".d18-chk").forEach(cb => { checked[cb.dataset.field] = cb.checked; });
      if (!Object.values(checked).some(Boolean)) { setError("Select at least one field"); return; }
      setError("");
      const btn = document.getElementById("d18-apply");
      btn.disabled = true; btn.textContent = "Applying…";
      setStatus("Writing to scene…");
      try {
        await applyToScene(sceneId, match, checked);
        setStatus(""); renderDone();
      } catch (e) {
        setError(e.message);
        btn.disabled = false; btn.textContent = "Apply to Scene";
        setStatus("");
      }
    };
  }

  // ── Step 5: Done ──────────────────────────────────────────────────────────

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
