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
    const video = document.querySelector("video.vjs-tech");
    return video ? Math.floor(video.currentTime) : 0;
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

    const overlay = document.createElement("div");
    overlay.id = "ms-modal-overlay";
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
    `;

    const scenesHtml = state.scenes.length === 0
      ? `<p style="font-size:13px;color:var(--text-muted);margin:0;">No scenes created yet.</p>`
      : state.scenes.map(s => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--surface-1);border-radius:var(--radius);border:0.5px solid var(--border);">
            <span style="font-size:13px;color:var(--text-primary);">Scene ${s.index}</span>
            <span style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${formatTime(s.start)} → ${s.end !== null ? formatTime(s.end) : "?"}</span>
          </div>
        `).join("");

    overlay.innerHTML = `
      <div style="background:var(--surface-2);border-radius:12px;border:0.5px solid var(--border);width:480px;max-width:calc(100vw - 2rem);overflow:hidden;">

        <div style="padding:1.25rem 1.5rem;border-bottom:0.5px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <div>
            <p style="margin:0;font-size:15px;font-weight:500;color:var(--text-primary);">Create virtual scene</p>
            <p style="margin:0;font-size:13px;color:var(--text-muted);">${groupName}</p>
          </div>
          <button id="ms-close" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:20px;padding:4px;">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>

        <div style="padding:1.25rem 1.5rem;">

          <div style="background:var(--surface-1);border-radius:var(--radius);border:0.5px solid var(--border);padding:1rem;margin-bottom:1.25rem;display:flex;align-items:center;justify-content:space-between;">
            <div>
              <p style="margin:0 0 2px;font-size:12px;color:var(--text-muted);">Current timestamp</p>
              <p style="margin:0;font-size:22px;font-weight:500;color:var(--text-primary);font-family:var(--font-mono);">${formatTime(currentTime)}</p>
            </div>
            <div style="text-align:right;">
              <p style="margin:0 0 2px;font-size:12px;color:var(--text-muted);">Scene to create</p>
              <p style="margin:0;font-size:22px;font-weight:500;color:var(--text-accent);">Scene ${nextSceneNum}</p>
            </div>
          </div>

          <div style="margin-bottom:1.25rem;">
            <p style="margin:0 0 6px;font-size:13px;color:var(--text-secondary);font-weight:500;">Scenes created so far</p>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${scenesHtml}
            </div>
          </div>

          <div style="background:var(--bg-accent);border:0.5px solid var(--border-accent);border-radius:var(--radius);padding:10px 12px;margin-bottom:1.25rem;display:flex;align-items:center;gap:8px;">
            <i class="ti ti-info-circle" style="font-size:16px;color:var(--text-accent);" aria-hidden="true"></i>
            <p style="margin:0;font-size:13px;color:var(--text-accent);">Scrub to the start of scene ${nextSceneNum}, then click "Create scene ${nextSceneNum}".</p>
          </div>

          <div id="ms-error" style="display:none;background:var(--bg-danger);border:0.5px solid var(--border-danger);border-radius:var(--radius);padding:10px 12px;margin-bottom:1.25rem;">
            <p style="margin:0;font-size:13px;color:var(--text-danger);"></p>
          </div>

          <div style="display:flex;gap:8px;">
            <button id="ms-last" style="flex:1;padding:10px;font-size:14px;border-radius:var(--radius);border:0.5px solid var(--border-strong);background:var(--surface-1);color:var(--text-primary);cursor:pointer;">
              <i class="ti ti-flag" style="font-size:15px;vertical-align:-2px;margin-right:6px;" aria-hidden="true"></i>
              This is the last scene
            </button>
            <button id="ms-create" style="flex:1;padding:10px;font-size:14px;border-radius:var(--radius);border:0.5px solid var(--border-accent);background:var(--bg-accent);color:var(--text-accent);cursor:pointer;font-weight:500;">
              <i class="ti ti-plus" style="font-size:15px;vertical-align:-2px;margin-right:6px;" aria-hidden="true"></i>
              Create scene ${nextSceneNum}
            </button>
          </div>

        </div>
      </div>
    `;

    document.body.appendChild(overlay);

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
    errorDiv.style.display = "flex";
    errorDiv.style.alignItems = "center";
    errorDiv.style.gap = "8px";
    errorDiv.innerHTML = `
      <i class="ti ti-alert-circle" style="font-size:16px;color:var(--text-danger);flex-shrink:0;" aria-hidden="true"></i>
      <p style="margin:0;font-size:13px;color:var(--text-danger);">${message}</p>
    `;
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
      const target =
        document.querySelector(".scene-toolbar") ||
        document.querySelector(".details-edit .buttons-container") ||
        document.querySelector(".scene-header .d-flex") ||
        document.querySelector(".VideoPlayer");
      if (!target) return false;

      const btn = document.createElement("button");
      btn.id = BUTTON_ID;
      btn.className = "btn btn-secondary";
      btn.textContent = "Split Scene by Markers";
      btn.style.cssText = "margin-left:8px;font-size:.85rem;";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Working...";
        try {
          const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
          const fresh = await gql(FIND_SCENE, { id: sceneId });
          await createMarkerScenes(fresh.findScene);
        } finally {
          btn.disabled = false;
          btn.textContent = "Split Scene by Markers";
        }
      });

      target.appendChild(btn);

      const btn2 = document.createElement("button");
      btn2.id = BUTTON_ID + "-create";
      btn2.className = "btn btn-primary";
      btn2.textContent = "Create virtual scene";
      btn2.style.cssText = "margin-left:8px;font-size:.85rem;";
      btn2.addEventListener("click", async () => {
        btn2.disabled = true;
        try {
          const sceneId = window.location.pathname.match(/^\/scenes\/(\d+)/)[1];
          const fresh = await gql(FIND_SCENE, { id: sceneId });
          await openVirtualSceneModal(fresh.findScene);
        } finally {
          btn2.disabled = false;
        }
      });
      target.appendChild(btn2);

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
