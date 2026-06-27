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

  function makeButton(onClick) {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "btn btn-secondary";
    btn.style.marginLeft = "8px";
    btn.textContent = "Split Scene by Markers";
    btn.addEventListener("click", onClick);
    return btn;
  }

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

    PluginApi.register.component("ScenePage.Tabs", ({ scene }) => {
      console.log(`[${PLUGIN_ID}] ScenePage.Tabs fired, scene id=${scene?.id}`);

      if (!scene || !scene.groups || scene.groups.length === 0) {
        console.log(`[${PLUGIN_ID}] Scene has no group - skipping button.`);
        return null;
      }

      const existing = document.getElementById(BUTTON_ID);
      if (existing) existing.remove();

      setTimeout(() => {
        const editBtn = document.querySelector("a[href$='/edit']");
        if (!editBtn) {
          console.log(`[${PLUGIN_ID}] Edit button not found in DOM yet.`);
          return;
        }

        const btn = makeButton(async () => {
          btn.disabled = true;
          btn.textContent = "Working...";
          try {
            await createMarkerScenes(scene);
          } finally {
            btn.disabled = false;
            btn.textContent = "Split Scene by Markers";
          }
        });

        editBtn.parentNode.insertBefore(btn, editBtn.nextSibling);
        console.log(`[${PLUGIN_ID}] Button injected for scene ${scene.id}.`);
      }, 500);

      return null;
    });
  });

})();
}
