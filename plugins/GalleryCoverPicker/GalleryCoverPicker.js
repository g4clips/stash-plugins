/**
 * Gallery Cover Picker
 *
 * Adds three entry points, mirroring how scenes expose their cover controls:
 *   1. A "Set cover…" button under "Cover Image" on the gallery Edit tab
 *   2. A "Set cover…" item in the gallery's ellipsis (operations) menu
 *   3. A "Set as gallery cover" item in an image page's ellipsis menu
 *
 * (1) and (2) open a picker showing the gallery's own images. Choosing one calls
 * Stash's existing setGalleryCover mutation (the same one behind the Images
 * tab's "Set cover" bulk action). No backend / Python task is needed.
 *
 * Injection is done with DOM observation rather than PluginApi.patch, because
 * the ellipsis Dropdown.Menu only mounts on first open and React can discard
 * foreign children when it re-renders.
 */
(function () {
  "use strict";

  const LOG = "[GalleryCoverPicker]";
  const PER_PAGE = 48;
  const GALLERY_PATH_RE = /\/galleries\/(\d+)(?:\/|$)/;
  const IMAGE_PATH_RE = /\/images\/(\d+)(?:\/|$)/;
  const OPS_MENU_SELECTOR = '.dropdown-menu[aria-labelledby="operation-menu"]';
  const IMAGE_ITEM_CLASS = "gcp-image-menu-item";
  const GALLERY_CACHE_TTL_MS = 30000;

  const EDIT_ACTIONS_ID = "gcp-edit-actions";
  const MENU_ITEM_ID = "gcp-menu-item";

  // ---------------------------------------------------------------- helpers

  function currentGalleryId() {
    const m = window.location.pathname.match(GALLERY_PATH_RE);
    return m ? m[1] : null;
  }

  function currentImageId() {
    const m = window.location.pathname.match(IMAGE_PATH_RE);
    return m ? m[1] : null;
  }

  async function gql(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });
    const json = await resp.json();
    if (json.errors) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  // Tiny DOM builder. Uses textContent / setAttribute only, so image titles or
  // gallery names can never be interpreted as HTML.
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) {
      if (c === undefined || c === null) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function toast(message, isError) {
    const old = document.getElementById("gcp-toast");
    if (old) old.remove();
    const t = h("div", {
      id: "gcp-toast",
      class: isError ? "gcp-toast-error" : "",
      text: message,
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isError ? 5000 : 2500);
  }

  // ------------------------------------------------------------ data access

  const Q_GALLERY = `
    query GCPGallery($id: ID!) {
      findGallery(id: $id) {
        id
        title
        cover { id }
      }
    }`;

  const Q_IMAGES = `
    query GCPImages($filter: FindFilterType, $imageFilter: ImageFilterType) {
      findImages(filter: $filter, image_filter: $imageFilter) {
        count
        images { id title paths { thumbnail } }
      }
    }`;

  const M_SET_COVER = `
    mutation GCPSetCover($input: GallerySetCoverInput!) {
      setGalleryCover(input: $input)
    }`;

  const Q_IMAGE_GALLERIES = `
    query GCPImageGalleries($id: ID!) {
      findImage(id: $id) {
        id
        galleries { id title files { path } folder { path } }
      }
    }`;

  function bustCoverImages(galleryId) {
    // Fallback only: refresh any <img> already showing this gallery's cover.
    const stamp = "?t=" + Math.floor(Date.now() / 1000);
    document
      .querySelectorAll(`img[src*="/gallery/${galleryId}/cover"]`)
      .forEach((img) => {
        img.src = img.src.split("?")[0] + stamp;
      });
  }

  async function setCover(galleryId, imageId) {
    const input = { gallery_id: galleryId, cover_image_id: imageId };

    // Prefer Stash's own service: it evicts the Apollo cache so every cover
    // on screen refreshes without a page reload (and without losing any
    // unsaved edits in the Edit tab).
    const service =
      window.PluginApi && window.PluginApi.utils
        ? window.PluginApi.utils.StashService
        : null;
    if (service && typeof service.mutateSetGalleryCover === "function") {
      const result = await service.mutateSetGalleryCover(input);
      if (result && result.data && result.data.setGalleryCover === false) {
        throw new Error("Stash did not accept that image as the cover.");
      }
      return;
    }

    const data = await gql(M_SET_COVER, { input });
    if (data.setGalleryCover === false) {
      throw new Error("Stash did not accept that image as the cover.");
    }
    bustCoverImages(galleryId);
  }

  // ----------------------------------------------------------------- picker

  function openPicker(galleryId) {
    if (document.getElementById("gcp-overlay")) return;

    const state = {
      page: 1,
      total: 0,
      selectedId: null,
      currentCoverId: null,
      loading: false,
      saving: false,
    };

    const titleEl = h("div", { id: "gcp-title", text: "Set gallery cover" });
    const errorEl = h("div", { id: "gcp-error" });
    const gridEl = h("div", { id: "gcp-grid" });
    const emptyEl = h("div", { id: "gcp-empty", text: "Loading…" });
    const pageLabel = h("span", { text: "" });
    const prevBtn = h("button", {
      type: "button",
      class: "btn btn-secondary btn-sm",
      text: "Previous",
    });
    const nextBtn = h("button", {
      type: "button",
      class: "btn btn-secondary btn-sm",
      text: "Next",
    });
    const cancelBtn = h("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "Cancel",
    });
    const applyBtn = h("button", {
      type: "button",
      class: "btn btn-primary",
      text: "Set as cover",
      disabled: true,
    });
    const closeBtn = h("button", {
      id: "gcp-close",
      type: "button",
      title: "Close",
      text: "✕",
    });

    const box = h(
      "div",
      { id: "gcp-box", role: "dialog", "aria-modal": "true" },
      h("div", { id: "gcp-header" }, titleEl, closeBtn),
      errorEl,
      h("div", {
        id: "gcp-hint",
        text: "Click an image to select it. Double-click to set it immediately.",
      }),
      h("div", { id: "gcp-body" }, emptyEl, gridEl),
      h(
        "div",
        { id: "gcp-footer" },
        h("div", { id: "gcp-pager" }, prevBtn, pageLabel, nextBtn),
        h("div", { id: "gcp-actions" }, cancelBtn, applyBtn)
      )
    );
    const overlay = h("div", { id: "gcp-overlay" }, box);

    function close() {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }

    function setError(msg) {
      errorEl.textContent = msg ? "⚠ " + msg : "";
      errorEl.style.display = msg ? "block" : "none";
    }

    function totalPages() {
      return Math.max(1, Math.ceil(state.total / PER_PAGE));
    }

    function refreshControls() {
      const busy = state.loading || state.saving;
      prevBtn.disabled = busy || state.page <= 1;
      nextBtn.disabled = busy || state.page >= totalPages();
      applyBtn.disabled = busy || !state.selectedId;
      applyBtn.textContent = state.saving ? "Saving…" : "Set as cover";
      pageLabel.textContent = state.total
        ? `Page ${state.page} of ${totalPages()} (${state.total} images)`
        : "";
    }

    function renderGrid(images) {
      gridEl.replaceChildren();
      emptyEl.style.display = images.length ? "none" : "block";
      if (!images.length) emptyEl.textContent = "This gallery has no images.";

      for (const img of images) {
        const thumbUrl = img.paths && img.paths.thumbnail;
        const classes = ["gcp-thumb"];
        if (img.id === state.selectedId) classes.push("gcp-selected");

        const btn = h(
          "button",
          {
            type: "button",
            class: classes.join(" "),
            title: img.title || `Image ${img.id}`,
            "data-id": img.id,
          },
          thumbUrl
            ? h("img", { src: thumbUrl, loading: "lazy", alt: img.title || "" })
            : null,
          img.id === state.currentCoverId
            ? h("span", { class: "gcp-badge", text: "Current cover" })
            : null
        );

        btn.addEventListener("click", () => {
          state.selectedId = img.id;
          gridEl
            .querySelectorAll(".gcp-thumb")
            .forEach((n) =>
              n.classList.toggle("gcp-selected", n.dataset.id === img.id)
            );
          refreshControls();
        });
        btn.addEventListener("dblclick", () => {
          state.selectedId = img.id;
          apply();
        });

        gridEl.appendChild(btn);
      }
    }

    async function loadPage() {
      state.loading = true;
      setError("");
      refreshControls();
      try {
        const data = await gql(Q_IMAGES, {
          filter: {
            page: state.page,
            per_page: PER_PAGE,
            sort: "path",
            direction: "ASC",
          },
          imageFilter: {
            galleries: { value: [galleryId], modifier: "INCLUDES_ALL" },
          },
        });
        state.total = data.findImages.count;
        renderGrid(data.findImages.images);
      } catch (e) {
        emptyEl.style.display = "none";
        setError(e.message || String(e));
      } finally {
        state.loading = false;
        refreshControls();
      }
    }

    async function apply() {
      if (!state.selectedId || state.saving) return;
      state.saving = true;
      setError("");
      refreshControls();
      try {
        await setCover(galleryId, state.selectedId);
        close();
        toast("Gallery cover updated");
      } catch (e) {
        state.saving = false;
        setError(e.message || String(e));
        refreshControls();
      }
    }

    prevBtn.onclick = () => {
      if (state.page > 1) {
        state.page -= 1;
        loadPage();
      }
    };
    nextBtn.onclick = () => {
      if (state.page < totalPages()) {
        state.page += 1;
        loadPage();
      }
    };
    applyBtn.onclick = apply;
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    setError("");
    refreshControls();

    // Gallery title + current cover (for the badge), then the first page.
    gql(Q_GALLERY, { id: galleryId })
      .then((d) => {
        const g = d.findGallery;
        if (!g) return;
        if (g.title) titleEl.textContent = `Set cover — ${g.title}`;
        state.currentCoverId = g.cover ? g.cover.id : null;
      })
      .catch((e) => console.warn(LOG, "gallery lookup failed", e))
      .finally(loadPage);
  }

  // -------------------------------------------------------------- injection

  // Edit tab: button beneath the "Cover Image" preview, like the scene
  // edit panel's cover button.
  function injectEditButton(galleryId) {
    const label = document.querySelector(
      '#gallery-edit-details label[for="cover_image"]'
    );
    if (!label) return;
    const group = label.closest(".form-group");
    if (!group || group.querySelector("#" + EDIT_ACTIONS_ID)) return;

    const btn = h("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "Set cover…",
      title: "Choose the cover from this gallery's images",
    });
    btn.addEventListener("click", () => openPicker(galleryId));
    group.appendChild(h("div", { id: EDIT_ACTIONS_ID }, btn));
  }

  // Ellipsis menu: item right after the native "Reset cover" entry.
  function injectMenuItem(galleryId) {
    const menu = document.querySelector(OPS_MENU_SELECTOR);
    if (!menu || menu.querySelector("#" + MENU_ITEM_ID)) return;

    const item = h("a", {
      id: MENU_ITEM_ID,
      href: "#",
      role: "button",
      class: "dropdown-item bg-secondary text-white",
      text: "Set cover…",
    });
    item.addEventListener("click", (e) => {
      e.preventDefault();
      // Close the menu the same way a user would (toggle is open right now).
      const toggle = document.getElementById("operation-menu");
      if (toggle && toggle.getAttribute("aria-expanded") === "true") {
        toggle.click();
      }
      openPicker(galleryId);
    });

    // Native label varies by Stash version ("Reset cover" / "Restore Default Cover").
    const reset = Array.from(menu.querySelectorAll(".dropdown-item")).find(
      (el) => /reset cover|restore default cover/i.test(el.textContent || "")
    );
    if (reset) reset.insertAdjacentElement("afterend", item);
    else menu.prepend(item);
  }

  // Image page: imageId -> { loading, at, galleries }. Looked up once per
  // image (30s TTL).
  const imageGalleries = new Map();

  function galleryLabel(g) {
    if (g.title) return g.title;
    const p =
      (g.files && g.files[0] && g.files[0].path) ||
      (g.folder && g.folder.path) ||
      "";
    const name = p.split(/[\\/]/).filter(Boolean).pop();
    return name || "Gallery " + g.id;
  }

  // Returns the galleries array, or null while the lookup is still running.
  function ensureImageGalleries(imageId) {
    const hit = imageGalleries.get(imageId);
    if (hit && !hit.loading && Date.now() - hit.at < GALLERY_CACHE_TTL_MS) {
      return hit.galleries;
    }
    if (hit && hit.loading) return null;

    imageGalleries.set(imageId, {
      loading: true,
      at: Date.now(),
      galleries: [],
    });
    gql(Q_IMAGE_GALLERIES, { id: imageId })
      .then((d) => (d.findImage && d.findImage.galleries) || [])
      .catch((e) => {
        console.warn(LOG, "image gallery lookup failed", e);
        return []; // cache the failure for the TTL so we never retry in a loop
      })
      .then((galleries) => {
        imageGalleries.set(imageId, {
          loading: false,
          at: Date.now(),
          galleries,
        });
        inject();
      });
    return null;
  }

  // Image page ⋮ menu: "Set as gallery cover" (one item per gallery).
  function injectImageMenuItems(imageId) {
    const menu = document.querySelector(OPS_MENU_SELECTOR);
    if (!menu) return;

    // Remove items left over from a previously viewed image.
    menu.querySelectorAll("." + IMAGE_ITEM_CLASS).forEach((el) => {
      if (el.dataset.imageId !== imageId) el.remove();
    });
    if (menu.querySelector("." + IMAGE_ITEM_CLASS)) return;

    const galleries = ensureImageGalleries(imageId);
    if (!galleries || !galleries.length) return;

    const items = galleries.map((g) => {
      const name = galleryLabel(g);
      const item = h("a", {
        href: "#",
        role: "button",
        class: "dropdown-item bg-secondary text-white " + IMAGE_ITEM_CLASS,
        "data-image-id": imageId,
        text:
          galleries.length === 1
            ? "Set as gallery cover"
            : `Set as cover of "${name}"`,
      });
      item.addEventListener("click", async (e) => {
        e.preventDefault();
        const toggle = document.getElementById("operation-menu");
        if (toggle && toggle.getAttribute("aria-expanded") === "true") {
          toggle.click();
        }
        try {
          await setCover(g.id, imageId);
          toast(`Cover set for ${name}`);
        } catch (err) {
          toast(err.message || String(err), true);
        }
      });
      return item;
    });

    const generate = Array.from(menu.querySelectorAll(".dropdown-item")).find(
      (el) => /^generate/i.test((el.textContent || "").trim())
    );
    let anchor = generate;
    for (const item of items) {
      if (anchor) anchor.insertAdjacentElement("afterend", item);
      else menu.appendChild(item);
      anchor = item;
    }
  }

  function inject() {
    const galleryId = currentGalleryId();
    if (galleryId) {
      injectEditButton(galleryId);
      injectMenuItem(galleryId);
    }
    const imageId = currentImageId();
    if (imageId) injectImageMenuItems(imageId);
  }

  // The menu mounts lazily and React may rebuild parts of the page, so keep
  // one persistent observer (throttled to one check per animation frame).
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled || (!currentGalleryId() && !currentImageId())) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        inject();
      } catch (e) {
        console.warn(LOG, "inject failed", e);
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (window.PluginApi && window.PluginApi.Event) {
    window.PluginApi.Event.addEventListener("stash:location", inject);
  }
  inject();
})();
