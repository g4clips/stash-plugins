# Stash Plugin Development Guide
## Lessons Learned Building marker-scenes v1.0.0

---

## 1. Plugin Structure

Every Stash plugin needs two files in a subfolder under `plugins/`:

```
plugins/
  my-plugin/
    my-plugin.yml
    my-plugin.js
```

### `plugin.yml` minimum viable config:
```yaml
name: My Plugin
description: What it does.
version: 1.0.0
url: ""

ui:
  javascript:
    - my-plugin.js
```

The JS file is loaded into every Stash page automatically once the plugin is installed.

---

## 2. PluginApi — The Right Way to Hook Into Stash

Stash v0.25+ exposes `window.PluginApi` after the React app boots. Always wait for it:

```javascript
function waitForPluginApi(callback, attempts = 0) {
  if (window.PluginApi) {
    callback(window.PluginApi);
  } else if (attempts < 50) {
    setTimeout(() => waitForPluginApi(callback, attempts + 1), 200);
  } else {
    console.error("PluginApi never became available.");
  }
}

waitForPluginApi((PluginApi) => {
  // safe to use PluginApi here
});
```

### What's available on PluginApi:
```javascript
PluginApi.React              // React itself
PluginApi.libraries.Bootstrap // { Nav, Tab, Button, Modal, ... }
PluginApi.libraries.FontAwesomeSolid // icon library
PluginApi.components         // Stash shared components (Icon, etc.)
PluginApi.patch              // { before, after, instead } — hook into existing components
PluginApi.register           // { component, route } — register new components (see caveats)
PluginApi.Event              // event bus (stash:location, etc.)
PluginApi.utils.NavUtils     // URL builders (makeSceneMarkerUrl, etc.)
PluginApi.utils.StashService // GraphQL query/mutation helpers
PluginApi.GQL                // All GraphQL document nodes
```

---

## 3. patch.after vs register.component

### ❌ DO NOT use `register.component` for existing Stash components
```javascript
// THIS CAUSES "Component already registered" ERROR
PluginApi.register.component("ScenePage.Tabs", () => null);
```

### ✅ USE `patch.after` to extend existing components
```javascript
PluginApi.patch.after("ScenePage.Tabs", function({ children, ...props }) {
  // props contains: scene, setTimestamp, queueScenes, etc.
  const newElement = React.createElement(...);
  return [...React.Children.toArray(children), newElement];
});
```

`patch.after` receives the component's props and the rendered children, and returns the new children. It does NOT cause double-registration errors.

Available patchable components on the scene page:
- `ScenePage.Tabs` — the nav tab bar
- `ScenePage.TabContent` — the tab pane area  
- `ScenePage` — the full scene page
- `ScenePlayer` — the video player
- `SceneFileInfoPanel` — file info tab content

---

## 4. Adding a Tab to the Scene Page

The correct approach uses Bootstrap's `Nav.Link` + `Tab.Pane` with matching `eventKey` values so Bootstrap's own tab state machine manages activation:

```javascript
const { React } = PluginApi;
const { Nav, Tab } = PluginApi.libraries.Bootstrap;

// Add the nav tab
PluginApi.patch.after("ScenePage.Tabs", function({ children, ...props }) {
  const newTab = React.createElement(Nav.Item, null,
    React.createElement(Nav.Link, { eventKey: "my-panel" }, "My Tab")
  );
  return [...React.Children.toArray(children), newTab];
});

// Add the tab content
PluginApi.patch.after("ScenePage.TabContent", function({ children, ...props }) {
  const scene = props.scene; // full scene object available here
  const newPane = React.createElement(Tab.Pane, { eventKey: "my-panel" },
    React.createElement(MyComponent, { scene })
  );
  return [...React.Children.toArray(children), newPane];
});
```

### ❌ DO NOT use DOM manipulation to add tabs
Manually injecting `<li>/<a>` elements and managing `.active` classes via DOM doesn't work because Bootstrap's tab system is controlled by React state (`activeTabKey`). React re-renders will overwrite any DOM changes.

### ❌ DO NOT try to deactivate Bootstrap tabs via DOM
```javascript
// THIS DOESN'T WORK — React re-renders restore the class
activeTab.classList.remove("active");
```

---

## 5. What Props Are Available in Patch Callbacks

Both `ScenePage.Tabs` and `ScenePage.TabContent` receive these props:
```javascript
{
  scene,              // Full GQL.SceneDataFragment
  setTimestamp,       // (seconds: number) => void — seeks the video player
  queueScenes,        // QueuedScene[]
  queueStart,         // number
  onDelete,           // () => void
  onQueueNext,        // () => void
  onQueuePrevious,    // () => void
  onQueueRandom,      // () => void
  onQueueSceneClicked,// (sceneID: string) => void
  continuePlaylist,   // boolean
  queueHasMoreScenes, // boolean
  onQueueMoreScenes,  // () => void
  onQueueLessScenes,  // () => void
  collapsed,          // boolean
  setCollapsed,       // (state: boolean) => void
  setContinuePlaylist // (value: boolean) => void
}
```

`setTimestamp` is particularly useful — it seeks the video player to a timestamp without navigating away.

---

## 6. Reading the Video Player Timestamp

### ❌ DO NOT use the raw video element
```javascript
document.querySelector("video.vjs-tech")?.currentTime
// Returns wrong values (position within current buffer, not real time)
```

### ✅ USE the Video.js player instance
```javascript
document.querySelector("video-js")?.player?.currentTime()
// Returns accurate timestamp in seconds (e.g. 2247.35 for 37:27)
```

---

## 7. Client-Side Navigation (React Router)

### ❌ DO NOT use window.location.replace()
```javascript
window.location.replace("/scenes/123?t=456");
// Causes full page reload — breaks Stash's player initialization
// Video loads but never plays (readyState stays 0)
```

### ❌ DO NOT create new anchor elements and click them
```javascript
const a = document.createElement("a");
a.href = "/scenes/123?t=456";
a.click();
// React Router doesn't intercept dynamically created anchors
```

### ✅ USE React Router's history object from the fiber tree
```javascript
function getReactHistory() {
  const root = document.querySelector('#root');
  if (!root) return null;
  const fiber = root._reactRootContainer?._internalRoot?.current;
  if (!fiber) return null;

  let history = null;
  const walk = (node, depth = 0) => {
    if (!node || depth > 100 || history) return;
    try {
      if (node.memoizedProps?.history?.replace && 
          typeof node.memoizedProps.history.replace === 'function') {
        history = node.memoizedProps.history;
      }
    } catch(e) {}
    walk(node.child, depth + 1);
    walk(node.sibling, depth + 1);
  };
  walk(fiber);
  return history;
}

// Use it:
const history = getReactHistory();
if (history) {
  history.replace("/scenes/123?t=456");
} else {
  window.location.replace("/scenes/123?t=456"); // fallback
}
```

This triggers a true client-side navigation identical to clicking a React Router `<Link>`.

---

## 8. Stash's ?t= Parameter and Autoplay

When navigating to `/scenes/123?t=456`, Stash's `SceneLoader` reads `t` as `initialTimestamp`. In `ScenePlayer.tsx`:

```typescript
auto.current =
  autoplay ||
  buttonEnabled ||
  (interfaceConfig?.autostartVideo ?? false) ||
  _initialTimestamp > 0;  // ← this is what triggers autoplay
```

**Key insight:** If `t > 0`, autoplay is triggered automatically by Stash's own code. You do NOT need to call `player.play()` manually. Calling `player.load()` or `player.play()` yourself will INTERRUPT Stash's initialization and cause a black screen.

The correct approach is:
1. Navigate via `history.replace("/scenes/123?t=456")`
2. Do nothing else — Stash handles the rest

---

## 9. GraphQL in Plugins

Use a simple fetch wrapper:

```javascript
async function gql(query, variables = {}) {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}
```

### Creating a fileless virtual scene:
```javascript
const SCENE_CREATE = `
  mutation SceneCreate($input: SceneCreateInput!) {
    sceneCreate(input: $input) {
      id title urls
      groups { group { id name } scene_index }
    }
  }
`;

await gql(SCENE_CREATE, {
  input: {
    title: "Group Name - Scene 1",
    urls: ["http://localhost:9999/scenes/2013?t=219"],
    organized: false,
    groups: [{ group_id: "1", scene_index: 1 }],
    studio_id: "5", // optional
  }
});
```

Note: `file_ids` cannot be used if the file already belongs to another scene as a primary file. Fileless scenes work fine for metadata purposes.

---

## 10. Button Injection (DOM approach, for non-tab UI)

When you need to add a button to the scene toolbar (not a tab), use the `stash:location` event pattern from existing plugins like Data18:

```javascript
function isScenePage() {
  return /^\/scenes\/\d+/.test(window.location.pathname);
}

function injectButton(scene) {
  if (!isScenePage() || document.getElementById("my-btn")) return;

  const tryInsert = () => {
    // Use an existing button as anchor point
    const anchor = document.getElementById("d18-open-btn") ||
                   document.querySelector(".scene-toolbar");
    if (!anchor) return false;

    const btn = document.createElement("button");
    btn.id = "my-btn";
    btn.className = "btn btn-primary";
    btn.textContent = "My Button";
    btn.style.cssText = "margin-left:8px;font-size:.85rem;";
    btn.addEventListener("click", () => { /* handler */ });

    if (anchor.id === "d18-open-btn") {
      anchor.parentNode.insertBefore(btn, anchor);
    } else {
      anchor.appendChild(btn);
    }
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

function startListening() {
  if (window.PluginApi?.Event) {
    window.PluginApi.Event.addEventListener("stash:location", onLocationChange);
  } else {
    // polling fallback
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
```

### ❌ DO NOT use PluginApi.register.route for button injection
```javascript
// THIS DOES NOT WORK for button injection
PluginApi.register.route("/scenes/:id", () => null);
```

---

## 11. Avoiding Double-Registration

If a plugin JS file might be loaded twice, guard it:

```javascript
if (window._myPluginLoaded) {
  console.log("Already loaded, skipping.");
} else {
  window._myPluginLoaded = true;
  // plugin code
}
```

### ❌ DO NOT register the same component twice
Stash throws "Component already registered" if `PluginApi.register.component` is called for a component that's already registered (either by Stash itself or a previous load of your plugin).

`patch.after` does NOT have this problem — multiple patches on the same component are chained.

---

## 12. Deployment via GitHub Pages

The repo uses a `deploy.yml` GitHub Action that:
1. Runs `build_site.sh _site` on every push to `main`
2. Deploys the generated `index.yml` to GitHub Pages

**Every push to `main` auto-deploys.** No manual steps needed.

Plugin source URL for Stash:
```
https://g4clips.github.io/stash-plugins/index.yml
```

---

## 13. Development Workflow (Recommended)

1. **Tag stable states:** `git tag v1.0.0-stable` before starting new features
2. **Use feature branches:** `git checkout -b feature/my-feature`
3. **Cherry-pick specific fixes:** `git cherry-pick <commit-hash>` to apply individual fixes without merging everything
4. **Bump versions consistently:** patch (x.x.X) for fixes, minor (x.X.0) for features, major (X.0.0) for breaking changes
5. **Test in browser console first:** Paste JS directly into the console to verify behavior before committing
6. **Read source code:** Clone `stashapp/stash` and `stashapp/CommunityScripts` for reference:
   ```
   git clone https://github.com/stashapp/stash.git --depth 1
   git clone https://github.com/stashapp/CommunityScripts.git --depth 1
   ```

Key source files to reference:
- `ui/v2.5/src/components/Scenes/SceneDetails/Scene.tsx` — scene page tabs, toolbar
- `ui/v2.5/src/components/ScenePlayer/ScenePlayer.tsx` — player initialization, autoplay, ?t= handling
- `CommunityScripts/plugins/stashNotes/stashNotes.js` — clean example of patch.before on navbar
- `CommunityScripts/plugins/scenePageRememberStates/scenePageRememberStates.js` — tab navigation patterns

---

## 14. CSS and Theming

Stash CSS variables (`var(--surface-2)`, `var(--text-primary)`, etc.) are scoped to child elements of Stash's React tree, NOT to `document.documentElement`. They will not resolve in dynamically injected DOM elements.

### ✅ Use hardcoded dark theme colors for injected UI:
```javascript
// Works reliably in injected elements
background: "#1a1a1a"
border: "1px solid #444"
color: "#eee"
```

### ✅ Use Bootstrap classes for buttons (always available globally):
```javascript
btn.className = "btn btn-primary";   // blue
btn.className = "btn btn-secondary"; // grey
```

### ✅ In React components rendered via patch.after, CSS vars DO work
because the component is inside Stash's React tree.

---

## 15. Local Dev Sync — Getting Code From This Repo Onto a Running Stash

Every plugin in this repo uses the same deployment model — there used to
be a second, manual-copy (robocopy) model, retired for the reason
described at the bottom of this section.

### Model B: GitHub Pages Install/Update

Used by: SuperScrape, tag-helper (TagChips), IWantClipsStashDB,
ManyVidsStashDB, Data18StashDB, marker-scenes, seek-controls,
FindDuplicates, submit-to-my-stashbox.

These were installed in Stash via **Settings → Plugins → Available
Plugins → Add Source**, pointing at
`https://g4clips.github.io/stash-plugins/index.yml` (built by
`.github/workflows/deploy.yml` on every push to `main`, see §12). Their
deployed copy is pinned to whatever commit was `HEAD` on `main` the last
time someone clicked **Update** on that plugin in Stash's Plugins
settings — **pushing to `main` alone does not update a running
instance**; the update still has to be manually triggered per plugin (or
via "Update All").

You can tell which commit a deployed copy is pinned to two ways:
- The version string reported by `{ plugins { id version } }` is suffixed
  with a short commit hash, e.g. `3.2.0-945e885`.
- The plugin's deployed folder has a `manifest` file (written by Stash,
  not part of this repo) recording `version`, `date`, and
  `source_repository`.

To get a change live for any plugin:
1. Commit and push to `main` (triggers the GitHub Action, which
   republishes `index.yml` — usually within a minute or two; check the
   Actions tab if unsure).
2. In Stash: **Settings → Plugins → Available Plugins**, find the
   plugin, click **Update** (or **Update All**).
3. Confirm via `{ plugins { id version } }` that the commit-hash suffix
   now matches your new `HEAD`.

**Verify a deploy actually landed — don't just trust that a push or an
Update click worked:**

```graphql
{ plugins { id version } }
```

Confirm the reported version matches the plugin's `.yml` AND carries the
commit-hash suffix you expect, and re-run any "live" test through
`runPluginTask` (the same mutation each plugin's own JS uses) rather than
a direct Python import/function call — that's the only way to actually
exercise the deployed subprocess instead of the git checkout.

### Why there's only one model now

SuperScrape, IWC, ManyVids, and tag-helper (TagChips) were originally
deployed via a manual robocopy to
`C:\Users\<you>\.stash\plugins\<PluginFolder>` instead of the GitHub
Pages pipeline. This bit us for real: an entire adapter (SuperScrape's
goddesssnow.com support) was built, tested, and reported "verified live"
across a full session without ever being copied to the live plugins
directory — the instance kept running the pre-existing version the whole
time, and every "live" test that session was actually exercising the git
checkout directly (`import` + direct function calls), never the deployed
plugin. The verification discipline above (checking `{ plugins { id
version } }` before trusting any "live" test) catches this class of
mistake regardless of deploy model — but having only one model in the
first place removes an entire way to get it wrong, which is why manual
copy is retired rather than kept as a documented second option.
