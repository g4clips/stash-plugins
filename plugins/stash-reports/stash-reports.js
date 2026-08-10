// Stash Reports
// Adds a "Reports" entry under Settings > Tools that opens a full-screen
// panel with library-wide codec reports:
//   - summary cards + Firefox-compatibility callout (h264/aac by default,
//     configurable in Settings -> Plugins -> Stash Reports)
//   - breakdown table by video+audio codec pair (and by video / audio alone)
//   - drill-down scene list for any codec pair, or for "everything that
//     isn't the optimal pair"
//   - CSV export and a bulk "tag as needs-transcode" action on the
//     drill-down list
//
// Status: scaffolded, NOT yet run against a live Stash instance. See
// README.md's verification checklist before trusting this in prod — in
// particular the VideoFile field names and the findScenes filter shape
// should be confirmed via GraphQL introspection on your instance first.
//
// Architecture notes (why things are done this way) live in README.md.
// UI conventions follow stash-plugin-ui-patterns-2026-07-15.md and the
// hardcoded dark-theme tokens from stash-plugin-dev-notes-2026-07-15-v2.md
// #13 (Stash CSS vars don't resolve on plain DOM-injected elements).

(function () {
  const PLUGIN_ID = "stash-reports";
  const RESULT_TAG_NAME = "zzz-needs-transcode";
  const PAGE_SIZE = 500;

  // ---------------------------------------------------------------------
  // GraphQL helper
  // ---------------------------------------------------------------------
  async function gql(query, variables) {
    const resp = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const json = await resp.json();
    if (json.errors) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  // ---------------------------------------------------------------------
  // Config (Settings -> Plugins -> Stash Reports)
  // ---------------------------------------------------------------------
  async function getTargetCodecs() {
    const fallback = { video: "h264", audio: "aac" };
    try {
      const data = await gql(`query { configuration { plugins } }`);
      const cfg = (data.configuration.plugins || {})[PLUGIN_ID] || {};
      return {
        video: String(cfg.targetVideoCodec || fallback.video).toLowerCase().trim(),
        audio: String(cfg.targetAudioCodec || fallback.audio).toLowerCase().trim(),
      };
    } catch (e) {
      console.warn("[stash-reports] falling back to default target codecs:", e);
      return fallback;
    }
  }

  // ---------------------------------------------------------------------
  // Data fetch — paginate the whole scene library once per report run
  // ---------------------------------------------------------------------
  const FIND_SCENES_QUERY = `
    query StashReportsFindScenes($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id
          title
          date
          studio { id name }
          tags { id name }
          paths { screenshot }
          files {
            id
            size
            duration
            format
            video_codec
            audio_codec
            width
            height
          }
        }
      }
    }
  `;

  async function fetchAllScenes(onProgress) {
    let page = 1;
    let count = null;
    const scenes = [];
    // Safety cap so a schema surprise (e.g. count never satisfied) can't
    // spin forever — 400 pages * 500/page = 200k scenes, well past any
    // real personal library.
    for (let guard = 0; guard < 400; guard++) {
      const data = await gql(FIND_SCENES_QUERY, {
        filter: { page, per_page: PAGE_SIZE, sort: "id", direction: "ASC" },
      });
      const res = data.findScenes;
      count = res.count;
      scenes.push(...res.scenes);
      if (onProgress) onProgress(scenes.length, count);
      if (res.scenes.length === 0 || scenes.length >= count) break;
      page += 1;
    }
    return scenes;
  }

  // ---------------------------------------------------------------------
  // Normalization / aggregation
  // ---------------------------------------------------------------------
  // A scene can have more than one file (e.g. an original + a proxy).
  // We treat files[0] as "the" file for report purposes — same assumption
  // Stash's own UI makes when it shows "the" resolution/codec badge on a
  // scene card.
  function primaryFile(scene) {
    return (scene.files && scene.files[0]) || null;
  }

  function codecOf(scene) {
    const f = primaryFile(scene);
    const video = (f && f.video_codec ? f.video_codec : "").toLowerCase().trim() || "(none)";
    const audio = (f && f.audio_codec ? f.audio_codec : "").toLowerCase().trim() || "(none)";
    return { video, audio, pairKey: `${video} / ${audio}`, hasFile: !!f };
  }

  function isOptimal(scene, target) {
    const { video, audio, hasFile } = codecOf(scene);
    return hasFile && video === target.video && audio === target.audio;
  }

  function bump(map, key, size, duration) {
    const cur = map.get(key) || { key, count: 0, size: 0, duration: 0 };
    cur.count += 1;
    cur.size += size;
    cur.duration += duration;
    map.set(key, cur);
  }

  function buildReport(scenes, target) {
    const byPair = new Map();
    const byVideo = new Map();
    const byAudio = new Map();
    const byFormat = new Map();
    let totalSize = 0;
    let totalDuration = 0;
    let optimalCount = 0;
    let filelessCount = 0;

    for (const scene of scenes) {
      const f = primaryFile(scene);
      const size = f ? Number(f.size) || 0 : 0;
      const duration = f ? Number(f.duration) || 0 : 0;
      totalSize += size;
      totalDuration += duration;

      const { video, audio, pairKey, hasFile } = codecOf(scene);
      if (!hasFile) filelessCount++;
      if (isOptimal(scene, target)) optimalCount++;

      bump(byPair, pairKey, size, duration);
      bump(byVideo, video, size, duration);
      bump(byAudio, audio, size, duration);
      bump(byFormat, (f && f.format) || "(none)", size, duration);
    }

    return {
      byPair,
      byVideo,
      byAudio,
      byFormat,
      totalSize,
      totalDuration,
      optimalCount,
      filelessCount,
      total: scenes.length,
    };
  }

  // ---------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------
  function fmtBytes(n) {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDuration(seconds) {
    if (!seconds) return "0m";
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtPct(n, total) {
    if (!total) return "0%";
    return `${((n / total) * 100).toFixed(1)}%`;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------
  function downloadCsv(filename, headers, rows) {
    const escCsv = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.map(escCsv).join(",")];
    for (const row of rows) lines.push(row.map(escCsv).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------
  // Tag-scenes-as-needs-transcode (find-or-create tag, merge into each
  // selected scene's existing tag_ids — never replaces other tags).
  // ---------------------------------------------------------------------
  async function findOrCreateTag(name) {
    const found = await gql(
      `query($name: String!) {
        findTags(tag_filter: { name: { value: $name, modifier: EQUALS } }, filter: { per_page: 1 }) {
          tags { id name }
        }
      }`,
      { name }
    );
    const existing = (found.findTags.tags || [])[0];
    if (existing) return existing.id;

    const created = await gql(
      `mutation($input: TagCreateInput!) { tagCreate(input: $input) { id } }`,
      { input: { name } }
    );
    return created.tagCreate.id;
  }

  async function tagScenes(scenes, tagName, onProgress) {
    const tagId = await findOrCreateTag(tagName);
    let done = 0;
    for (const scene of scenes) {
      const existingTagIds = (scene.tags || []).map((t) => t.id);
      if (!existingTagIds.includes(tagId)) {
        await gql(
          `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
          { input: { id: scene.id, tag_ids: [...existingTagIds, tagId] } }
        );
        // keep local cache in sync so re-renders reflect the new tag
        scene.tags = [...(scene.tags || []), { id: tagId, name: tagName }];
      }
      done++;
      if (onProgress) onProgress(done, scenes.length);
    }
  }

  // ---------------------------------------------------------------------
  // Modal skeleton (plain-DOM — trigger is a DOM-injected button with no
  // React context, see dev-notes-2026-07-19 #3)
  // ---------------------------------------------------------------------
  const state = {
    scenes: null,
    target: { video: "h264", audio: "aac" },
    report: null,
    view: "loading", // loading | overview | list
    listFilter: null, // { title, subtitle, predicate(scene) => bool }
    selected: new Set(),
    sort: { field: "title", dir: "asc" },
    loadedCount: 0,
    loadedTotal: null,
  };

  function ensureModal() {
    if (document.getElementById("sr-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "sr-modal-overlay";
    overlay.innerHTML = `
      <div id="sr-box">
        <div id="sr-header">
          <div class="sr-title">📊 Stash Reports</div>
          <div class="sr-actions">
            <button id="sr-refresh-btn" class="sr-btn-back" type="button" title="Re-scan the library">⟳ Refresh</button>
            <button id="sr-close-btn" type="button" aria-label="Close">✕</button>
          </div>
        </div>
        <div id="sr-status"></div>
        <div id="sr-error"></div>
        <div id="sr-content"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.getElementById("sr-close-btn").addEventListener("click", closeModal);
    document.getElementById("sr-refresh-btn").addEventListener("click", () => loadData());
    document.addEventListener("keydown", onEscKey);
  }

  function onEscKey(e) {
    if (e.key === "Escape" && document.getElementById("sr-modal-overlay")) closeModal();
  }

  function closeModal() {
    const overlay = document.getElementById("sr-modal-overlay");
    if (overlay) overlay.remove();
    document.removeEventListener("keydown", onEscKey);
  }

  function getContent() {
    return document.getElementById("sr-content");
  }
  function setStatus(msg) {
    const el = document.getElementById("sr-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }
  function setError(msg) {
    const el = document.getElementById("sr-error");
    if (!el) return;
    el.textContent = msg ? `⚠ ${msg}` : "";
    el.style.display = msg ? "block" : "none";
  }

  async function openModal() {
    ensureModal();
    render();
    if (!state.scenes) {
      await loadData();
    } else {
      state.view = "overview";
      render();
    }
  }

  async function loadData() {
    state.view = "loading";
    state.loadedCount = 0;
    state.loadedTotal = null;
    setError("");
    render();
    try {
      state.target = await getTargetCodecs();
      state.scenes = await fetchAllScenes((loaded, total) => {
        state.loadedCount = loaded;
        state.loadedTotal = total;
        setStatus(`Scanning library… ${loaded.toLocaleString()} / ${total.toLocaleString()} scenes`);
      });
      state.report = buildReport(state.scenes, state.target);
      setStatus("");
      state.view = "overview";
      state.listFilter = null;
      state.selected = new Set();
    } catch (e) {
      console.error("[stash-reports] load failed:", e);
      setError(e.message || String(e));
      state.view = "overview";
    }
    render();
  }

  // ---------------------------------------------------------------------
  // Render — top level dispatch
  // ---------------------------------------------------------------------
  function render() {
    const content = getContent();
    if (!content) return;
    if (state.view === "loading") {
      content.innerHTML = `
        <div class="sr-loading-wrap">
          <div class="sr-spinner"></div>
          <div>Loading scene library…</div>
        </div>`;
      return;
    }
    if (state.view === "list") {
      renderList();
      return;
    }
    renderOverview();
  }

  // ---------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------
  function goToList(title, subtitle, predicate) {
    state.listFilter = { title, subtitle, predicate };
    state.view = "list";
    state.selected = new Set();
    state.sort = { field: "title", dir: "asc" };
    render();
  }

  function renderOverview() {
    const content = getContent();
    if (!state.scenes) {
      content.innerHTML = `<div class="sr-empty">No data loaded yet.</div>`;
      return;
    }
    const r = state.report;
    const target = state.target;
    const nonOptimal = r.total - r.optimalCount;

    const cardsHtml = `
      <div class="sr-cards">
        <div class="sr-card">
          <div class="sr-card-label">Total scenes</div>
          <div class="sr-card-value">${r.total.toLocaleString()}</div>
        </div>
        <div class="sr-card">
          <div class="sr-card-label">Total size</div>
          <div class="sr-card-value">${fmtBytes(r.totalSize)}</div>
        </div>
        <div class="sr-card">
          <div class="sr-card-label">Total duration</div>
          <div class="sr-card-value">${fmtDuration(r.totalDuration)}</div>
        </div>
        <div class="sr-card sr-card-good">
          <div class="sr-card-label">${esc(target.video)}/${esc(target.audio)} scenes</div>
          <div class="sr-card-value">${r.optimalCount.toLocaleString()}</div>
        </div>
        <div class="sr-card sr-card-bad">
          <div class="sr-card-label">Not optimal</div>
          <div class="sr-card-value">${nonOptimal.toLocaleString()}</div>
        </div>
      </div>
    `;

    const compatHtml = `
      <div class="sr-compat-box">
        <div class="sr-compat-text">
          <strong>Firefox-optimal target:</strong> ${esc(target.video)} video + ${esc(target.audio)} audio
          <span style="color:#888"> (change in Settings → Plugins → Stash Reports)</span>
        </div>
        <div class="sr-compat-bar">
          <div class="sr-compat-bar-good" style="width:${r.total ? (r.optimalCount / r.total) * 100 : 0}%"></div>
        </div>
        <div class="sr-compat-row">
          <div class="sr-compat-text">
            <strong>${fmtPct(r.optimalCount, r.total)}</strong> optimal &nbsp;·&nbsp;
            <strong>${fmtPct(nonOptimal, r.total)}</strong> not optimal
            ${r.filelessCount ? ` &nbsp;·&nbsp; ${r.filelessCount} fileless (virtual) scene(s) excluded from the count below` : ""}
          </div>
          <button id="sr-view-nonoptimal" class="sr-btn-back" type="button">View non-optimal scenes →</button>
        </div>
      </div>
    `;

    const pairRows = [...r.byPair.values()].sort((a, b) => b.count - a.count);
    const pairTable = renderBreakdownTable(pairRows, "Video / Audio codec", "pair");

    const videoRows = [...r.byVideo.values()].sort((a, b) => b.count - a.count);
    const videoTable = renderBreakdownTable(videoRows, "Video codec", "video");

    const audioRows = [...r.byAudio.values()].sort((a, b) => b.count - a.count);
    const audioTable = renderBreakdownTable(audioRows, "Audio codec", "audio");

    const formatRows = [...r.byFormat.values()].sort((a, b) => b.count - a.count);
    const formatTable = renderBreakdownTable(formatRows, "Container format", "format");

    content.innerHTML = `
      ${cardsHtml}
      ${compatHtml}
      <div class="sr-section-title">
        <span>By video + audio codec</span>
        <button id="sr-export-pairs" class="sr-btn-back" type="button">Export CSV</button>
      </div>
      ${pairTable}

      <details class="sr-collapsible">
        <summary>By video codec only</summary>
        ${videoTable}
      </details>
      <details class="sr-collapsible">
        <summary>By audio codec only</summary>
        ${audioTable}
      </details>
      <details class="sr-collapsible">
        <summary>By container format</summary>
        ${formatTable}
      </details>
    `;

    document.getElementById("sr-view-nonoptimal").addEventListener("click", () => {
      goToList(
        `Not ${target.video}/${target.audio}`,
        "Scenes that won't necessarily direct-play cleanly in Firefox",
        (s) => !isOptimal(s, target) && codecOf(s).hasFile
      );
    });

    document.getElementById("sr-export-pairs").addEventListener("click", () => {
      downloadCsv(
        "stash-reports-codec-pairs.csv",
        ["video_codec", "audio_codec", "scenes", "total_size_bytes", "total_duration_seconds"],
        pairRows.map((row) => {
          const [video, audio] = row.key.split(" / ");
          return [video, audio, row.count, row.size, Math.round(row.duration)];
        })
      );
    });

    // Single delegated click handler for every breakdown table on this
    // screen — each clickable row carries data-kind + data-key, decoded
    // back into a filter predicate here rather than juggling per-row
    // closures across an innerHTML swap.
    content.querySelectorAll("tr.sr-row-clickable").forEach((tr) => {
      tr.addEventListener("click", () => {
        const kind = tr.dataset.kind;
        const key = tr.dataset.key;
        const count = Number(tr.dataset.count);
        const subtitle = `${count.toLocaleString()} scene(s)`;
        if (kind === "pair") {
          const [video, audio] = key.split(" / ");
          goToList(key, subtitle, (s) => codecOf(s).video === video && codecOf(s).audio === audio);
        } else if (kind === "video") {
          goToList(`Video codec: ${key}`, subtitle, (s) => codecOf(s).video === key);
        } else if (kind === "audio") {
          goToList(`Audio codec: ${key}`, subtitle, (s) => codecOf(s).audio === key);
        } else if (kind === "format") {
          goToList(`Container: ${key}`, subtitle, (s) => ((primaryFile(s) || {}).format || "(none)") === key);
        }
      });
    });
  }

  function renderBreakdownTable(rows, keyLabel, kind) {
    if (!rows.length) return `<div class="sr-empty">No scenes.</div>`;
    const totalScenes = rows.reduce((sum, r) => sum + r.count, 0);
    const body = rows
      .map(
        (row) => `
      <tr data-kind="${esc(kind)}" data-key="${esc(row.key)}" data-count="${row.count}" class="sr-row-clickable">
        <td>${esc(row.key)}</td>
        <td class="sr-num">${row.count.toLocaleString()}</td>
        <td class="sr-num">${fmtPct(row.count, totalScenes)}</td>
        <td class="sr-num">${fmtBytes(row.size)}</td>
        <td class="sr-num">${fmtDuration(row.duration)}</td>
        <td><span class="sr-link">View scenes →</span></td>
      </tr>`
      )
      .join("");
    return `
      <div class="sr-table-wrap">
        <table class="sr-table">
          <thead>
            <tr>
              <th>${esc(keyLabel)}</th>
              <th>Scenes</th>
              <th>% of total</th>
              <th>Size</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Drill-down scene list
  // ---------------------------------------------------------------------
  function renderList() {
    const content = getContent();
    const filter = state.listFilter;
    const rows = state.scenes.filter(filter.predicate);

    const sortedRows = sortScenes(rows, state.sort);

    const toolbar = `
      <div class="sr-list-toolbar">
        <div class="sr-left">
          <button id="sr-back-btn" class="sr-btn-back" type="button">← Back to overview</button>
          <div>
            <div class="sr-list-title">${esc(filter.title)}</div>
            <div class="sr-list-sub">${esc(filter.subtitle || "")} — ${rows.length.toLocaleString()} scene(s)</div>
          </div>
        </div>
        <div class="sr-right">
          <button id="sr-export-list" class="sr-btn-back" type="button">Export CSV</button>
          <button id="sr-tag-selected" class="sr-btn-back" type="button">Tag selected as "${esc(RESULT_TAG_NAME)}"</button>
          <span id="sr-tag-msg"></span>
        </div>
      </div>
    `;

    if (!rows.length) {
      content.innerHTML = toolbar + `<div class="sr-empty">No scenes match this filter.</div>`;
      wireListToolbar(rows);
      return;
    }

    const cols = [
      { key: "select", label: "", sortable: false },
      { key: "thumb", label: "", sortable: false },
      { key: "title", label: "Title", sortable: true },
      { key: "studio", label: "Studio", sortable: true },
      { key: "date", label: "Date", sortable: true },
      { key: "resolution", label: "Resolution", sortable: true },
      { key: "video_codec", label: "Video", sortable: true },
      { key: "audio_codec", label: "Audio", sortable: true },
      { key: "format", label: "Container", sortable: true },
      { key: "duration", label: "Duration", sortable: true },
      { key: "size", label: "Size", sortable: true },
    ];

    const headHtml = cols
      .map((c) => {
        if (c.key === "select") return `<th><input type="checkbox" id="sr-select-all"></th>`;
        if (!c.sortable) return `<th>${c.label}</th>`;
        const arrow = state.sort.field === c.key ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "";
        return `<th data-sort-field="${c.key}">${esc(c.label)}${arrow}</th>`;
      })
      .join("");

    const bodyHtml = sortedRows
      .map((scene) => {
        const f = primaryFile(scene);
        const { video, audio } = codecOf(scene);
        const checked = state.selected.has(scene.id) ? "checked" : "";
        const thumb = scene.paths && scene.paths.screenshot
          ? `<img class="sr-thumb" src="${esc(scene.paths.screenshot)}" loading="lazy" alt="">`
          : "";
        return `
        <tr>
          <td><input type="checkbox" class="sr-row-chk" data-id="${esc(scene.id)}" ${checked}></td>
          <td>${thumb}</td>
          <td><a class="sr-link" href="/scenes/${esc(scene.id)}" target="_blank" rel="noopener">${esc(scene.title || `Scene ${scene.id}`)}</a></td>
          <td>${esc((scene.studio && scene.studio.name) || "")}</td>
          <td>${esc(scene.date || "")}</td>
          <td>${f ? `${f.width || "?"}×${f.height || "?"}` : ""}</td>
          <td>${esc(video)}</td>
          <td>${esc(audio)}</td>
          <td>${esc((f && f.format) || "")}</td>
          <td class="sr-num">${f ? fmtDuration(f.duration) : ""}</td>
          <td class="sr-num">${f ? fmtBytes(Number(f.size) || 0) : ""}</td>
        </tr>`;
      })
      .join("");

    content.innerHTML = `
      ${toolbar}
      <div class="sr-table-wrap">
        <table class="sr-table">
          <thead><tr>${headHtml}</tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
    `;

    wireListToolbar(rows);
    wireListTable(rows);
  }

  function sortScenes(rows, sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    const getVal = (scene) => {
      const f = primaryFile(scene);
      switch (sort.field) {
        case "title":
          return (scene.title || "").toLowerCase();
        case "studio":
          return ((scene.studio && scene.studio.name) || "").toLowerCase();
        case "date":
          return scene.date || "";
        case "resolution":
          return f ? (f.width || 0) * (f.height || 0) : 0;
        case "video_codec":
          return codecOf(scene).video;
        case "audio_codec":
          return codecOf(scene).audio;
        case "format":
          return (f && f.format) || "";
        case "duration":
          return f ? Number(f.duration) || 0 : 0;
        case "size":
          return f ? Number(f.size) || 0 : 0;
        default:
          return "";
      }
    };
    return [...rows].sort((a, b) => {
      const va = getVal(a);
      const vb = getVal(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }

  function wireListToolbar(rows) {
    document.getElementById("sr-back-btn").addEventListener("click", () => {
      state.view = "overview";
      render();
    });

    document.getElementById("sr-export-list").addEventListener("click", () => {
      downloadCsv(
        "stash-reports-scenes.csv",
        ["id", "title", "studio", "date", "width", "height", "video_codec", "audio_codec", "format", "duration_seconds", "size_bytes", "url"],
        rows.map((scene) => {
          const f = primaryFile(scene);
          const { video, audio } = codecOf(scene);
          return [
            scene.id,
            scene.title || "",
            (scene.studio && scene.studio.name) || "",
            scene.date || "",
            f ? f.width : "",
            f ? f.height : "",
            video,
            audio,
            (f && f.format) || "",
            f ? Math.round(f.duration) : "",
            f ? f.size : "",
            `${window.location.origin}/scenes/${scene.id}`,
          ];
        })
      );
    });

    document.getElementById("sr-tag-selected").addEventListener("click", async () => {
      const msgEl = document.getElementById("sr-tag-msg");
      const selected = rows.filter((s) => state.selected.has(s.id));
      if (!selected.length) {
        msgEl.className = "sr-msg sr-msg-err";
        msgEl.textContent = "Select at least one scene first.";
        return;
      }
      const btn = document.getElementById("sr-tag-selected");
      btn.disabled = true;
      msgEl.className = "sr-msg";
      msgEl.textContent = `Tagging 0/${selected.length}…`;
      try {
        await tagScenes(selected, RESULT_TAG_NAME, (done, total) => {
          msgEl.textContent = `Tagging ${done}/${total}…`;
        });
        msgEl.className = "sr-msg sr-msg-ok";
        msgEl.textContent = `✓ Tagged ${selected.length} scene(s) with "${RESULT_TAG_NAME}"`;
      } catch (e) {
        console.error("[stash-reports] tagging failed:", e);
        msgEl.className = "sr-msg sr-msg-err";
        msgEl.textContent = `⚠ ${e.message || e}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireListTable(rows) {
    document.querySelectorAll("th[data-sort-field]").forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sortField;
        if (state.sort.field === field) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort = { field, dir: "asc" };
        }
        render();
      });
    });

    const selectAll = document.getElementById("sr-select-all");
    const rowChecks = () => [...document.querySelectorAll(".sr-row-chk")];
    selectAll.checked = rows.length > 0 && rows.every((s) => state.selected.has(s.id));
    selectAll.addEventListener("change", () => {
      rowChecks().forEach((chk) => {
        chk.checked = selectAll.checked;
        const id = chk.dataset.id;
        if (selectAll.checked) state.selected.add(id);
        else state.selected.delete(id);
      });
    });
    rowChecks().forEach((chk) => {
      chk.addEventListener("change", () => {
        if (chk.checked) state.selected.add(chk.dataset.id);
        else state.selected.delete(chk.dataset.id);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Entry point — Settings > Tools panel entry (documented pattern, see
  // stash-plugin-dev-notes-2026-07-15-v2.md "Injecting into Settings ->
  // Tools page").
  // ---------------------------------------------------------------------
  function injectToolsEntry() {
    if (document.getElementById("sr-tools-entry")) return true;

    // Known anchors from SettingsToolsPanel.tsx (per dev-notes-2026-07-15-v2).
    const dupeLink = document.querySelector('a[href="/sceneDuplicateChecker"]');
    const parserLink = document.querySelector('a[href="/sceneFilenameParser"]');
    if (!dupeLink || !parserLink) return false;

    let container = dupeLink.parentElement;
    while (container && !container.contains(parserLink)) {
      container = container.parentElement;
    }
    if (!container) return false;

    let settingEl = dupeLink.parentElement;
    while (settingEl && settingEl.parentElement !== container) {
      settingEl = settingEl.parentElement;
    }
    if (!settingEl) return false;

    const entry = settingEl.cloneNode(true);
    entry.id = "sr-tools-entry";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary";
    btn.textContent = "Open Stash Reports";
    btn.addEventListener("click", openModal);
    const existingLink = entry.querySelector("a");
    if (existingLink) existingLink.replaceWith(btn);
    else entry.appendChild(btn);
    container.appendChild(entry);
    return true;
  }

  function isToolsPage() {
    return /\/settings/.test(window.location.pathname) || /\/settings/.test(window.location.search);
  }

  function onLocationChange() {
    if (isToolsPage()) {
      if (!injectToolsEntry()) {
        // Tools panel content mounts async — retry briefly.
        const deadline = Date.now() + 8000;
        const obs = new MutationObserver(() => {
          if (injectToolsEntry() || Date.now() > deadline) obs.disconnect();
        });
        obs.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  if (window.PluginApi && window.PluginApi.Event) {
    window.PluginApi.Event.addEventListener("stash:location", onLocationChange);
  } else {
    let lastPath = "";
    setInterval(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        onLocationChange();
      }
    }, 500);
  }
  onLocationChange();
})();
