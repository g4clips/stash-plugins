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

  function maybeAutoPlay() {
    if (!isScenePage()) return;
    if (!window.location.search.includes("t=")) return;

    console.log(`[${PLUGIN_ID}] Landed on timestamped scene, attempting auto-play...`);

    const tryPlay = () => {
      const player = document.querySelector("video-js")?.player;
      if (!player || player.readyState() === 0) return false;
      player.play().then(() => {
        console.log(`[${PLUGIN_ID}] Auto-play succeeded.`);
      }).catch(err => {
        console.log(`[${PLUGIN_ID}] Auto-play blocked: ${err.message}`);
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

  function removeModal() {
    const existing = document.getElementById("ms-modal-overlay");
    if (existing) existing.remove();
  }

  function renderModal(scene, groupName) {
    removeModal();

    const state = modalState;
    const nextSceneNum = state.scenes.length + 1;
    const currentTime = state.pendingTimestamp !== undefined ? state.pendingTimestamp : getCurrentTimestamp();

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
    if (busy) createBtn.textContent = "Working...";
  }

  async function handleCreateScene(scene, groupName, isLast) {
    setModalBusy(true);

    const timestamp = Math.floor(getCurrentTimestamp());
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

    modalState.pendingTimestamp = getCurrentTimestamp();
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
    modalState.pendingTimestamp = getCurrentTimestamp();

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
        window.location.replace(redirect);
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
      const anchor = document.getElementById("d18-open-btn") ||
                     document.querySelector(".scene-toolbar");
      if (!anchor) return false;

      const btn = document.createElement("button");
      btn.id = BUTTON_ID;
      btn.className = "btn btn-primary";
      btn.textContent = "Virtual scenes";
      btn.style.cssText = "margin-left:8px;font-size:.85rem;";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
          const fresh = await gql(FIND_SCENE, { id: sceneId });
          await openVirtualSceneModal(fresh.findScene);
        } finally {
          btn.disabled = false;
        }
      });

      if (anchor.id === "d18-open-btn") {
        anchor.parentNode.insertBefore(btn, anchor);
      } else {
        anchor.appendChild(btn);
      }

      console.log(`[${PLUGIN_ID}] Button injected for scene ${scene.id}.`);
      return true;
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

  function startListening() {
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
  }

  // Wait for PluginApi then start
  function waitForPluginApi(callback, attempts = 0) {
    if (window.PluginApi) {
      callback();
    } else if (attempts < 50) {
      setTimeout(() => waitForPluginApi(callback, attempts + 1), 200);
    } else {
      console.error(`[${PLUGIN_ID}] PluginApi never became available.`);
    }
  }

  waitForPluginApi(() => {
    console.log(`[${PLUGIN_ID}] PluginApi found, starting...`);
    startListening();
  });

})();
}
