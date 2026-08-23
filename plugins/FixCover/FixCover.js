// FixCover
// Adds "Set Cover to First Frame" to the scene page's ⋮ operations menu, and
// "Set Cover to First Frame (Bulk)" to the scene list's multi-select actions
// menu. Both call Stash's screenshot-generation mutation at time 0, which
// overwrites the scene's cover with the actual first frame instead of the
// ~20%-into-the-video frame Stash picks by default.
//
// Status: verified live against 192.168.4.100:6969. Schema introspection,
// the single-scene menu item, and the bulk menu item were all exercised
// end-to-end (mutation call -> screenshot regenerated -> UI toast), and the
// resulting screenshot timestamp change was independently confirmed via a
// direct GraphQL query. See README.md for the full verification log.
//
// Notable things confirmed live (not guessed):
//   - The screenshot mutation's name/args are discovered at runtime via
//     GraphQL introspection (discoverScreenshotMutation below), not
//     hardcoded. Confirmed live: sceneGenerateScreenshot(id: ID!, at: Float): String!
//   - Its return type is String! (not Boolean) but the mutation is in fact
//     synchronous — see waitForJob's comment for what that means for the
//     async-detection logic.
//   - "at": 0 means "the very first frame" whether the schema treats it as
//     seconds or a fraction, so there was nothing to test on that front.
//   - sceneGenerateScreenshot does NOT validate the scene id server-side —
//     calling it with a nonexistent id still returns "todo" successfully,
//     no error. So the bulk action's per-scene try/catch and failure
//     summary are real, tested code paths, but in practice they'll only
//     ever fire on a genuine network/GraphQL-transport error, not a bad
//     scene id — Stash itself won't complain about one.

(function () {
  const PLUGIN_ID = "FixCover";

  // ---------------------------------------------------------------------
  // GraphQL helper (same-origin, credentials included — standard pattern
  // used by every plugin in this repo)
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
  // Toasts — brief inline status messages, not a modal (single-action
  // utility). Stack in the bottom-right corner; each auto-dismisses unless
  // it's a bulk-progress toast, which the caller updates in place and
  // dismisses itself when the batch finishes.
  // ---------------------------------------------------------------------
  function ensureToastStack() {
    let stack = document.getElementById("fc-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "fc-toast-stack";
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showToast(kind, title, body, autoDismissMs) {
    const stack = ensureToastStack();
    const el = document.createElement("div");
    el.className = `fc-toast fc-toast-${kind}`;
    el.innerHTML = `
      <div class="fc-toast-title"></div>
      <div class="fc-toast-body"></div>
    `;
    el.querySelector(".fc-toast-title").textContent = title;
    el.querySelector(".fc-toast-body").textContent = body || "";
    stack.appendChild(el);
    if (autoDismissMs) {
      setTimeout(() => el.remove(), autoDismissMs);
    }
    return el;
  }

  // A toast with a progress bar the caller can update via update(done, total, extraBody)
  function showProgressToast(title) {
    const stack = ensureToastStack();
    const el = document.createElement("div");
    el.className = "fc-toast fc-toast-info";
    el.innerHTML = `
      <div class="fc-toast-title"></div>
      <div class="fc-toast-body"></div>
      <div class="fc-toast-progress-track"><div class="fc-toast-progress-fill" style="width:0%"></div></div>
    `;
    el.querySelector(".fc-toast-title").textContent = title;
    stack.appendChild(el);
    return {
      update(done, total, extraBody) {
        el.querySelector(".fc-toast-body").textContent = `${done} / ${total} done${extraBody ? " — " + extraBody : ""}`;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        el.querySelector(".fc-toast-progress-fill").style.width = pct + "%";
      },
      finish(kind, title2, body2, autoDismissMs) {
        el.className = `fc-toast fc-toast-${kind}`;
        el.querySelector(".fc-toast-title").textContent = title2;
        el.querySelector(".fc-toast-body").textContent = body2 || "";
        const track = el.querySelector(".fc-toast-progress-track");
        if (track) track.remove();
        if (autoDismissMs) setTimeout(() => el.remove(), autoDismissMs);
      },
      remove() {
        el.remove();
      },
    };
  }

  // ---------------------------------------------------------------------
  // Screenshot-mutation discovery. Introspects the live schema once and
  // caches the result for the rest of the page session — every subsequent
  // call (single or bulk) reuses it instead of re-introspecting.
  // ---------------------------------------------------------------------
  let cachedMutationInfo = null;
  let discoveryPromise = null;

  const TYPE_FRAGMENT = `
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name }
      }
    }
  `;

  async function discoverScreenshotMutation() {
    if (cachedMutationInfo) return cachedMutationInfo;
    if (discoveryPromise) return discoveryPromise;

    discoveryPromise = (async () => {
      const data = await gql(`
        query FixCoverIntrospectMutations {
          __schema {
            mutationType {
              fields {
                name
                args {
                  name
                  type { ${TYPE_FRAGMENT} }
                }
                type { ${TYPE_FRAGMENT} }
              }
            }
          }
        }
      `);
      const fields = (data.__schema.mutationType && data.__schema.mutationType.fields) || [];
      const candidates = fields.filter((f) => /screenshot|cover/i.test(f.name));
      if (candidates.length === 0) {
        throw new Error(
          "No mutation matching /screenshot|cover/i was found on this Stash instance's " +
            "GraphQL schema. FixCover cannot proceed without it — check the schema manually " +
            "(Settings > this instance's GraphQL playground, or the introspection query in " +
            "README.md) and report back so this plugin can be updated."
        );
      }
      // Prefer the exact name we expect if present; otherwise take the first match.
      const preferred =
        candidates.find((f) => f.name === "sceneGenerateScreenshot") || candidates[0];

      const idArg = preferred.args.find((a) => a.name === "id");
      const atArg = preferred.args.find((a) => /^(at|time|seconds|frame|position)$/i.test(a.name));
      if (!idArg) {
        throw new Error(
          `Mutation "${preferred.name}" has no "id" argument — cannot target a specific scene.`
        );
      }

      // Return type: Boolean-ish => synchronous; anything else (ID/String,
      // typically the job id) => async, needs findJob polling.
      function unwrapType(t) {
        let cur = t;
        while (cur && cur.kind === "NON_NULL") cur = cur.ofType;
        return cur;
      }
      const returnType = unwrapType(preferred.type);
      const isAsync = !(returnType && returnType.name === "Boolean");

      cachedMutationInfo = {
        name: preferred.name,
        idArgName: idArg.name,
        atArgName: atArg ? atArg.name : null,
        isAsync,
      };
      return cachedMutationInfo;
    })();

    try {
      return await discoveryPromise;
    } finally {
      discoveryPromise = null;
    }
  }

  // ---------------------------------------------------------------------
  // Job polling — same findJob pattern as Data18StashDB_v2.js /
  // SuperScrape.js / ManyVidsStashDB.js / submit-to-my-stashbox.
  //
  // Confirmed live against our dev instance: sceneGenerateScreenshot's
  // return type is String! (not Boolean), which our earlier
  // Boolean-return-means-sync heuristic misread as "async, needs
  // polling". In practice it returns the literal string "todo" — not a
  // job id — jobQueue stays empty, and the scene's screenshot is already
  // updated by the time the mutation resolves. So: check findJob
  // immediately, with no upfront sleep. If no matching job exists, the
  // work was already synchronous — return right away instead of forcing
  // a wasted ~1s wait per scene (which would add up fast in the bulk
  // case). Only fall into the polling loop if a real job is found.
  // ---------------------------------------------------------------------
  async function waitForJob(jobId, { intervalMs = 1000, maxTries = 120 } = {}) {
    let job;
    try {
      const jd = await gql(
        `query FixCoverFindJob($input: FindJobInput!) { findJob(input: $input) { id status } }`,
        { input: { id: jobId } }
      );
      job = jd.findJob;
    } catch (e) {
      return; // schema doesn't support findJob for this job id shape — treat as done
    }
    if (!job) return; // no such job — mutation was already synchronous
    if (job.status === "FINISHED") return;
    if (job.status === "FAILED" || job.status === "CANCELLED") {
      throw new Error(`Screenshot job ${job.status.toLowerCase()}`);
    }
    for (let i = 0; i < maxTries; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const jd = await gql(
          `query FixCoverFindJob($input: FindJobInput!) { findJob(input: $input) { id status } }`,
          { input: { id: jobId } }
        );
        job = jd.findJob;
      } catch (e) {
        break;
      }
      if (!job) break;
      if (job.status === "FINISHED") return;
      if (job.status === "FAILED" || job.status === "CANCELLED") {
        throw new Error(`Screenshot job ${job.status.toLowerCase()}`);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Core action: regenerate a scene's cover from time 0.
  // ---------------------------------------------------------------------
  async function setCoverToFirstFrame(sceneId) {
    const info = await discoverScreenshotMutation();
    const argDefs = [`$${info.idArgName}: ID!`];
    const argUses = [`${info.idArgName}: $${info.idArgName}`];
    const variables = { [info.idArgName]: sceneId };
    if (info.atArgName) {
      argDefs.push(`$${info.atArgName}: Float`);
      argUses.push(`${info.atArgName}: $${info.atArgName}`);
      variables[info.atArgName] = 0;
    }
    const mutation = `
      mutation FixCoverGenerateScreenshot(${argDefs.join(", ")}) {
        ${info.name}(${argUses.join(", ")})
      }
    `;
    const result = await gql(mutation, variables);
    if (info.isAsync) {
      const jobId = result[info.name];
      if (jobId) await waitForJob(jobId);
    }
  }

  // ---------------------------------------------------------------------
  // Single-scene action, wired to the scene page's ⋮ menu item.
  // ---------------------------------------------------------------------
  async function handleSingleSceneClick(sceneId) {
    const toast = showToast("info", "Setting cover…", "Regenerating from the first frame.");
    try {
      await setCoverToFirstFrame(sceneId);
      toast.remove();
      showToast("ok", "Cover updated", "Scene cover set to first frame.", 4000);
    } catch (e) {
      toast.remove();
      showToast("err", "Failed to set cover", e.message || String(e), 8000);
    }
  }

  // ---------------------------------------------------------------------
  // Bulk action, wired to the scene list's multi-select menu item.
  // Runs sequentially so the progress readout is meaningful and so one
  // slow/failing scene doesn't pile up concurrent requests; a single
  // scene's failure is recorded and the batch continues.
  // ---------------------------------------------------------------------
  async function handleBulkClick(sceneIds) {
    if (!sceneIds || sceneIds.length === 0) {
      showToast("err", "Nothing selected", "Select at least one scene first.", 4000);
      return;
    }
    const progress = showProgressToast("Setting covers (bulk)…");
    const failures = [];
    let done = 0;
    progress.update(done, sceneIds.length);
    for (const id of sceneIds) {
      try {
        await setCoverToFirstFrame(id);
      } catch (e) {
        failures.push({ id, message: e.message || String(e) });
      }
      done++;
      progress.update(done, sceneIds.length);
    }
    if (failures.length === 0) {
      progress.finish("ok", "Done", `Set cover to first frame on ${sceneIds.length} scene(s).`, 6000);
    } else {
      const lines = failures.slice(0, 10).map((f) => `Scene ${f.id}: ${f.message}`);
      if (failures.length > 10) lines.push(`…and ${failures.length - 10} more`);
      progress.finish(
        "err",
        `Done with ${failures.length} failure(s)`,
        `${sceneIds.length - failures.length} succeeded.\n${lines.join("\n")}`
      );
    }
  }

  // =======================================================================
  // Menu injection
  //
  // Confirmed live against 192.168.4.100:6969:
  //   - Scene page ⋮ menu: a .dropdown-menu.show whose sibling toggle
  //     button has title="Operations" and an inline <svg class="...
  //     fa-ellipsis-vertical ...">. Items render as
  //     <a class="dropdown-item" role="button">; there is no
  //     .dropdown-divider — the 7 items (Rescan / Generate… / Generate
  //     thumbnail from current / Generate default thumbnail / Submit to
  //     Stash-Box / Merge... / Delete) are one flat list ending in Delete.
  //   - Scene list bulk menu: the "..." button in the list toolbar (always
  //     present, not just once scenes are selected) opens a
  //     .dropdown-menu.show that additionally carries the stable class
  //     .scene-list-operations-dropdown — no heuristics needed for this
  //     one. Items: Play / Select All / Select None / Invert Selection /
  //     Play Random / Generate… / Identify… / Merge… / Export /
  //     Export all…, also no divider.
  //   - Selected scene cards: each card has a checked
  //     <input class="card-check" type="checkbox"> inside a .scene-card
  //     container; the scene id isn't in a data attribute, it's parsed out
  //     of that card's <a href="/scenes/<id>...">.
  //
  // Dropdown.Menu still only mounts to the DOM the first time a user opens
  // it, so this uses a persistent, non-time-boxed MutationObserver rather
  // than the ~15s-deadline pattern used for toolbar-button injection
  // elsewhere in this repo.
  // =======================================================================

  const SINGLE_ITEM_ID = "fc-single-menu-item";
  const BULK_ITEM_ID = "fc-bulk-menu-item";

  function currentSceneIdFromPath() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function findOpenSceneOperationsMenu() {
    if (!currentSceneIdFromPath()) return null;
    const menus = document.querySelectorAll(".dropdown-menu.show");
    for (const menu of menus) {
      const toggle = menu.parentElement && menu.parentElement.querySelector(".dropdown-toggle");
      if (toggle && toggle.querySelector(".fa-ellipsis-vertical, .fa-ellipsis-v")) {
        return menu;
      }
    }
    return null;
  }

  function findOpenBulkOperationsMenu() {
    return document.querySelector(".dropdown-menu.show.scene-list-operations-dropdown");
  }

  function getSelectedSceneIds() {
    const ids = [];
    document.querySelectorAll("input.card-check:checked").forEach((cb) => {
      const card = cb.closest(".scene-card");
      const link = card && card.querySelector('a[href*="/scenes/"]');
      const href = link ? link.getAttribute("href") : "";
      const m = href.match(/\/scenes\/(\d+)/);
      if (m) ids.push(m[1]);
    });
    return Array.from(new Set(ids));
  }

  function makeMenuItem(id, label, onClick) {
    const a = document.createElement("a");
    a.id = id;
    a.href = "#";
    a.setAttribute("role", "button");
    a.className = "dropdown-item fc-menu-item";
    a.textContent = label;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return a;
  }

  // Inserts before the first item matching matchText (case-insensitive
  // exact match on trimmed textContent) if found, else before
  // .dropdown-divider if present, else at the end.
  function insertMenuItem(menu, item, matchText) {
    const anchor = Array.from(menu.children).find(
      (el) => el.textContent.trim().toLowerCase() === matchText.toLowerCase()
    );
    if (anchor) menu.insertBefore(item, anchor);
    else {
      const divider = menu.querySelector(".dropdown-divider");
      if (divider) menu.insertBefore(item, divider);
      else menu.appendChild(item);
    }
  }

  function tryInjectSingle() {
    const menu = findOpenSceneOperationsMenu();
    if (!menu) return;
    if (menu.querySelector(`#${SINGLE_ITEM_ID}`)) return;
    const sceneId = currentSceneIdFromPath();
    if (!sceneId) return;
    const item = makeMenuItem(SINGLE_ITEM_ID, "Set Cover to First Frame", () =>
      handleSingleSceneClick(sceneId)
    );
    // Keep it out of the way of the destructive "Delete" action at the
    // bottom of the menu.
    insertMenuItem(menu, item, "Delete");
  }

  function tryInjectBulk() {
    const menu = findOpenBulkOperationsMenu();
    if (!menu) return;
    if (menu.querySelector(`#${BULK_ITEM_ID}`)) return;
    const item = makeMenuItem(BULK_ITEM_ID, "Set Cover to First Frame (Bulk)", () =>
      handleBulkClick(getSelectedSceneIds())
    );
    // Group with the other scene-mutating bulk ops, ahead of the
    // read-only Export items.
    insertMenuItem(menu, item, "Export");
  }

  // Persistent observer — Dropdown.Menu only mounts to the DOM the first
  // time it's opened, so (unlike the toolbar-button injection elsewhere in
  // this repo) there is no fixed deadline after which we stop watching.
  const observer = new MutationObserver(() => {
    tryInjectSingle();
    tryInjectBulk();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  // Re-check on SPA navigation too, since a menu may already be open when
  // the user navigates (unlikely, but cheap to cover) and to reset any
  // per-scene state.
  if (window.PluginApi && window.PluginApi.Event) {
    window.PluginApi.Event.addEventListener("stash:location", () => {
      tryInjectSingle();
      tryInjectBulk();
    });
  }
})();
