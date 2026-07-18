(function () {
  "use strict";

  if (window._submitToMyStashBoxLoaded) return;
  window._submitToMyStashBoxLoaded = true;

  const PLUGIN_ID    = "SubmitToMyStashBox";
  const TASK_NAME     = "Submit Scene";
  const RESULT_TAG    = "__stmsb_result__";
  const MENU_ITEM_ID  = "stmsb-menu-item";
  const MODAL_ID      = "stmsb-modal-overlay";
  const LABEL         = "Auto-Submit & Approve";

  function getSceneId()  { const m = window.location.pathname.match(/^\/scenes\/(\d+)/); return m ? m[1] : null; }
  function isScenePage() { return !!getSceneId(); }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

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

  // ── Run Python task and read result from __stmsb_result__ tag ─────────────

  async function runTask(sceneId, onTick) {
    const startData = await gql(`
      mutation RunTask($args: [PluginArgInput!]) {
        runPluginTask(plugin_id: "${PLUGIN_ID}", task_name: "${TASK_NAME}", args: $args)
      }
    `, { args: [{ key: "scene_id", value: { str: sceneId } }] });

    const jobId = startData.runPluginTask;
    if (!jobId) throw new Error("Could not start submit task");

    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (onTick) onTick(i + 1);
      let job;
      try {
        const jd = await gql(`
          query FindJob($input: FindJobInput!) { findJob(input: $input) { id status description } }
        `, { input: { id: jobId } });
        job = jd.findJob;
      } catch (_) { break; }
      if (!job) break;
      if (job.status === "FINISHED") break;
      if (job.status === "FAILED") throw new Error(job.description || "Submit task failed");
    }

    const td = await gql(`
      query { findTags(filter: { q: ${JSON.stringify(RESULT_TAG)}, per_page: 1 }) { tags { id name description } } }
    `);
    const tag = (td.findTags.tags || []).find(t => t.name === RESULT_TAG);
    if (!tag?.description) throw new Error("Task completed but returned no result.");
    try { await gql(`mutation D($id:ID!){tagDestroy(input:{id:$id})}`, { id: tag.id }); } catch (_) {}

    const result = JSON.parse(tag.description);
    if (!result.ok) throw new Error(result.error || "Submission failed");
    return result.message;
  }

  // ── Modal (plain DOM — mirrors Data18StashDB's skeleton, no React access) ─

  function closeModal() { document.getElementById(MODAL_ID)?.remove(); }

  function openModal() {
    if (document.getElementById(MODAL_ID)) return;
    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div id="stmsb-box">
        <div id="stmsb-header">
          <span>${LABEL}</span>
          <button id="stmsb-close">✕</button>
        </div>
        <div id="stmsb-body"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById("stmsb-close").onclick = closeModal;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  }

  function setBody(html) {
    const el = document.getElementById("stmsb-body");
    if (el) el.innerHTML = html;
  }

  async function handleClick() {
    const sceneId = getSceneId();
    if (!sceneId) return;
    openModal();
    setBody(`<p class="stmsb-status">Submitting…</p>`);
    try {
      const message = await runTask(sceneId, s => setBody(`<p class="stmsb-status">Submitting… (${s}s)</p>`));
      setBody(`<p class="stmsb-success">✓ ${esc(message)}</p>`);
    } catch (e) {
      setBody(`<p class="stmsb-error">⚠ ${esc(e.message)}</p>`);
    }
  }

  // ── Menu injection ─────────────────────────────────────────────────────────
  // No patch point exists for the ellipsis/operations dropdown (confirmed via
  // Scene.tsx read + grep for PatchComponent across ui/v2.5/src), so this
  // injects directly into the live DOM and re-checks on every mutation, since
  // React wipes manually-added children whenever it re-renders that menu.

  function injectMenuItem() {
    if (!isScenePage()) return false;
    const toggle = document.getElementById("operation-menu");
    if (!toggle) return false;
    const menu = toggle.parentElement && toggle.parentElement.querySelector(".dropdown-menu");
    if (!menu) return false;
    if (menu.querySelector(`#${MENU_ITEM_ID}`)) return true;

    const item = document.createElement("a");
    item.id = MENU_ITEM_ID;
    item.className = "dropdown-item bg-secondary text-white";
    item.setAttribute("role", "button");
    item.href = "#";
    item.textContent = LABEL;
    item.addEventListener("click", (e) => { e.preventDefault(); handleClick(); });
    menu.appendChild(item);
    return true;
  }

  function start() {
    injectMenuItem();
    // Kept observing indefinitely (not time-boxed like a one-shot toolbar
    // button injection) because Dropdown.Menu only mounts into the DOM after
    // the user opens it the first time, and can be wiped by later re-renders
    // on subsequent opens — so re-injection has to keep happening for the
    // life of the page, not just once at load.
    const obs = new MutationObserver(() => injectMenuItem());
    obs.observe(document.body, { childList: true, subtree: true });

    if (window.PluginApi?.Event) {
      window.PluginApi.Event.addEventListener("stash:location", () => injectMenuItem());
    }
  }

  start();
})();
