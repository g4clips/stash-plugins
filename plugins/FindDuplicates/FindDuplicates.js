// FindDuplicates Plugin v1.1.0
// Port of MetadataDuplicateChecker.tsx — plain JS, fetch() to /graphql only.
//
// Scene duplicates  : connected-components within (normalizedTitle + normalizedDetails) buckets,
//                     where two scenes are connected when they share ≥1 performer.
// Group duplicates  : exact match on (normalizedName + normalizedSynopsis).

(function () {
  "use strict";

  const NAV_ID    = "fd-nav-item";
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
            performers { id name }
            tags        { id name }
            files       { size }
            paths       { screenshot }
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

  // Matches TSX computeSceneDuplicates: connected-components within each
  // (normalizedTitle + "\0" + normalizedDetails) bucket.
  function buildSceneDupeSets(scenes) {
    const keyMap = new Map();
    for (const scene of scenes) {
      const title   = normalize(scene.title);
      const details = normalize(scene.details);
      if (!title || !details) continue;
      const key = `${title}\x00${details}`;
      if (!keyMap.has(key)) keyMap.set(key, []);
      keyMap.get(key).push(scene);
    }

    const result = [];
    for (const bucket of keyMap.values()) {
      if (bucket.length < 2) continue;
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
    }
    return result;
  }

  // Matches TSX computeGroupDuplicates: exact key match on normalizedName + "\0" + normalizedSynopsis.
  function buildGroupDupeSets(groups) {
    const keyMap = new Map();
    for (const group of groups) {
      const name = normalize(group.name);
      if (!name) continue;
      const synopsis = normalize(group.synopsis);
      const key = `${name}\x00${synopsis}`;
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
    sceneDupeSets: null,  // null = not yet loaded
    groupDupeSets: null,
    scenePage: 1,
    groupPage: 1,
  };

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

  // ── Scenes tab ─────────────────────────────────────────────────────────────

  async function loadScenes() {
    if (state.sceneDupeSets !== null) { renderScenes(); return; }

    const panel = getPanel("scenes");
    panel.innerHTML = `<div class="fd-status">Loading scenes…</div>`;

    try {
      const all = await fetchAllScenes();
      state.sceneDupeSets = buildSceneDupeSets(all);
      state.scenePage = 1;
      updateTabBadge("scenes", state.sceneDupeSets.length);
      renderScenes();
    } catch (e) {
      panel.innerHTML = `<div class="fd-error">Error loading scenes: ${esc(e.message)}</div>`;
    }
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

    // Description + criteria list (matches TSX renderSceneTab prose)
    const descEl = document.createElement("div");
    descEl.className = "fd-description";
    descEl.innerHTML = `
      <p class="fd-lead">This page helps detect duplicate scenes based on metadata.
        For phash matching please use the
        <a class="fd-link" href="/sceneDuplicateChecker">Scene Duplicate Checker</a>.</p>
      <p>Scenes are considered duplicates when they share all of the following criteria:</p>
      <ul>
        <li>Identical normalized title</li>
        <li>At least one shared performer</li>
        <li>Identical synopsis</li>
      </ul>`;
    panel.appendChild(descEl);

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
            <th class="fd-th-cover">Cover</th>
            <th>Details</th>
            <th></th>
            <th>File Size</th>
            <th>Delete</th>
          </tr>
        </thead>`;

      const tbody = document.createElement("tbody");
      pageSets.forEach((set, groupIndex) => {
        set.forEach((scene, i) => {
          // Separator row before each new group (except the very first)
          if (i === 0 && groupIndex !== 0) {
            const sep = document.createElement("tr");
            sep.className = "fd-separator-row";
            sep.innerHTML = `<td colspan="5"></td>`;
            tbody.appendChild(sep);
          }

          const tr = document.createElement("tr");
          tr.className = i === 0 ? "fd-group-first" : "";

          const thumb = scene.paths?.screenshot ?? "";
          const size  = fmtSize((scene.files || [])[0]?.size);
          const tags  = (scene.tags || []).map(t => `<span class="fd-tag">${esc(t.name)}</span>`).join("");
          const perfs = (scene.performers || []).map(p => esc(p.name)).join(", ");

          tr.innerHTML = `
            ${thumbCellHtml(thumb, 600)}
            <td class="fd-td-details">
              <p><a class="fd-link" href="/scenes/${esc(scene.id)}" target="_blank" rel="noopener">${esc(scene.title || scene.id)}</a></p>
              <p class="fd-meta-desc">${esc(truncate(scene.details))}</p>
            </td>
            <td class="fd-td-popover">
              ${tags  ? `<div class="fd-card-tags">${tags}</div>` : ""}
              ${perfs ? `<div class="fd-performers-list">${perfs}</div>` : ""}
            </td>
            <td class="fd-td-size">${size ? esc(size) : "—"}</td>
            <td class="fd-td-action">
              <button class="fd-btn fd-btn-danger fd-delete" data-type="scene" data-id="${esc(scene.id)}">Delete</button>
            </td>`;
          tbody.appendChild(tr);
        });
      });

      table.appendChild(tbody);
      panel.appendChild(table);
    } else {
      const empty = document.createElement("h4");
      empty.className = "fd-empty";
      empty.textContent = "No duplicates found.";
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
      state.sceneDupeSets = null;
      loadScenes();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Delete";
      alert(`Delete failed: ${e.message}`);
    }
  }

  // ── Groups tab ─────────────────────────────────────────────────────────────

  async function loadGroups() {
    if (state.groupDupeSets !== null) { renderGroups(); return; }

    const panel = getPanel("groups");
    panel.innerHTML = `<div class="fd-status">Loading groups…</div>`;

    try {
      const all = await fetchAllGroups();
      state.groupDupeSets = buildGroupDupeSets(all);
      state.groupPage = 1;
      updateTabBadge("groups", state.groupDupeSets.length);
      renderGroups();
    } catch (e) {
      panel.innerHTML = `<div class="fd-error">Error loading groups: ${esc(e.message)}</div>`;
    }
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

    const descEl = document.createElement("p");
    descEl.className = "fd-lead";
    descEl.textContent =
      "Detects duplicates based on Group Name, and Synopsis. Use this to detect and delete duplicate groups.";
    panel.appendChild(descEl);

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
            sep.innerHTML = `<td colspan="5"></td>`;
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

          tr.innerHTML = `
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
      empty.textContent = "No duplicates found.";
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
      state.groupDupeSets = null;
      loadGroups();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Delete";
      alert(`Delete failed: ${e.message}`);
    }
  }

  // ── Nav link injection ─────────────────────────────────────────────────────

  function injectNav() {
    if (document.getElementById(NAV_ID)) return true;
    const nav =
      document.querySelector(".navbar-nav") ||
      document.querySelector("nav.sidebar ul") ||
      document.querySelector(".main-sidebar .nav");
    if (!nav) return false;

    const li = document.createElement("li");
    li.id = NAV_ID;
    li.className = "nav-item";

    const a = document.createElement("a");
    a.className = "nav-link";
    a.href = "#" + HASH;
    a.textContent = "Find Dupes";
    a.title = "Metadata Duplicate Checker";
    a.addEventListener("click", e => {
      e.preventDefault();
      window.location.hash = HASH;
    });

    li.appendChild(a);
    nav.appendChild(li);
    return true;
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  function checkRoute() {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === HASH) showPage();
    else hidePage();
  }

  function onLocationChange() {
    injectNav();
    checkRoute();
  }

  function boot() {
    if (window.PluginApi?.Event) {
      window.PluginApi.Event.addEventListener("stash:location", onLocationChange);
    } else {
      let last = "";
      setInterval(() => {
        const cur = window.location.href;
        if (cur !== last) { last = cur; onLocationChange(); }
      }, 500);
    }

    // Re-inject nav whenever React clears it during re-renders
    const mo = new MutationObserver(() => {
      if (!document.getElementById(NAV_ID)) injectNav();
    });
    mo.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("hashchange", checkRoute);
    onLocationChange();
  }

  boot();

})();
