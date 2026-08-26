if (window._markerScenesLoaded) {
  console.log("[marker-scenes] Already loaded, skipping re-registration.");
} else {
  window._markerScenesLoaded = true;

// marker-scenes.js
// Stash plugin: creates virtual scenes from scene markers.
// MVP v0.1 — no overwrite detection, no settings UI yet.

(function () {
  "use strict";

  const PLUGIN_ID = "marker-scenes";
  const BUTTON_ID = "marker-scenes-btn";

  async function gql(query, variables = {}) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const data = await response.json();
    if (data.errors) {
      console.error(`[${PLUGIN_ID}] GraphQL errors:`, data.errors);
      throw new Error(data.errors[0].message);
    }
    return data.data;
  }

  // Get React Router's history object from the fiber tree
  function getReactHistory() {
    const root = document.querySelector('#root');
    if (!root) return null;
    const fiber = root._reactRootContainer?._internalRoot?.current;
    if (!fiber) return null;

    let history = null;
    const walk = (node, depth = 0) => {
      if (!node || depth > 100 || history) return;
      try {
        if (node.memoizedProps?.history?.replace && typeof node.memoizedProps.history.replace === 'function') {
          history = node.memoizedProps.history;
        }
      } catch(e) {}
      walk(node.child, depth + 1);
      walk(node.sibling, depth + 1);
    };
    walk(fiber);
    return history;
  }

  const FIND_SCENE = `
    query FindScene($id: ID!) {
      findScene(id: $id) {
        id
        urls
        title
        files {
          duration
        }
        groups {
          group {
            id
            name
          }
          scene_index
        }
        studio {
          id
          name
        }
        scene_markers {
          id
          title
          seconds
          primary_tag {
            id
            name
          }
        }
      }
    }
  `;

  const SCENE_CREATE = `
    mutation SceneCreate($input: SceneCreateInput!) {
      sceneCreate(input: $input) {
        id
        title
        urls
        groups {
          group { id name }
          scene_index
        }
      }
    }
  `;

  const FIND_TAG_BY_NAME = `
    query FindTagByName($name: String!) {
      findTags(
        tag_filter: { name: { value: $name, modifier: EQUALS } }
        filter: { per_page: 1 }
      ) {
        tags {
          id
          name
        }
      }
    }
  `;

  const MARKER_CREATE = `
    mutation SceneMarkerCreate($input: SceneMarkerCreateInput!) {
      sceneMarkerCreate(input: $input) {
        id
        title
        seconds
      }
    }
  `;

  const SCENE_UPDATE = `
    mutation SceneUpdate($input: SceneUpdateInput!) {
      sceneUpdate(input: $input) {
        id
        groups {
          group { id }
          scene_index
        }
      }
    }
  `;

  const SCENE_DESTROY = `
    mutation SceneDestroy($id: ID!) {
      sceneDestroy(input: { id: $id })
    }
  `;

  const SCENE_MARKER_DESTROY = `
    mutation SceneMarkerDestroy($id: ID!) {
      sceneMarkerDestroy(id: $id)
    }
  `;

  const FIND_GROUP_SCENES = `
    query FindGroupScenes($group_id: [ID!]!) {
      findScenes(
        scene_filter: {
          groups: { value: $group_id, modifier: INCLUDES }
        }
        filter: { per_page: -1 }
      ) {
        scenes {
          id
          title
          urls
          files { id }
          groups {
            group { id }
            scene_index
          }
          scene_markers {
            id
            title
            seconds
            primary_tag { id name }
          }
        }
      }
    }
  `;

  // ── Virtual scene creator modal ───────────────────────────────────────────

  let modalState = null; // tracks modal session state

  function formatTime(seconds) {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    if (h > 0) return `${h}:${mm}:${ss}`;
    return `${m}:${ss}`;
  }

  function getCurrentTimestamp() {
    const player = document.querySelector("video-js")?.player;
    if (player) return player.currentTime();
    const video = document.querySelector("video.vjs-tech");
    return video ? video.currentTime : 0;
  }

  function removeModal() {
    const existing = document.getElementById("ms-modal-overlay");
    if (existing) existing.remove();
  }

  function renderModal(scene, groupName) {
    removeModal();

    const state = modalState;
    const nextSceneNum = state.scenes.length + 1;
    const currentTime = getCurrentTimestamp();

    const panel = document.createElement("div");
    panel.id = "ms-modal-overlay";
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 380px;
      z-index: 9999;
      background: #1a1a1a;
      border: 1px solid #444;
      border-radius: 8px;
      color: #eee;
      font-family: sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;

    const scenesHtml = state.scenes.length === 0
      ? `<p style="color:#888;margin:0;font-size:13px;">No scenes created yet.</p>`
      : state.scenes.map(s => `
          <div style="display:flex;justify-content:space-between;padding:6px 8px;background:#2a2a2a;border-radius:4px;margin-bottom:4px;">
            <span>Scene ${s.index}</span>
            <span style="color:#aaa;font-family:monospace;">${formatTime(s.start)} → ${s.end !== null ? formatTime(s.end) : "?"}</span>
          </div>
        `).join("");

    panel.innerHTML = `
      <div style="padding:10px 14px;border-bottom:1px solid #444;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:500;">Create virtual scene</div>
          <div style="font-size:12px;color:#aaa;">${groupName}</div>
        </div>
        <button id="ms-close" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px;">✕</button>
      </div>

      <div style="padding:12px 14px;">

        <div style="display:flex;justify-content:space-between;background:#2a2a2a;border-radius:6px;padding:10px;margin-bottom:12px;">
          <div>
            <div style="font-size:11px;color:#888;margin-bottom:2px;">Current timestamp</div>
            <div style="font-size:20px;font-weight:500;font-family:monospace;">${formatTime(currentTime)}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:11px;color:#888;margin-bottom:2px;">Scene to create</div>
            <div style="font-size:20px;font-weight:500;color:#5b9bd5;">Scene ${nextSceneNum}</div>
          </div>
        </div>

        <div style="margin-bottom:12px;">
          <div style="font-size:12px;color:#aaa;margin-bottom:6px;font-weight:500;">Scenes created so far</div>
          <div id="ms-scenes-list">${scenesHtml}</div>
        </div>

        <div style="background:#1e3a52;border:1px solid #2d6a9f;border-radius:4px;padding:8px 10px;margin-bottom:12px;font-size:13px;color:#7ab3e0;">
          Scrub to the start of scene ${nextSceneNum}, then click "Create scene ${nextSceneNum}".
        </div>

        <div id="ms-error" style="display:none;background:#3a1a1a;border:1px solid #7a2a2a;border-radius:4px;padding:8px 10px;margin-bottom:12px;font-size:13px;color:#e07a7a;"></div>

        <div style="display:flex;gap:8px;">
          <button id="ms-last" class="btn btn-secondary" style="flex:1;font-size:13px;">
            🏁 Last scene
          </button>
          <button id="ms-create" class="btn btn-primary" style="flex:1;font-size:13px;">
            + Create scene ${nextSceneNum}
          </button>
        </div>

      </div>
    `;

    document.body.appendChild(panel);

    // Make panel draggable by its header
    const header = panel.querySelector("div");
    let isDragging = false;
    let dragStartX, dragStartY, panelStartX, panelStartY;

    header.style.cursor = "grab";

    header.addEventListener("mousedown", (e) => {
      if (e.target.id === "ms-close") return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = panel.getBoundingClientRect();
      panelStartX = rect.left;
      panelStartY = rect.top;
      header.style.cursor = "grabbing";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      panel.style.left = (panelStartX + dx) + "px";
      panel.style.top = (panelStartY + dy) + "px";
      panel.style.bottom = "auto";
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
      header.style.cursor = "grab";
    });

    document.getElementById("ms-close").addEventListener("click", () => {
      modalState = null;
      removeModal();
    });

    document.getElementById("ms-create").addEventListener("click", () => handleCreateScene(scene, groupName, false));
    document.getElementById("ms-last").addEventListener("click", () => handleCreateScene(scene, groupName, true));
  }

  function showModalError(message) {
    const errorDiv = document.getElementById("ms-error");
    if (!errorDiv) return;
    errorDiv.style.display = "block";
    errorDiv.textContent = message;
  }

  function setModalBusy(busy) {
    const createBtn = document.getElementById("ms-create");
    const lastBtn = document.getElementById("ms-last");
    if (!createBtn || !lastBtn) return;
    createBtn.disabled = busy;
    lastBtn.disabled = busy;
    if (busy) {
      createBtn.textContent = "Working...";
    }
  }

  async function handleCreateScene(scene, groupName, isLast) {
    setModalBusy(true);

    const timestamp = getCurrentTimestamp();
    const sceneIndex = modalState.scenes.length + 1;
    const origin = window.location.origin;
    const group = scene.groups[0].group;

    // Update end time of previous scene
    if (modalState.scenes.length > 0) {
      modalState.scenes[modalState.scenes.length - 1].end = timestamp;
    }

    // Create marker
    try {
      await gql(MARKER_CREATE, {
        input: {
          scene_id: scene.id,
          title: `Scene ${sceneIndex}`,
          seconds: timestamp,
          primary_tag_id: modalState.tagId,
        }
      });
    } catch (err) {
      showModalError(`Failed to create marker: ${err.message}`);
      setModalBusy(false);
      return;
    }

    // Create virtual scene
    const input = {
      title: `${groupName} - Scene ${sceneIndex}`,
      urls: [`${origin}/scenes/${scene.id}?t=${timestamp}`],
      organized: false,
      groups: [{ group_id: group.id, scene_index: sceneIndex }],
    };
    if (scene.studio) input.studio_id = scene.studio.id;

    try {
      await gql(SCENE_CREATE, { input });
    } catch (err) {
      showModalError(`Failed to create virtual scene: ${err.message}`);
      setModalBusy(false);
      return;
    }

    // On first scene, update original scene to index 99
    if (sceneIndex === 1) {
      try {
        await gql(SCENE_UPDATE, {
          input: {
            id: scene.id,
            groups: [{ group_id: group.id, scene_index: 99 }],
          }
        });
      } catch (err) {
        showModalError(`Failed to update original scene index: ${err.message}`);
        setModalBusy(false);
        return;
      }
    }

    // Record this scene in state
    modalState.scenes.push({
      index: sceneIndex,
      start: timestamp,
      end: isLast ? (scene.files?.[0]?.duration ?? null) : null,
    });

    if (isLast) {
      modalState = null;
      removeModal();
      alert(`Done! Created ${sceneIndex} virtual scene(s).`);
      return;
    }

    renderModal(scene, groupName);
  }

  async function openVirtualSceneModal(scene) {
    const group = scene.groups[0].group;

    // Look up zzz-virtual tag
    let tagId;
    try {
      const data = await gql(FIND_TAG_BY_NAME, { name: "zzz-virtual" });
      const tags = data.findTags?.tags ?? [];
      if (tags.length === 0) {
        alert('Tag "zzz-virtual" not found in Stash. Please create it first, then try again.');
        return;
      }
      tagId = tags[0].id;
    } catch (err) {
      alert(`Failed to look up tag: ${err.message}`);
      return;
    }

    modalState = {
      tagId,
      scenes: [],
    };

    renderModal(scene, group.name);
  }

  async function maybeHandleVirtualScene(sceneId) {
    let data;
    try {
      data = await gql(FIND_SCENE, { id: sceneId });
    } catch (err) {
      return;
    }
    const scene = data.findScene;
    if (scene.files && scene.files.length > 0) return;
    const markerUrl = (scene.urls || []).find(u => u.match(/\/scenes\/\d+\?t=\d/));
    if (!markerUrl) return;

    const target = new URL(markerUrl);
    const redirect = target.pathname + target.search;

    console.log(`[${PLUGIN_ID}] Virtual scene detected, waiting for player click...`);

    const tryAttach = () => {
      const player = document.querySelector(".VideoPlayer.no-file");
      if (!player) return false;

      player.style.cursor = "pointer";
      player.title = "Click to play original scene at marker timestamp";
      player.addEventListener("click", () => {
        console.log(`[${PLUGIN_ID}] Player clicked, redirecting to ${redirect}`);
        const history = getReactHistory();
        if (history) {
          console.log(`[${PLUGIN_ID}] Using React Router history.replace`);
          history.replace(redirect);
        } else {
          console.log(`[${PLUGIN_ID}] Falling back to window.location.replace`);
          window.location.replace(redirect);
        }
      }, { once: true });

      console.log(`[${PLUGIN_ID}] Click handler attached to empty player.`);
      return true;
    };

    if (!tryAttach()) {
      const deadline = Date.now() + 10000;
      const obs = new MutationObserver(() => {
        if (tryAttach() || Date.now() > deadline) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  function maybeAutoPlay() {
    if (!isScenePage()) return;
    if (!window.location.search.includes("t=")) return;

    console.log(`[${PLUGIN_ID}] Landed on timestamped scene, attempting auto-play...`);

    const tryPlay = () => {
      const video = document.querySelector("video.vjs-tech");
      if (!video) return false;
      video.play().then(() => {
        console.log(`[${PLUGIN_ID}] Auto-play succeeded.`);
      }).catch(err => {
        console.log(`[${PLUGIN_ID}] Auto-play blocked by browser: ${err.message}`);
      });
      return true;
    };

    if (!tryPlay()) {
      const deadline = Date.now() + 10000;
      const obs = new MutationObserver(() => {
        if (tryPlay() || Date.now() > deadline) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function createMarkerScenes(scene) {
    const markers = scene.scene_markers;
    if (!markers || markers.length === 0) {
      alert("This scene has no markers. Add markers first.");
      return;
    }

    const groupEntry = scene.groups[0];
    const group = groupEntry.group;
    const origin = window.location.origin;
    const sceneId = scene.id;

    console.log(
      `[${PLUGIN_ID}] Processing ${markers.length} marker(s) for scene ${sceneId} in group "${group.name}"`
    );

    let created = 0;
    let failed = 0;

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const markerIndex = i + 1;
      const title = `${group.name} - Scene ${markerIndex}`;
      const url = `${origin}/scenes/${sceneId}?t=${marker.seconds}`;

      const input = {
        title,
        urls: [url],
        organized: false,
        groups: [{ group_id: group.id, scene_index: markerIndex }],
      };

      if (scene.studio) {
        input.studio_id = scene.studio.id;
      }

      try {
        const result = await gql(SCENE_CREATE, { input });
        const newScene = result.sceneCreate;
        console.log(
          `[${PLUGIN_ID}] Created scene ${newScene.id}: "${newScene.title}" -> ${url}`
        );
        created++;
      } catch (err) {
        console.error(
          `[${PLUGIN_ID}] Failed to create scene for marker ${markerIndex}:`,
          err
        );
        failed++;
      }
    }

    const summary = `Done! Created ${created} scene(s).${failed > 0 ? ` ${failed} failed - check the browser console.` : ""}`;
    alert(summary);
    console.log(`[${PLUGIN_ID}] ${summary}`);
  }

  // ── Button injection ──────────────────────────────────────────────────────

  function isScenePage() {
    return /^\/scenes\/\d+/.test(window.location.pathname);
  }

  function injectButton(scene) {
    if (!isScenePage() || document.getElementById(BUTTON_ID)) return;

    const tryInsert = () => {
      // const anchor = document.getElementById("d18-open-btn") ||
      //                document.querySelector(".scene-toolbar");
      // if (!anchor) return false;

      // const btn = document.createElement("button");
      // btn.id = BUTTON_ID;
      // btn.className = "btn btn-primary";
      // btn.textContent = "Virtual scenes";
      // btn.style.cssText = "margin-left:8px;font-size:.85rem;";
      // btn.addEventListener("click", async () => {
      //   btn.disabled = true;
      //   try {
      //     const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
      //     const fresh = await gql(FIND_SCENE, { id: sceneId });
      //     await openVirtualSceneModal(fresh.findScene);
      //   } finally {
      //     btn.disabled = false;
      //   }
      // });

      // if (anchor.id === "d18-open-btn") {
      //   anchor.parentNode.insertBefore(btn, anchor);
      // } else {
      //   anchor.appendChild(btn);
      // }

      // console.log(`[${PLUGIN_ID}] Button injected for scene ${scene.id}.`);
      // return true;
    };

    if (!tryInsert()) {
      const deadline = Date.now() + 15000;
      const obs = new MutationObserver(() => {
        if (tryInsert() || Date.now() > deadline) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function onLocationChange() {
    const old = document.getElementById(BUTTON_ID);
    if (old) old.remove();
    const old2 = document.getElementById(BUTTON_ID + "-create");
    if (old2) old2.remove();

    if (!isScenePage()) return;

    // Check if this is a virtual marker scene and redirect if so
    const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
    await maybeHandleVirtualScene(sceneId);

    let scene;
    try {
      const data = await gql(FIND_SCENE, { id: sceneId });
      scene = data.findScene;
    } catch (err) {
      console.error(`[${PLUGIN_ID}] Failed to fetch scene:`, err);
      return;
    }

    if (!scene.groups || scene.groups.length === 0) {
      console.log(`[${PLUGIN_ID}] Scene ${sceneId} has no group - skipping button.`);
      return;
    }

    setTimeout(() => injectButton(scene), 800);
  }

  // ── Tab injection — DOM approach (reliable, no patch.after needed) ────────

  function createVirtualScenesTab() {
    const UI_TAB = document.createElement("div");
    UI_TAB.setAttribute("class", "nav-item");
    UI_TAB.id = "ms-nav-tab";
    UI_TAB.innerHTML = '<a role="tab" data-rb-event-key="virtual-scenes-panel" aria-selected="false" class="nav-link">Virtual Scenes</a>';

    const UI_CONTAINER = document.createElement("div");
    UI_CONTAINER.setAttribute("role", "tabpanel");
    UI_CONTAINER.setAttribute("aria-hidden", "true");
    UI_CONTAINER.setAttribute("class", "fade tab-pane");
    UI_CONTAINER.id = "ms-tab-content";

    function switchTab(activeTab) {
      if (activeTab === UI_TAB) {
        // Deactivate all other tabs
        const allTabs = document.querySelectorAll("div[role='tablist'] > div[class='nav-item'] > a");
        allTabs.forEach(t => t.classList.remove("active"));
        const allPanes = document.querySelectorAll(".tab-content > div");
        allPanes.forEach(p => { p.classList.remove("show"); p.classList.remove("active"); });

        // Show our tab
        UI_TAB.querySelector("a").classList.add("active");
        UI_CONTAINER.classList.add("show");
        UI_CONTAINER.classList.add("active");
      } else {
        UI_TAB.querySelector("a").classList.remove("active");
        UI_CONTAINER.classList.remove("show");
        UI_CONTAINER.classList.remove("active");
      }
    }

    function show(scene) {
      // Build tab content
      UI_CONTAINER.innerHTML = "";
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "padding:1rem;max-width:500px;";

      // We'll update this wrapper reactively
      function render() {
        wrapper.innerHTML = buildTabHTML(scene);
        wireTabButtons(wrapper, scene);
      }

      UI_CONTAINER.appendChild(wrapper);
      render();

      // Insert tab into tablist
      const tabParent = document.querySelector("div[role='tablist']");
      if (tabParent && !document.getElementById("ms-nav-tab")) {
        tabParent.appendChild(UI_TAB);
        // Add click listeners to all tabs
        tabParent.querySelectorAll(".nav-item").forEach(tab => {
          tab.addEventListener("click", () => switchTab(tab));
        });
      }

      // Insert content pane
      const containerParent = document.querySelector(".tab-content");
      if (containerParent && !document.getElementById("ms-tab-content")) {
        containerParent.appendChild(UI_CONTAINER);
      }
    }

    function hide() {
      document.getElementById("ms-nav-tab")?.remove();
      document.getElementById("ms-tab-content")?.remove();
    }

    return { show, hide };
  }

  // Tab state (persists across renders)
  let _tabState = {
    tagId: null,
    scenes: [],
    error: null,
    busy: false,
    initialized: false,
  };

  function resetTabState() {
    _tabState = { tagId: null, scenes: [], error: null, busy: false, initialized: false };
  }

  function formatTabTime(seconds) {
    return formatTime(seconds);
  }

  function buildTabHTML(scene) {
    const nextSceneNum = _tabState.scenes.length + 1;
    const currentTime = Math.floor(getCurrentTimestamp());
    const group = scene.groups?.[0]?.group;

    if (!_tabState.initialized) {
      return '<div style="color:#aaa">Loading...</div>';
    }

    const scenesHtml = _tabState.scenes.length === 0
      ? '<p style="color:#888;margin:0;font-size:13px;">No scenes created yet.</p>'
      : _tabState.scenes.map(s => {
          const url = `/scenes/${scene.id}?t=${s.start}`;
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#2a2a2a;border-radius:4px;margin-bottom:4px;">
              <a href="${url}" data-scene-start="${s.start}" style="color:#6ea8fe;text-decoration:none;font-size:13px;cursor:pointer;" class="ms-scene-link">Scene ${s.index}</a>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="color:#aaa;font-family:monospace;font-size:12px;">${formatTime(s.start)} → ${s.end !== null ? formatTime(s.end) : "?"}</span>
                <button class="ms-delete-btn btn btn-danger" data-scene-index="${s.index}" style="padding:1px 6px;font-size:11px;line-height:1.4;">🗑</button>
              </div>
            </div>`;
        }).join("");

    const errorHtml = _tabState.error
      ? `<div style="background:#3a1a1a;border:1px solid #7a2a2a;border-radius:4px;padding:8px 10px;margin-bottom:12px;font-size:13px;color:#e07a7a;">${_tabState.error}</div>`
      : "";

    return `
      <div style="display:flex;justify-content:space-between;background:#2a2a2a;border-radius:6px;padding:10px;margin-bottom:12px;">
        <div>
          <div style="font-size:11px;color:#888;margin-bottom:2px;">Current timestamp</div>
          <div style="font-size:20px;font-weight:500;font-family:monospace;">${formatTime(currentTime)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:#888;margin-bottom:2px;">Scene to create</div>
          <div style="font-size:20px;font-weight:500;color:#5b9bd5;">Scene ${nextSceneNum}</div>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="font-size:12px;color:#aaa;margin-bottom:6px;font-weight:500;">Scenes created so far</div>
        ${scenesHtml}
      </div>
      <div style="background:#1e3a52;border:1px solid #2d6a9f;border-radius:4px;padding:8px 10px;margin-bottom:12px;font-size:13px;color:#7ab3e0;">
        Scrub to the end of scene ${nextSceneNum}, then click "Mark end of scene ${nextSceneNum}".
      </div>
      ${errorHtml}
      <div style="display:flex;gap:8px;">
        <button id="ms-last-btn" class="btn btn-secondary" style="flex:1;font-size:13px;" ${_tabState.busy ? "disabled" : ""}>
          🏁 This is the last scene
        </button>
        <button id="ms-create-btn" class="btn btn-primary" style="flex:1;font-size:13px;" ${(_tabState.busy || !_tabState.tagId) ? "disabled" : ""}>
          ${_tabState.busy ? "Working..." : `Mark end of scene ${nextSceneNum}`}
        </button>
      </div>
    `;
  }

  function wireTabButtons(wrapper, scene) {
    const createBtn = wrapper.querySelector("#ms-create-btn");
    const lastBtn = wrapper.querySelector("#ms-last-btn");

    async function handleCreate(isLast) {
      if (_tabState.busy) return;
      const endTimestamp = Math.floor(getCurrentTimestamp());
      const sceneIndex = _tabState.scenes.length + 1;
      const group = scene.groups?.[0]?.group;
      const origin = window.location.origin;

      if (!group) { _tabState.error = "Scene has no group."; rerender(); return; }

      // Start of this scene = end of previous scene (or 0 for first scene)
      const startTimestamp = _tabState.scenes.length > 0
        ? _tabState.scenes[_tabState.scenes.length - 1].end
        : 0;

      _tabState.busy = true;
      _tabState.error = null;
      rerender();

      try {
        // Create marker at the START of this scene
        await gql(MARKER_CREATE, {
          input: {
            scene_id: scene.id,
            title: `Scene ${sceneIndex}`,
            seconds: startTimestamp,
            primary_tag_id: _tabState.tagId,
          }
        });

        // Create virtual scene with URL pointing to start of this scene
        const input = {
          title: `${group.name} - Scene ${sceneIndex}`,
          urls: [`${origin}/scenes/${scene.id}?t=${startTimestamp}`],
          organized: false,
          groups: [{ group_id: group.id, scene_index: sceneIndex }],
        };
        if (scene.studio) input.studio_id = scene.studio.id;
        await gql(SCENE_CREATE, { input });

        // On first scene, update original to index 99
        if (sceneIndex === 1) {
          await gql(SCENE_UPDATE, {
            input: {
              id: scene.id,
              groups: [{ group_id: group.id, scene_index: 99 }],
            }
          });
        }

        // Record this scene with its start and end
        _tabState.scenes.push({
          index: sceneIndex,
          start: startTimestamp,
          end: isLast ? (scene.files?.[0]?.duration ?? null) : endTimestamp,
        });

        // If this is the last scene, also create the final scene
        if (isLast) {
          const lastSceneIndex = sceneIndex + 1;
          const lastStart = endTimestamp;
          const lastEnd = scene.files?.[0]?.duration ?? null;

          await gql(MARKER_CREATE, {
            input: {
              scene_id: scene.id,
              title: `Scene ${lastSceneIndex}`,
              seconds: lastStart,
              primary_tag_id: _tabState.tagId,
            }
          });

          const lastInput = {
            title: `${group.name} - Scene ${lastSceneIndex}`,
            urls: [`${origin}/scenes/${scene.id}?t=${lastStart}`],
            organized: false,
            groups: [{ group_id: group.id, scene_index: lastSceneIndex }],
          };
          if (scene.studio) lastInput.studio_id = scene.studio.id;
          await gql(SCENE_CREATE, { input: lastInput });

          _tabState.scenes.push({
            index: lastSceneIndex,
            start: lastStart,
            end: lastEnd,
          });
        }

      } catch (err) {
        _tabState.error = err.message;
      } finally {
        _tabState.busy = false;
        rerender();
      }
    }

    function rerender() {
      wrapper.innerHTML = buildTabHTML(scene);
      wireTabButtons(wrapper, scene);
    }

    if (createBtn) createBtn.addEventListener("click", () => handleCreate(false));
    if (lastBtn) lastBtn.addEventListener("click", () => handleCreate(true));

    // Wire scene links — navigate via React Router
    wrapper.querySelectorAll(".ms-scene-link").forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const history = getReactHistory();
        const href = link.getAttribute("href");
        if (history) history.replace(href);
        else window.location.replace(href);
      });
    });

    // Wire delete buttons
    wrapper.querySelectorAll(".ms-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const sceneIndex = parseInt(btn.dataset.sceneIndex, 10);
        btn.disabled = true;
        btn.textContent = "...";
        await deleteScene(sceneIndex, scene);
        rerender();
      });
    });
  }

  async function initTabState(scene) {
    resetTabState();
    const group = scene.groups?.[0]?.group;

    try {
      // Look up zzz-virtual tag
      const tagData = await gql(FIND_TAG_BY_NAME, { name: "zzz-virtual" });
      const tags = tagData.findTags?.tags ?? [];
      if (tags.length === 0) {
        _tabState.error = 'Tag "zzz-virtual" not found. Please create it in Stash first.';
        _tabState.initialized = true;
        return;
      }
      _tabState.tagId = tags[0].id;

      // Load existing virtual scenes from this group
      if (group) {
        try {
          const groupData = await gql(FIND_GROUP_SCENES, { group_id: [group.id] });
          const allScenes = groupData.findScenes?.scenes ?? [];

          const virtualScenes = allScenes
            .filter(s =>
              s.files.length === 0 &&
              (s.urls || []).some(u => u.match(/\/scenes\/\d+\?t=\d/))
            )
            .sort((a, b) => {
              const aIdx = a.groups?.[0]?.scene_index ?? 999;
              const bIdx = b.groups?.[0]?.scene_index ?? 999;
              return aIdx - bIdx;
            });

          _tabState.scenes = virtualScenes.map((s, i) => {
            const url = (s.urls || []).find(u => u.match(/\/scenes\/\d+\?t=\d/));
            const tMatch = url?.match(/\?t=(\d+)/);
            const start = tMatch ? parseInt(tMatch[1], 10) : 0;
            const nextScene = virtualScenes[i + 1];
            const nextUrl = nextScene
              ? (nextScene.urls || []).find(u => u.match(/\/scenes\/\d+\?t=\d/))
              : null;
            const nextTMatch = nextUrl?.match(/\?t=(\d+)/);
            const end = nextTMatch ? parseInt(nextTMatch[1], 10) : null;

            return {
              index: s.groups?.[0]?.scene_index ?? (i + 1),
              start,
              end,
              sceneId: s.id,
            };
          });
        } catch (groupErr) {
          console.warn(`[marker-scenes] Could not load existing scenes: ${groupErr.message}`);
          // Non-fatal — tab still works, just starts with empty scenes list
        }
      }

    } catch (err) {
      _tabState.error = `Failed to load: ${err.message}`;
    } finally {
      _tabState.initialized = true;
    }
  }

  async function deleteScene(sceneIndex, scene) {
    const existing = _tabState.scenes.find(s => s.index === sceneIndex);
    if (!existing) return;

    try {
      // Find and delete the marker
      const markerTitle = `Scene ${sceneIndex}`;
      const marker = (scene.scene_markers || []).find(m =>
        m.title === markerTitle &&
        m.primary_tag?.name === "zzz-virtual"
      );

      // Re-fetch scene markers if not loaded
      let markerId = marker?.id;
      if (!markerId) {
        const fresh = await gql(FIND_SCENE, { id: scene.id });
        const freshMarker = (fresh.findScene?.scene_markers || []).find(m =>
          m.title === markerTitle &&
          m.primary_tag?.name === "zzz-virtual"
        );
        markerId = freshMarker?.id;
      }

      if (markerId) {
        await gql(SCENE_MARKER_DESTROY, { id: markerId });
      }

      // Delete the virtual scene
      if (existing.sceneId) {
        await gql(SCENE_DESTROY, { id: existing.sceneId });
      }

      // Remove from tab state
      _tabState.scenes = _tabState.scenes.filter(s => s.index !== sceneIndex);

    } catch (err) {
      _tabState.error = `Failed to delete scene ${sceneIndex}: ${err.message}`;
    }
  }

  // Create the tab instance
  const vsTab = createVirtualScenesTab();

  // Location change handler
  async function onLocationChange() {
    vsTab.hide();

    if (!isScenePage()) return;

    await maybeHandleVirtualScene(
      window.location.pathname.match(/^\/scenes\/(\d+)/)[1]
    );

    if (!isScenePage()) return;

    const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
    let scene;
    try {
      const data = await gql(FIND_SCENE, { id: sceneId });
      scene = data.findScene;
    } catch (err) {
      console.error(`[${PLUGIN_ID}] Failed to fetch scene:`, err);
      return;
    }

    // Only show the tab if the scene belongs to a group
    if (!scene.groups || scene.groups.length === 0) {
      console.log(`[${PLUGIN_ID}] Scene has no group — hiding Virtual Scenes tab.`);
      return;
    }

    await initTabState(scene);

    // Wait for React to render the tabs
    const tryShow = () => {
      const tabParent = document.querySelector("div[role='tablist']");
      const tabContent = document.querySelector(".tab-content");
      if (tabParent && tabContent) {
        vsTab.show(scene);
        return true;
      }
      return false;
    };

    if (!tryShow()) {
      const deadline = Date.now() + 10000;
      const obs = new MutationObserver(() => {
        if (tryShow() || Date.now() > deadline) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Start listening
  if (window.PluginApi?.Event) {
    window.PluginApi.Event.addEventListener("stash:location", () => {
      onLocationChange();
      maybeAutoPlay();
    });
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
  maybeAutoPlay();

})();
}
