
// marker-scenes.js
// Stash plugin: creates virtual scenes from scene markers.
// MVP v0.1 — no overwrite detection, no settings UI yet.

(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────────────────────

  const PLUGIN_ID = "marker-scenes";
  const BUTTON_ID = "marker-scenes-btn";

  // ── GraphQL helper ───────────────────────────────────────────────────────────

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

  // ── Queries & mutations ──────────────────────────────────────────────────────

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

  // ── Core logic ───────────────────────────────────────────────────────────────

  /**
   * Given the current scene's data, create one virtual scene per marker.
   * Each virtual scene gets:
   *   - title:      "<Group Name> - Scene <N>"
   *   - url:        "<stash origin>/scenes/<id>?t=<seconds>"
   *   - group:      same group as original, scene_index = marker index (1-based)
   *   - studio:     same studio as original (if any)
   *   - organized:  false (so scrapers will pick them up)
   */
  async function createMarkerScenes(scene) {
    const markers = scene.scene_markers;
    if (!markers || markers.length === 0) {
      alert("This scene has no markers. Add markers first.");
      return;
    }

    // Use the first group only (multi-group support flagged for later)
    const groupEntry = scene.groups[0];
    const group = groupEntry.group;

    // Build the origin URL (e.g. http://your-stash-host-ip:6969)
    const origin = window.location.origin;
    const sceneId = scene.id;

    console.log(
      `[${PLUGIN_ID}] Processing ${markers.length} marker(s) for scene ${sceneId} in group "${group.name}"`
    );

    let created = 0;
    let failed = 0;

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const markerIndex = i + 1; // 1-based
      const title = `${group.name} - Scene ${markerIndex}`;
      const url = `${origin}/scenes/${sceneId}?t=${marker.seconds}`;

      const input = {
        title,
        urls: [url],
        organized: false,
        groups: [
          {
            group_id: group.id,
            scene_index: markerIndex,
          },
        ],
      };

      // Inherit studio if present
      if (scene.studio) {
        input.studio_id = scene.studio.id;
      }

      try {
        const result = await gql(SCENE_CREATE, { input });
        const newScene = result.sceneCreate;
        console.log(
          `[${PLUGIN_ID}] Created scene ${newScene.id}: "${newScene.title}" → ${url}`
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

    const summary = `Done! Created ${created} scene(s).${failed > 0 ? ` ${failed} failed — check the browser console.` : ""}`;
    alert(summary);
    console.log(`[${PLUGIN_ID}] ${summary}`);
  }

  // ── Button ───────────────────────────────────────────────────────────────────

  /**
   * Extract the scene ID from the current URL.
   * Stash scene pages are at /scenes/<id>
   */
  function getSceneIdFromUrl() {
    const match = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Create and return the plugin button element.
   */
  function makeButton(onClick) {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "btn btn-secondary";
    btn.style.marginLeft = "8px";
    btn.textContent = "Split Scene by Markers";
    btn.addEventListener("click", onClick);
    return btn;
  }

  /**
   * Try to inject the button into the scene detail header.
   * Returns true if successful, false if the target container isn't in the DOM yet.
   */
  async function injectButton() {
    // Don't inject twice
    if (document.getElementById(BUTTON_ID)) return true;

    const sceneId = getSceneIdFromUrl();
    if (!sceneId) return false;

    // Stash renders scene action buttons inside .scene-toolbar or similar.
    // We look for the edit button as an anchor point — it's reliably present.
    const editBtn = document.querySelector("a[href$='/edit']");
    if (!editBtn) return false;

    // Fetch scene data to check if it belongs to a group
    let scene;
    try {
      const data = await gql(FIND_SCENE, { id: sceneId });
      scene = data.findScene;
    } catch (err) {
      console.error(`[${PLUGIN_ID}] Failed to fetch scene:`, err);
      return false;
    }

    // Only show the button if the scene belongs to at least one group
    if (!scene.groups || scene.groups.length === 0) {
      console.log(`[${PLUGIN_ID}] Scene ${sceneId} has no group — button hidden.`);
      return true; // done, just don't inject
    }

    const btn = makeButton(async () => {
      btn.disabled = true;
      btn.textContent = "Working…";
      try {
        await createMarkerScenes(scene);
      } finally {
        btn.disabled = false;
        btn.textContent = "Split Scene by Markers";
      }
    });

    // Insert after the edit button
    editBtn.parentNode.insertBefore(btn, editBtn.nextSibling);
    console.log(`[${PLUGIN_ID}] Button injected for scene ${sceneId}.`);
    return true;
  }

  // ── PluginApi registration ───────────────────────────────────────────────────

  /**
   * Wait for PluginApi to be available, then register.
   * Stash v0.25+ exposes window.PluginApi after the app boots.
   */
  function waitForPluginApi(callback, attempts = 0) {
    if (window.PluginApi) {
      callback(window.PluginApi);
    } else if (attempts < 50) {
      setTimeout(() => waitForPluginApi(callback, attempts + 1), 200);
    } else {
      console.error(`[${PLUGIN_ID}] PluginApi never became available.`);
    }
  }

  waitForPluginApi((PluginApi) => {
    console.log(`[${PLUGIN_ID}] PluginApi found, registering...`);

    // Register a React component that Stash mounts on scene detail pages.
    // The component renders null (no visible UI) but triggers our button injection.
    PluginApi.register.route("/scenes/:id", () => {
      // Every time Stash navigates to a scene page, try to inject our button.
      // We poll briefly because React renders async after route change.
      let attempts = 0;
      const poll = setInterval(async () => {
        const done = await injectButton();
        if (done || ++attempts > 20) clearInterval(poll);
      }, 300);

      return null; // we don't render a React component, just side-effect
    });
  });

})();
