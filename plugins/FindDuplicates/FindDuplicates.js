// FindDuplicates Plugin v1.4.0
// Port of MetadataDuplicateChecker.tsx — plain JS, fetch() to /graphql only.
//
// Matching criteria are user-configurable via a filter bar on each tab (AND logic).
// Toggling a checkbox recomputes duplicates from the already-fetched data — no refetch.
//
// Scene duplicates  : bucket by the checked exact-match fields (title / details / studio),
//                     then (if Performer is checked) connected-components within each bucket
//                     where two scenes are linked when they share ≥1 performer.
// Group duplicates  : exact match on the checked fields (name / synopsis).
//
// Final view also shows the date each file was added (created_at) and supports
// multi-select deletion across all duplicate sets.

(function () {
  "use strict";

  const PAGE_ID   = "fd-page";
  const HASH      = "findduplicates";
  const PAGE_SIZE = 20;

  // ── Utilities ──────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Matches TSX normalize(): trim + lowercase + collapse whitespace.
  // No special-char stripping — punctuation in titles/synopsis must match exactly.
  function normalize(s) {
    return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function truncate(s, max = 150) {
    if (!s) return "";
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  function fmtSize(bytes) {
    if (!bytes) return null;
    return bytes >= 1e9
      ? `${(bytes / 1e9).toFixed(2)} GB`
      : `${(bytes / 1e6).toFixed(1)} MB`;
  }

  // Date the file/scene was added to Stash (created_at). Shows YYYY-MM-DD.
  function fmtDate(s) {
    if (!s) return null;
    return String(s).slice(0, 10);
  }

  // "1920x1080 · 8.5 Mbps" from a Stash file object.
  // bit_rate is in bits/sec (integer); width/height are pixels.
  function fmtQuality(file) {
    if (!file) return null;
    const dim = (file.width && file.height) ? `${file.width}x${file.height}` : null;
    const mbps = file.bit_rate ? `${(file.bit_rate / 1_000_000).toFixed(1)} Mbps` : null;
    if (!dim && !mbps) return null;
    if (dim && mbps) return `${dim} · ${mbps}`;
    return dim || mbps;
  }

  // ── GraphQL ────────────────────────────────────────────────────────────────

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

  // ── Data fetching (per_page: -1 mirrors TSX fetchPolicy: no-cache + per_page: -1) ─

  async function fetchAllScenes() {
    const data = await gql(`
      query {
        findScenes(filter: { per_page: -1 }) {
          scenes {
            id title details
            studio      { id name }
            performers { id name }
            tags        { id name }
            files       { size created_at width height bit_rate }
            groups      { group { id name front_image_path } scene_index }
            paths       { screenshot }
            created_at
          }
        }
      }
    `);
    return data.findScenes.scenes;
  }

  async function fetchAllGroups() {
    const data = await gql(`
      query {
        findGroups(filter: { per_page: -1 }) {
          groups {
            id name synopsis
            studio          { id name }
            date
            front_image_path
            tags            { id name }
          }
        }
      }
    `);
    return data.findGroups.groups;
  }

  // ── Duplicate detection ────────────────────────────────────────────────────

  function hasPerformerOverlap(a, b) {
    const aIds = new Set((a.performers || []).map(p => p.id));
    return (b.performers || []).some(p => aIds.has(p.id));
  }

  // Dynamic scene duplicate detection driven by `criteria` (AND logic — every
  // checked field must match). Exact-match fields (title / details / studio) are
  // combined into a bucket key; performer is an "overlap" criterion applied as a
  // connected-components pass within each bucket. A scene missing a value for a
  // checked exact-match field is skipped (can't be confidently matched).
  function computeSceneDuplicates(scenes, criteria) {
    if (!criteria.title && !criteria.details && !criteria.studio && !criteria.performer) {
      return [];
    }

    const keyMap = new Map();
    for (const scene of scenes) {
      const parts = [];
      let skip = false;

      if (criteria.title) {
        const t = normalize(scene.title);
        if (!t) skip = true; else parts.push("t:" + t);
      }
      if (criteria.details) {
        const d = normalize(scene.details);
        if (!d) skip = true; else parts.push("d:" + d);
      }
      if (criteria.studio) {
        const s = scene.studio?.id;
        if (!s) skip = true; else parts.push("s:" + s);
      }
      if (skip) continue;

      const key = parts.join("\x00");
      if (!keyMap.has(key)) keyMap.set(key, []);
      keyMap.get(key).push(scene);
    }

    const result = [];
    for (const bucket of keyMap.values()) {
      if (bucket.length < 2) continue;

      if (criteria.performer) {
        // Connected components: two scenes are linked when they share ≥1 performer.
        const remaining = [...bucket];
        while (remaining.length > 1) {
          const seed  = remaining.shift();
          const group = [seed];
          let i = 0;
          while (i < remaining.length) {
            if (group.some(s => hasPerformerOverlap(s, remaining[i]))) {
              group.push(...remaining.splice(i, 1));
            } else {
              i++;
            }
          }
          if (group.length > 1) result.push(group);
        }
      } else {
        result.push(bucket);
      }
    }
    return result;
  }

  // Dynamic group duplicate detection driven by `criteria` (AND logic). Exact
  // match on the checked fields. A group missing its name is skipped when name is
  // checked; an empty synopsis still participates (matches prior behaviour).
  function computeGroupDuplicates(groups, criteria) {
    if (!criteria.name && !criteria.synopsis) return [];

    const keyMap = new Map();
    for (const group of groups) {
      const parts = [];
      let skip = false;

      if (criteria.name) {
        const n = normalize(group.name);
        if (!n) skip = true; else parts.push("n:" + n);
      }
      if (criteria.synopsis) {
        parts.push("y:" + normalize(group.synopsis));
      }
      if (skip) continue;

      const key = parts.join("\x00");
      if (!keyMap.has(key)) keyMap.set(key, []);
      keyMap.get(key).push(group);
    }

    const result = [];
    for (const bucket of keyMap.values()) {
      if (bucket.length >= 2) result.push(bucket);
    }
    return result;
  }

  // ── Page state ─────────────────────────────────────────────────────────────

  const state = {
    allScenes: null,      // null = not yet fetched
    allGroups: null,
    sceneDupeSets: null,  // recomputed from allScenes whenever criteria change
    groupDupeSets: null,
    scenePage: 1,
    groupPage: 1,
    // Matching criteria (AND logic). Defaults mirror the prior hardcoded behaviour.
    sceneCriteria: { title: true, details: true, performer: true, studio: false },
    groupCriteria: { name: true, synopsis: true },
    // Ids checked for multi-delete; persists across pages, cleared on recompute/delete.
    selectedScenes: new Set(),
    selectedGroups: new Set(),
  };

  // Labels for the filter-bar checkboxes, in display order.
  const SCENE_CRITERIA = [
    { key: "title",     label: "Title" },
    { key: "details",   label: "Synopsis / Details" },
    { key: "performer", label: "Performer overlap" },
    { key: "studio",    label: "Studio" },
  ];
  const GROUP_CRITERIA = [
    { key: "name",     label: "Name" },
    { key: "synopsis", label: "Synopsis" },
  ];

  // ── Page skeleton ──────────────────────────────────────────────────────────

  function getPage()   { return document.getElementById(PAGE_ID); }
  function getPanel(t) { return document.getElementById(`fd-panel-${t}`); }

  function showPage() {
    if (getPage()) return;

    const el = document.createElement("div");
    el.id = PAGE_ID;
    el.innerHTML = `
      <div id="fd-header">
        <span id="fd-title">Metadata Duplicate Checker</span>
        <div id="fd-tab-bar">
          <button class="fd-tab fd-tab-active" data-tab="scenes">Scenes</button>
          <button class="fd-tab" data-tab="groups">Groups</button>
        </div>
        <button id="fd-close" title="Close">✕</button>
      </div>
      <div id="fd-content">
        <div id="fd-panel-scenes" class="fd-panel fd-panel-active"></div>
        <div id="fd-panel-groups" class="fd-panel"></div>
      </div>`;
    document.body.appendChild(el);

    document.getElementById("fd-close").addEventListener("click", () => {
      hidePage();
      window.history.pushState(null, "", window.location.pathname + window.location.search);
    });

    document.querySelectorAll(".fd-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".fd-tab").forEach(b => b.classList.remove("fd-tab-active"));
        document.querySelectorAll(".fd-panel").forEach(p => p.classList.remove("fd-panel-active"));
        btn.classList.add("fd-tab-active");
        getPanel(btn.dataset.tab).classList.add("fd-panel-active");
      });
    });

    loadScenes();
    loadGroups();
  }

  function hidePage() { getPage()?.remove(); }

  // ── Tab badge ──────────────────────────────────────────────────────────────

  function updateTabBadge(tab, count) {
    const btn = document.querySelector(`.fd-tab[data-tab="${tab}"]`);
    if (!btn) return;
    const label = tab === "scenes" ? "Scenes" : "Groups";
    btn.innerHTML = count > 0
      ? `${label} <span class="fd-badge">${count}</span>`
      : label;
  }

  // ── Pagination element ─────────────────────────────────────────────────────

  function renderPaginationEl(total, current, onChange) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const wrap = document.createElement("div");
    wrap.className = "fd-pagination-wrap";

    const countEl = document.createElement("h6");
    countEl.className = "fd-set-count";
    countEl.textContent = total === 1
      ? "1 duplicate set found."
      : `${total} duplicate sets found.`;
    wrap.appendChild(countEl);

    if (totalPages <= 1) return wrap;

    const pagEl = document.createElement("div");
    pagEl.className = "fd-pagination";

    function addBtn(label, page, disabled, active) {
      const b = document.createElement("button");
      b.className = "fd-btn fd-page-btn" + (active ? " fd-page-btn-active" : "");
      b.textContent = label;
      b.disabled = !!disabled;
      if (!disabled && !active) b.addEventListener("click", () => onChange(page));
      pagEl.appendChild(b);
    }

    function addEllipsis() {
      const sp = document.createElement("span");
      sp.className = "fd-page-ellipsis";
      sp.textContent = "…";
      pagEl.appendChild(sp);
    }

    addBtn("←", current - 1, current <= 1, false);
    let prev = 0;
    for (let p = 1; p <= totalPages; p++) {
      const near = p === 1 || p === totalPages || (p >= current - 2 && p <= current + 2);
      if (near) {
        if (prev && p - prev > 1) addEllipsis();
        addBtn(String(p), p, false, p === current);
        prev = p;
      }
    }
    addBtn("→", current + 1, current >= totalPages, false);

    wrap.appendChild(pagEl);
    return wrap;
  }

  // ── Shared: thumbnail cell HTML ────────────────────────────────────────────

  function thumbCellHtml(src, zoomWidth) {
    if (!src) {
      return `<td class="fd-td-thumb"><div class="fd-thumb fd-no-img"></div></td>`;
    }
    return `
      <td class="fd-td-thumb">
        <div class="fd-thumb-wrap">
          <img class="fd-thumb" src="${esc(src)}" alt="">
          <div class="fd-thumb-zoom" style="width:${zoomWidth}px">
            <img src="${esc(src)}" alt="" style="width:${zoomWidth}px">
          </div>
        </div>
      </td>`;
  }

  // ── Group column cell (scenes table) ──────────────────────────────────────

  // Returns a full <td> showing the scene's first group cover + name link +
  // optional scene index, with the same hover-zoom logic as the cover column.
  function groupCellHtml(scene) {
    const sg = (scene.groups || [])[0];
    if (!sg) return `<td class="fd-td-group"></td>`;

    const img  = sg.group.front_image_path ?? "";
    const href = `/groups/${esc(sg.group.id)}`;
    const name = esc(sg.group.name || sg.group.id);
    const idx  = sg.scene_index ? `<p class="fd-meta-desc">Scene #${sg.scene_index}</p>` : "";

    const imgHtml = img
      ? `<div class="fd-thumb-wrap">
           <img class="fd-thumb" src="${esc(img)}" alt="">
           <div class="fd-thumb-zoom" style="width:600px">
             <img src="${esc(img)}" alt="" style="width:600px">
           </div>
         </div>`
      : `<div class="fd-thumb fd-no-img"></div>`;

    return `
      <td class="fd-td-group">
        ${imgHtml}
        <p style="margin:.2rem 0 0"><a class="fd-link" href="${href}" target="_blank" rel="noopener">${name}</a></p>
        ${idx}
      </td>`;
  }

  // ── Filter bar (matching criteria + multi-delete) ──────────────────────────

  // Collect every id that currently appears in a duplicate set — used to prune
  // stale selections after the criteria change or a delete reshuffles the sets.
  function collectIds(sets) {
    const ids = new Set();
    (sets || []).forEach(set => set.forEach(item => ids.add(item.id)));
    return ids;
  }

  function buildFilterBar(tab) {
    const criteria   = tab === "scenes" ? state.sceneCriteria  : state.groupCriteria;
    const defs       = tab === "scenes" ? SCENE_CRITERIA       : GROUP_CRITERIA;
    const selected   = tab === "scenes" ? state.selectedScenes : state.selectedGroups;
    const onRecompute = tab === "scenes" ? recomputeScenes     : recomputeGroups;
    const onBatch     = tab === "scenes" ? deleteSelectedScenes : deleteSelectedGroups;

    const bar = document.createElement("div");
    bar.className = "fd-filter-bar";

    const label = document.createElement("span");
    label.className = "fd-filter-label";
    label.textContent = "Must match:";
    bar.appendChild(label);

    defs.forEach(def => {
      const lbl = document.createElement("label");
      lbl.className = "fd-filter-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!criteria[def.key];
      cb.addEventListener("change", () => {
        criteria[def.key] = cb.checked;
        onRecompute();
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(" " + def.label));
      bar.appendChild(lbl);
    });

    const batchBtn = document.createElement("button");
    batchBtn.className = "fd-btn fd-btn-danger fd-filter-batch";
    batchBtn.textContent = selected.size > 0
      ? `Delete selected (${selected.size})`
      : "Delete selected";
    batchBtn.disabled = selected.size === 0;
    batchBtn.addEventListener("click", () => onBatch());
    bar.appendChild(batchBtn);

    return bar;
  }

  // Build a list of criteria descriptions for the prose summary.
  function criteriaSummary(defs, criteria) {
    return defs.filter(d => criteria[d.key]).map(d => d.label);
  }

  // ── Scenes tab ─────────────────────────────────────────────────────────────

  async function loadScenes() {
    if (state.allScenes !== null) { recomputeScenes(); return; }

    const panel = getPanel("scenes");
    panel.innerHTML = `<div class="fd-status">Loading scenes…</div>`;

    try {
      state.allScenes = await fetchAllScenes();
      recomputeScenes();
    } catch (e) {
      panel.innerHTML = `<div class="fd-error">Error loading scenes: ${esc(e.message)}</div>`;
    }
  }

  // Recompute duplicate sets from the already-loaded scenes (no GraphQL fetch).
  function recomputeScenes() {
    if (state.allScenes === null) return;
    state.sceneDupeSets = computeSceneDuplicates(state.allScenes, state.sceneCriteria);
    // Drop any selected ids that are no longer part of a duplicate set.
    const valid = collectIds(state.sceneDupeSets);
    state.selectedScenes.forEach(id => { if (!valid.has(id)) state.selectedScenes.delete(id); });
    state.scenePage = 1;
    updateTabBadge("scenes", state.sceneDupeSets.length);
    renderScenes();
  }

  function renderScenes() {
    const panel    = getPanel("scenes");
    const sets     = state.sceneDupeSets || [];
    const total    = sets.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.scenePage  = Math.min(state.scenePage, totalPages);
    const start    = (state.scenePage - 1) * PAGE_SIZE;
    const pageSets = sets.slice(start, start + PAGE_SIZE);

    panel.innerHTML = "";

    // Description + criteria list (reflects the live filter selection)
    const checked = criteriaSummary(SCENE_CRITERIA, state.sceneCriteria);
    const critList = checked.length
      ? `<p>With the current filter, scenes are duplicates when they share all of:</p>
         <ul>${checked.map(c => `<li>${esc(c)}</li>`).join("")}</ul>`
      : `<p>Select at least one criterion below to detect duplicates.</p>`;
    const descEl = document.createElement("div");
    descEl.className = "fd-description";
    descEl.innerHTML = `
      <p class="fd-lead">This page helps detect duplicate scenes based on metadata.
        For phash matching please use the
        <a class="fd-link" href="/sceneDuplicateChecker">Scene Duplicate Checker</a>.</p>
      ${critList}`;
    panel.appendChild(descEl);

    // Filter bar (matching criteria + multi-delete)
    panel.appendChild(buildFilterBar("scenes"));

    // Pagination above
    panel.appendChild(renderPaginationEl(total, state.scenePage, p => {
      state.scenePage = p;
      renderScenes();
      panel.scrollTo({ top: 0 });
    }));

    if (total > 0) {
      const table = document.createElement("table");
      table.className = "fd-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th class="fd-th-select"></th>
            <th class="fd-th-cover">Cover</th>
            <th>Details</th>
            <th class="fd-th-group">Group</th>
            <th></th>
            <th>Quality</th>
            <th>File Size</th>
            <th>Date Added</th>
            <th>Actions</th>
          </tr>
        </thead>`;

      const tbody = document.createElement("tbody");
      pageSets.forEach((set, groupIndex) => {
        set.forEach((scene, i) => {
          // Separator row before each new group (except the very first)
          if (i === 0 && groupIndex !== 0) {
            const sep = document.createElement("tr");
            sep.className = "fd-separator-row";
            sep.innerHTML = `<td colspan="9"></td>`;
            tbody.appendChild(sep);
          }

          const tr = document.createElement("tr");
          tr.className = i === 0 ? "fd-group-first" : "";

          const file0  = (scene.files || [])[0];
          const thumb   = scene.paths?.screenshot ?? "";
          const quality = fmtQuality(file0);
          const size    = fmtSize(file0?.size);
          const added   = fmtDate(file0?.created_at ?? scene.created_at);
          const tags    = (scene.tags || []).map(t => `<span class="fd-tag">${esc(t.name)}</span>`).join("");
          const perfs   = (scene.performers || []).map(p => esc(p.name)).join(", ");
          const isSel   = state.selectedScenes.has(scene.id);

          tr.innerHTML = `
            <td class="fd-td-select">
              <input type="checkbox" class="fd-select" data-type="scene" data-id="${esc(scene.id)}" ${isSel ? "checked" : ""}>
            </td>
            ${thumbCellHtml(thumb, 600)}
            <td class="fd-td-details">
              <p><a class="fd-link" href="/scenes/${esc(scene.id)}" target="_blank" rel="noopener">${esc(scene.title || scene.id)}</a></p>
              <p class="fd-meta-desc">${esc(truncate(scene.details))}</p>
            </td>
            ${groupCellHtml(scene)}
            <td class="fd-td-popover">
              ${tags  ? `<div class="fd-card-tags">${tags}</div>` : ""}
              ${perfs ? `<div class="fd-performers-list">${perfs}</div>` : ""}
            </td>
            <td class="fd-td-quality">${quality ? esc(quality) : "—"}</td>
            <td class="fd-td-size">${size ? esc(size) : "—"}</td>
            <td class="fd-td-date">${added ? esc(added) : "—"}</td>
            <td class="fd-td-action">
              <button class="fd-btn fd-btn-danger fd-delete" data-type="scene" data-id="${esc(scene.id)}">Delete</button>
              <button class="fd-btn fd-btn-primary fd-merge" data-type="scene" data-id="${esc(scene.id)}" data-group-index="${groupIndex}">Merge</button>
            </td>`;
          tbody.appendChild(tr);
        });
      });

      table.appendChild(tbody);
      panel.appendChild(table);
    } else {
      const empty = document.createElement("h4");
      empty.className = "fd-empty";
      empty.textContent = checked.length
        ? "No duplicates found."
        : "Select at least one matching criterion above.";
      panel.appendChild(empty);
    }

    // Pagination below
    panel.appendChild(renderPaginationEl(total, state.scenePage, p => {
      state.scenePage = p;
      renderScenes();
      panel.scrollTo({ top: 0 });
    }));

    panel.querySelectorAll(".fd-delete[data-type='scene']").forEach(btn => {
      btn.addEventListener("click", () => deleteScene(btn.dataset.id, btn));
    });
    panel.querySelectorAll(".fd-select[data-type='scene']").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) state.selectedScenes.add(cb.dataset.id);
        else            state.selectedScenes.delete(cb.dataset.id);
        refreshBatchButton("scenes");
      });
    });
    panel.querySelectorAll(".fd-merge[data-type='scene']").forEach(btn => {
      const gi = parseInt(btn.dataset.groupIndex, 10);
      btn.addEventListener("click", () => openMergeModal(pageSets[gi], btn.dataset.id));
    });
  }

  // Update just the batch-delete button label/disabled state without a full
  // re-render — keeps checkbox toggles snappy.
  function refreshBatchButton(tab) {
    const selected = tab === "scenes" ? state.selectedScenes : state.selectedGroups;
    const btn = getPanel(tab)?.querySelector(".fd-filter-batch");
    if (!btn) return;
    btn.textContent = selected.size > 0 ? `Delete selected (${selected.size})` : "Delete selected";
    btn.disabled = selected.size === 0;
  }

  async function deleteScene(id, btn) {
    if (!confirm("Delete this scene? This cannot be undone.")) return;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await gql(
        `mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
        { input: { ids: [id], delete_file: false } }
      );
      // Re-fetch to mirror TSX refetchScenes() — picks up any other changes too
      state.selectedScenes.delete(id);
      state.allScenes = null;
      loadScenes();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Delete";
      alert(`Delete failed: ${e.message}`);
    }
  }

  async function deleteSelectedScenes() {
    const ids = [...state.selectedScenes];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected scene${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;

    const btn = getPanel("scenes")?.querySelector(".fd-filter-batch");
    if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
    try {
      await gql(
        `mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
        { input: { ids, delete_file: false } }
      );
      state.selectedScenes.clear();
      state.allScenes = null;
      loadScenes();
    } catch (e) {
      if (btn) { btn.disabled = false; }
      refreshBatchButton("scenes");
      alert(`Delete failed: ${e.message}`);
    }
  }

  // ── Merge modal ────────────────────────────────────────────────────────────

  const mergeModal = { set: null, survivorId: null, overlay: null };

  function openMergeModal(set, clickedId) {
    closeMergeModal();
    mergeModal.set = set;
    mergeModal.survivorId = autoSuggestSurvivor(set);

    const overlay = document.createElement("div");
    overlay.id = "fd-merge-overlay";
    overlay.addEventListener("click", e => { if (e.target === overlay) closeMergeModal(); });
    overlay._esc = e => { if (e.key === "Escape") closeMergeModal(); };
    document.addEventListener("keydown", overlay._esc);
    mergeModal.overlay = overlay;

    rebuildMergeModal();
    getPage().appendChild(overlay);
  }

  function closeMergeModal() {
    if (!mergeModal.overlay) return;
    document.removeEventListener("keydown", mergeModal.overlay._esc);
    mergeModal.overlay.remove();
    mergeModal.overlay = null;
    mergeModal.set = null;
    mergeModal.survivorId = null;
  }

  function autoSuggestSurvivor(set) {
    return set.reduce((best, scene) => {
      const bF = (best.files  || [])[0];
      const sF = (scene.files || [])[0];
      const bR = bF?.bit_rate || 0;
      const sR = sF?.bit_rate || 0;
      if (sR > bR) return scene;
      if (sR === bR && (sF?.size || 0) > (bF?.size || 0)) return scene;
      return best;
    }).id;
  }

  // Build the list of metadata checklist items given the current survivorId.
  function buildCheckItems(set, survivorId) {
    const survivor = set.find(s => s.id === survivorId);
    const deleted  = set.filter(s => s.id !== survivorId);

    const sTagIds  = new Set((survivor.tags      || []).map(t => t.id));
    const sPerfIds = new Set((survivor.performers || []).map(p => p.id));
    const sGrpIds  = new Set((survivor.groups    || []).map(g => g.group.id));

    const items = [];

    // Groups from deleted scenes not already on the survivor
    for (const del of deleted) {
      for (const sg of (del.groups || [])) {
        if (!sGrpIds.has(sg.group.id)) {
          sGrpIds.add(sg.group.id);
          const idxStr = sg.scene_index ? ` (Scene #${sg.scene_index})` : "";
          items.push({
            id:      `group-${sg.group.id}`,
            type:    "group",
            label:   `Add group "${sg.group.name}"${idxStr} to survivor`,
            checked: true,
            data:    { group_id: sg.group.id, scene_index: sg.scene_index || null, name: sg.group.name },
          });
        }
      }
    }

    // Missing tags
    const missingTags = [];
    const seenTags = new Set([...sTagIds]);
    for (const del of deleted) {
      for (const t of (del.tags || [])) {
        if (!seenTags.has(t.id)) { seenTags.add(t.id); missingTags.push(t); }
      }
    }
    if (missingTags.length) {
      items.push({
        id: "copy-tags", type: "tags",
        label:   `Copy missing tags: ${missingTags.map(t => t.name).join(", ")}`,
        checked: true,
        data:    missingTags,
      });
    }

    // Missing performers
    const missingPerfs = [];
    const seenPerfs = new Set([...sPerfIds]);
    for (const del of deleted) {
      for (const p of (del.performers || [])) {
        if (!seenPerfs.has(p.id)) { seenPerfs.add(p.id); missingPerfs.push(p); }
      }
    }
    if (missingPerfs.length) {
      items.push({
        id: "copy-performers", type: "performers",
        label:   `Copy missing performers: ${missingPerfs.map(p => p.name).join(", ")}`,
        checked: true,
        data:    missingPerfs,
      });
    }

    // Synopsis
    const survivorHasSynopsis = !!(survivor.details?.trim());
    const synopsisSource = deleted.find(d => d.details?.trim());
    if (synopsisSource) {
      items.push({
        id: "copy-synopsis", type: "synopsis",
        label:   survivorHasSynopsis
          ? "Copy synopsis (will overwrite survivor's synopsis)"
          : "Copy synopsis",
        checked: !survivorHasSynopsis,
        data:    { synopsis: synopsisSource.details },
      });
    }

    // Title (unchecked by default)
    const titleSource = deleted[0];
    if (titleSource?.title) {
      items.push({
        id: "copy-title", type: "title",
        label:   `Copy title: "${titleSource.title}"`,
        checked: false,
        data:    { title: titleSource.title },
      });
    }

    return items;
  }

  function rebuildMergeModal() {
    const overlay = mergeModal.overlay;
    overlay.querySelector(".fd-merge-modal")?.remove();

    const { set, survivorId } = mergeModal;
    const survivor = set.find(s => s.id === survivorId);
    const deleted  = set.filter(s => s.id !== survivorId);
    const checkItems = buildCheckItems(set, survivorId);
    // Map from item.id → checkbox element (populated while building UI)
    const checkMap = new Map();

    const modal = document.createElement("div");
    modal.className = "fd-merge-modal";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "fd-modal-header";
    const titleEl = document.createElement("h4");
    titleEl.className = "fd-modal-title";
    titleEl.textContent = "Merge Duplicate Scenes";
    const closeBtn = document.createElement("button");
    closeBtn.className = "fd-modal-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closeMergeModal);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // ── Body ──
    const body = document.createElement("div");
    body.className = "fd-modal-body";

    // Scene cards
    const cardsWrap = document.createElement("div");
    cardsWrap.className = "fd-merge-scenes";
    set.forEach(scene => {
      const isSurvivor = scene.id === survivorId;
      const card = document.createElement("div");
      card.className = "fd-merge-scene-card " + (isSurvivor ? "fd-merge-survivor" : "fd-merge-deleted");

      const file0   = (scene.files || [])[0];
      const quality = fmtQuality(file0);
      const size    = fmtSize(file0?.size);
      const added   = fmtDate(file0?.created_at ?? scene.created_at);
      const thumb   = scene.paths?.screenshot ?? "";
      const perfs   = (scene.performers || []).map(p => esc(p.name)).join(", ");
      const tags    = (scene.tags || []).map(t => `<span class="fd-tag">${esc(t.name)}</span>`).join("");
      const sg0     = (scene.groups || [])[0];
      const grpHtml = sg0
        ? `<p class="fd-merge-group"><a class="fd-link" href="/groups/${esc(sg0.group.id)}" target="_blank">${esc(sg0.group.name)}</a>${sg0.scene_index ? ` <small class="fd-meta-desc">Scene #${sg0.scene_index}</small>` : ""}</p>`
        : "";

      const imgHtml = thumb
        ? `<img class="fd-merge-thumb" src="${esc(thumb)}" alt="">`
        : `<div class="fd-merge-thumb fd-no-img"></div>`;

      card.innerHTML = `
        <div class="fd-merge-badge">${isSurvivor ? "★ Survivor" : "✕ Will be deleted"}</div>
        ${imgHtml}
        <p class="fd-merge-title"><a class="fd-link" href="/scenes/${esc(scene.id)}" target="_blank" rel="noopener">${esc(scene.title || scene.id)}</a></p>
        <p class="fd-merge-meta">${[quality, size, added].filter(Boolean).map(esc).join(" · ")}</p>
        ${grpHtml}
        ${perfs ? `<p class="fd-merge-perfs">${perfs}</p>` : ""}
        ${tags  ? `<div class="fd-card-tags">${tags}</div>` : ""}
        ${scene.details ? `<p class="fd-merge-meta" style="margin-top:.35rem">${esc(truncate(scene.details))}</p>` : ""}`;

      if (!isSurvivor) {
        card.addEventListener("click", e => {
          if (e.target.tagName === "A") return;
          mergeModal.survivorId = scene.id;
          rebuildMergeModal();
        });
      }
      cardsWrap.appendChild(card);
    });
    body.appendChild(cardsWrap);

    // Checklist
    if (checkItems.length) {
      const clSection = document.createElement("div");
      clSection.className = "fd-merge-checklist";
      const clTitle = document.createElement("p");
      clTitle.className = "fd-merge-section-title";
      clTitle.textContent = "Metadata to copy to survivor:";
      clSection.appendChild(clTitle);
      checkItems.forEach(item => {
        const lbl = document.createElement("label");
        lbl.className = "fd-filter-check fd-merge-check-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = item.checked;
        checkMap.set(item.id, { item, cb });
        cb.addEventListener("change", () => updateMergeSummary(summaryEl, set, survivorId, checkMap));
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(" " + item.label));
        clSection.appendChild(lbl);
      });
      body.appendChild(clSection);
    }

    // Summary
    const summaryEl = document.createElement("div");
    summaryEl.className = "fd-merge-summary";
    body.appendChild(summaryEl);
    updateMergeSummary(summaryEl, set, survivorId, checkMap);

    modal.appendChild(body);

    // ── Footer ──
    const footer = document.createElement("div");
    footer.className = "fd-modal-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "fd-btn fd-btn-secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeMergeModal);
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "fd-btn fd-btn-confirm";
    confirmBtn.textContent = "Confirm Merge";
    confirmBtn.addEventListener("click", () => executeMerge(set, survivorId, checkMap, confirmBtn));
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    modal.appendChild(footer);

    overlay.appendChild(modal);
  }

  function updateMergeSummary(el, set, survivorId, checkMap) {
    const survivor = set.find(s => s.id === survivorId);
    const deleted  = set.filter(s => s.id !== survivorId);

    const addParts = [];
    for (const [, { item, cb }] of checkMap) {
      if (!cb.checked) continue;
      if (item.type === "group") {
        const idxStr = item.data.scene_index ? ` (Scene #${item.data.scene_index})` : "";
        addParts.push(`group "${item.data.name}"${idxStr}`);
      } else if (item.type === "tags") {
        addParts.push(`tags: ${item.data.map(t => t.name).join(", ")}`);
      } else if (item.type === "performers") {
        addParts.push(`performers: ${item.data.map(p => p.name).join(", ")}`);
      } else if (item.type === "synopsis") {
        addParts.push("synopsis");
      } else if (item.type === "title") {
        addParts.push(`title "${item.data.title}"`);
      }
    }

    const survivorTitle  = survivor.title || survivor.id;
    const deletedTitles  = deleted.map(d => d.title || d.id).join(", ");
    let text = `"${survivorTitle}" will be kept. "${deletedTitles}" will be deleted.`;
    if (addParts.length) {
      text += ` The following will be added to the survivor: ${addParts.join("; ")}.`;
    } else {
      text += " No metadata will be copied.";
    }
    el.textContent = text;
  }

  async function executeMerge(set, survivorId, checkMap, confirmBtn) {
    const survivor = set.find(s => s.id === survivorId);
    const deleted  = set.filter(s => s.id !== survivorId);

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Merging…";

    try {
      // Start with survivor's existing ids/groups
      let tagIds  = (survivor.tags      || []).map(t => t.id);
      let perfIds = (survivor.performers || []).map(p => p.id);
      let groups  = (survivor.groups    || []).map(sg => ({
        group_id:    sg.group.id,
        scene_index: sg.scene_index || null,
      }));
      const input = { id: survivorId };

      for (const [, { item, cb }] of checkMap) {
        if (!cb.checked) continue;
        if (item.type === "tags") {
          const newIds = item.data.map(t => t.id);
          tagIds = [...new Set([...tagIds, ...newIds])];
        } else if (item.type === "performers") {
          const newIds = item.data.map(p => p.id);
          perfIds = [...new Set([...perfIds, ...newIds])];
        } else if (item.type === "group") {
          groups.push({ group_id: item.data.group_id, scene_index: item.data.scene_index });
        } else if (item.type === "synopsis") {
          input.details = item.data.synopsis;
        } else if (item.type === "title") {
          input.title = item.data.title;
        }
      }

      input.tag_ids      = tagIds;
      input.performer_ids = perfIds;
      input.groups       = groups;

      await gql(
        `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
        { input }
      );

      const deleteIds = deleted.map(s => s.id);
      await gql(
        `mutation($input: ScenesDestroyInput!) { scenesDestroy(input: $input) }`,
        { input: { ids: deleteIds, delete_file: false } }
      );

      closeMergeModal();
      showToast(`Merged. ${deleteIds.length} scene${deleteIds.length === 1 ? "" : "s"} deleted.`);
      deleteIds.forEach(id => state.selectedScenes.delete(id));
      state.allScenes = null;
      loadScenes();
    } catch (e) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Merge";
      alert(`Merge failed: ${e.message}`);
    }
  }

  // ── Toast notification ──────────────────────────────────────────────────────

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "fd-toast";
    toast.textContent = message;
    getPage().appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("fd-toast-show")));
    setTimeout(() => {
      toast.classList.remove("fd-toast-show");
      toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    }, 3000);
  }

  // ── Groups tab ─────────────────────────────────────────────────────────────

  async function loadGroups() {
    if (state.allGroups !== null) { recomputeGroups(); return; }

    const panel = getPanel("groups");
    panel.innerHTML = `<div class="fd-status">Loading groups…</div>`;

    try {
      state.allGroups = await fetchAllGroups();
      recomputeGroups();
    } catch (e) {
      panel.innerHTML = `<div class="fd-error">Error loading groups: ${esc(e.message)}</div>`;
    }
  }

  // Recompute duplicate sets from the already-loaded groups (no GraphQL fetch).
  function recomputeGroups() {
    if (state.allGroups === null) return;
    state.groupDupeSets = computeGroupDuplicates(state.allGroups, state.groupCriteria);
    const valid = collectIds(state.groupDupeSets);
    state.selectedGroups.forEach(id => { if (!valid.has(id)) state.selectedGroups.delete(id); });
    state.groupPage = 1;
    updateTabBadge("groups", state.groupDupeSets.length);
    renderGroups();
  }

  function renderGroups() {
    const panel    = getPanel("groups");
    const sets     = state.groupDupeSets || [];
    const total    = sets.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    state.groupPage  = Math.min(state.groupPage, totalPages);
    const start    = (state.groupPage - 1) * PAGE_SIZE;
    const pageSets = sets.slice(start, start + PAGE_SIZE);

    panel.innerHTML = "";

    const checked = criteriaSummary(GROUP_CRITERIA, state.groupCriteria);
    const descEl = document.createElement("p");
    descEl.className = "fd-lead";
    descEl.textContent = checked.length
      ? `Detects duplicate groups that share all of: ${checked.join(", ")}.`
      : "Select at least one criterion below to detect duplicate groups.";
    panel.appendChild(descEl);

    // Filter bar (matching criteria + multi-delete)
    panel.appendChild(buildFilterBar("groups"));

    panel.appendChild(renderPaginationEl(total, state.groupPage, p => {
      state.groupPage = p;
      renderGroups();
      panel.scrollTo({ top: 0 });
    }));

    if (total > 0) {
      const table = document.createElement("table");
      table.className = "fd-table";
      table.innerHTML = `
        <thead>
          <tr>
            <th class="fd-th-select"></th>
            <th class="fd-th-cover">Cover</th>
            <th>Details</th>
            <th>Studio</th>
            <th></th>
            <th>Delete</th>
          </tr>
        </thead>`;

      const tbody = document.createElement("tbody");
      pageSets.forEach((set, groupIndex) => {
        set.forEach((item, i) => {
          if (i === 0 && groupIndex !== 0) {
            const sep = document.createElement("tr");
            sep.className = "fd-separator-row";
            sep.innerHTML = `<td colspan="6"></td>`;
            tbody.appendChild(sep);
          }

          const tr = document.createElement("tr");
          tr.className = i === 0 ? "fd-group-first" : "";

          const thumb   = item.front_image_path ?? "";
          const tags    = (item.tags || []).map(t => `<span class="fd-tag">${esc(t.name)}</span>`).join("");
          const studio  = item.studio
            ? `<a class="fd-link" href="/studios/${esc(item.studio.id)}" target="_blank" rel="noopener">${esc(item.studio.name)}</a>`
            : "";
          const dateStr = item.date
            ? `<p class="fd-meta-desc">Released ${esc(item.date)}</p>`
            : "";
          const isSel = state.selectedGroups.has(item.id);

          tr.innerHTML = `
            <td class="fd-td-select">
              <input type="checkbox" class="fd-select" data-type="group" data-id="${esc(item.id)}" ${isSel ? "checked" : ""}>
            </td>
            ${thumbCellHtml(thumb, 300)}
            <td class="fd-td-details">
              <p><a class="fd-link" href="/groups/${esc(item.id)}" target="_blank" rel="noopener">${esc(item.name || item.id)}</a></p>
              <p class="fd-meta-desc">${esc(truncate(item.synopsis))}</p>
            </td>
            <td class="fd-td-studio">
              ${studio}
              ${dateStr}
            </td>
            <td class="fd-td-popover">
              ${tags ? `<div class="fd-card-tags">${tags}</div>` : ""}
            </td>
            <td class="fd-td-action">
              <button class="fd-btn fd-btn-danger fd-delete" data-type="group" data-id="${esc(item.id)}">Delete</button>
            </td>`;
          tbody.appendChild(tr);
        });
      });

      table.appendChild(tbody);
      panel.appendChild(table);
    } else {
      const empty = document.createElement("h4");
      empty.className = "fd-empty";
      empty.textContent = checked.length
        ? "No duplicates found."
        : "Select at least one matching criterion above.";
      panel.appendChild(empty);
    }

    panel.appendChild(renderPaginationEl(total, state.groupPage, p => {
      state.groupPage = p;
      renderGroups();
      panel.scrollTo({ top: 0 });
    }));

    panel.querySelectorAll(".fd-delete[data-type='group']").forEach(btn => {
      btn.addEventListener("click", () => deleteGroup(btn.dataset.id, btn));
    });
    panel.querySelectorAll(".fd-select[data-type='group']").forEach(cb => {
      cb.addEventListener("change", () => {
        if (cb.checked) state.selectedGroups.add(cb.dataset.id);
        else            state.selectedGroups.delete(cb.dataset.id);
        refreshBatchButton("groups");
      });
    });
  }

  async function deleteGroup(id, btn) {
    if (!confirm("Delete this group? This cannot be undone.")) return;
    btn.disabled = true;
    btn.textContent = "Deleting…";
    try {
      await gql(
        `mutation($id: ID!) { groupDestroy(input: { id: $id }) }`,
        { id }
      );
      // Re-fetch to mirror TSX refetchGroups()
      state.selectedGroups.delete(id);
      state.allGroups = null;
      loadGroups();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Delete";
      alert(`Delete failed: ${e.message}`);
    }
  }

  async function deleteSelectedGroups() {
    const ids = [...state.selectedGroups];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected group${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return;

    const btn = getPanel("groups")?.querySelector(".fd-filter-batch");
    if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
    try {
      await gql(
        `mutation($ids: [ID!]!) { groupsDestroy(ids: $ids) }`,
        { ids }
      );
      state.selectedGroups.clear();
      state.allGroups = null;
      loadGroups();
    } catch (e) {
      if (btn) { btn.disabled = false; }
      refreshBatchButton("groups");
      alert(`Delete failed: ${e.message}`);
    }
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  function checkRoute() {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === HASH) showPage();
    else hidePage();
  }

  // ── Settings → Tools page injection ───────────────────────────────────────

  function isToolsPage() {
    const p = new URL(window.location.href);
    return p.pathname === "/settings" && p.searchParams.get("tab") === "tools";
  }

  function injectToolsEntry() {
    if (document.getElementById("fd-tools-entry")) return true;

    // Both anchors come from SettingsToolsPanel.tsx and are reliably rendered
    // when the Tools tab is active. Using two lets us locate the shared parent
    // (the SettingsToolsSection div) without guessing at class names.
    const dupeLink   = document.querySelector('a[href="/sceneDuplicateChecker"]');
    const parserLink = document.querySelector('a[href="/sceneFilenameParser"]');
    if (!dupeLink || !parserLink) return false;

    // Walk up from dupeLink to the nearest ancestor that also contains parserLink
    // — that is the rendered SettingsToolsSection container.
    let container = dupeLink.parentElement;
    while (container && !container.contains(parserLink)) {
      container = container.parentElement;
    }
    if (!container) return false;

    // The direct child of that container wrapping dupeLink = one rendered <Setting>.
    let settingEl = dupeLink.parentElement;
    while (settingEl && settingEl.parentElement !== container) {
      settingEl = settingEl.parentElement;
    }
    if (!settingEl) return false;

    // Deep-clone so our entry inherits the exact DOM structure and classes.
    const entry = settingEl.cloneNode(true);
    entry.id = "fd-tools-entry";

    // Build the replacement button.
    const clonedAnchor = entry.querySelector("a");
    const clonedBtn    = clonedAnchor?.querySelector("button") ?? entry.querySelector("button");
    const targetEl     = clonedAnchor ?? clonedBtn;

    const btn = document.createElement("button");
    btn.className = clonedBtn?.className ?? "btn btn-primary";
    btn.textContent = "Find Dupes";
    btn.title = "Metadata Duplicate Checker — find duplicate scenes and groups";
    btn.addEventListener("click", () => { window.location.hash = HASH; });

    if (targetEl) {
      // Normal path: swap the cloned <a> (or bare <button>) for our button.
      targetEl.replaceWith(btn);
    } else {
      // Fallback: structure didn't match expectations; append directly so
      // something always renders even if it isn't perfectly styled.
      entry.appendChild(btn);
    }

    container.appendChild(entry);
    return true;
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  function boot() {
    // Hash-based routing — #findduplicates opens the overlay (bookmarkable).
    // Primary entry point is the Settings → Tools page button.
    window.addEventListener("hashchange", checkRoute);
    window.addEventListener("popstate",   checkRoute);
    checkRoute();

    // Re-inject the tools entry whenever React re-renders the Tools page.
    const mo = new MutationObserver(() => {
      if (isToolsPage() && !document.getElementById("fd-tools-entry")) {
        injectToolsEntry();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    function onNavigation() {
      checkRoute();
      if (isToolsPage()) injectToolsEntry();
    }

    if (window.PluginApi?.Event) {
      window.PluginApi.Event.addEventListener("stash:location", onNavigation);
    } else {
      let last = "";
      setInterval(() => {
        const cur = window.location.href;
        if (cur !== last) { last = cur; onNavigation(); }
      }, 500);
    }
  }

  boot();

})();
