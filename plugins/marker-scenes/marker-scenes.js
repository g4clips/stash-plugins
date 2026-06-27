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

  // If this is a virtual marker scene (no files, has a ?t= URL), redirect to the original scene
  async function maybeRedirectVirtualScene(sceneId) {
    let data;
    try {
      data = await gql(FIND_SCENE, { id: sceneId });
    } catch (err) {
      return;
    }
    const scene = data.findScene;
    if (scene.files && scene.files.length > 0) return; // has a real file, not virtual
    const markerUrl = (scene.urls || []).find(u => u.match(/\/scenes\/\d+\?t=\d/));
    if (!markerUrl) return;

    // Extract the path+query from the full URL so it works on any host
    const target = new URL(markerUrl);
    const redirect = target.pathname + target.search;
    console.log(`[${PLUGIN_ID}] Virtual scene detected, redirecting to ${redirect}`);
    window.location.replace(redirect);
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
    await maybeRedirectVirtualScene(sceneId);

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
