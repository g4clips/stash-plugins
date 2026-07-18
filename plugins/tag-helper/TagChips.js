// TagChips.js
// Adds a "Tags" tab to the Scene page: click chips to toggle tags on the
// current scene in real time, plus preset "groups" of tags applied in one
// click, plus "categories" that section the main tag grid.
//
// Storage: groups and categories are NOT tags. They live in Stash's own
// plugin config store, at configuration.plugins.TagChips, written via the
// configurePlugin(plugin_id, input: Map!) mutation. That mutation REPLACES
// the whole per-plugin config rather than merging, so every write goes
// through writeConfig() below, which does a read-modify-write.
//
// (Older versions of this plugin stored "groups" as fake tags named
// zzz-group:<name>. Those tags are no longer read specially by this file —
// if any exist in your library they're just ordinary tags now.)
//
// See project docs: stash-plugin-dev-notes-2026-07-15-v2.md sections 3, 4, 8, 13
// for the GraphQL / PluginApi patterns this file follows.

(function () {
  const { React } = PluginApi;
  const h = React.createElement;

  const PLUGIN_ID = "TagChips";

  // ---------------------------------------------------------------------
  // GraphQL helper (same-origin, so no CORS issues per project notes)
  // ---------------------------------------------------------------------
  async function gql(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ query, variables }),
    });
    const json = await resp.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data;
  }

  function genId(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------
  // Plugin config (groups + categories) — centralized read/write.
  // configurePlugin replaces the whole per-plugin config, so writeConfig
  // always reads current state first and shallow-merges the patch on top.
  // All group/category persistence must go through these two functions —
  // no other code should call configurePlugin directly.
  // ---------------------------------------------------------------------
  async function readConfig() {
    const data = await gql(`{ configuration { plugins } }`);
    const cfg = (data.configuration.plugins || {})[PLUGIN_ID] || {};
    return {
      groups: Array.isArray(cfg.groups) ? cfg.groups : [],
      categories: Array.isArray(cfg.categories) ? cfg.categories : [],
    };
  }

  async function writeConfig(patch) {
    const current = await readConfig();
    const merged = { ...current, ...patch };
    await gql(
      `mutation TagChipsConfigure($id: ID!, $input: Map!) {
         configurePlugin(plugin_id: $id, input: $input)
       }`,
      { id: PLUGIN_ID, input: merged }
    );
    return merged;
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  async function fetchAllTags() {
    const data = await gql(`
      query TagChipsAllTags {
        findTags(filter: { per_page: -1, sort: "name", direction: ASC }) {
          tags { id name scene_count }
        }
      }
    `);
    return data.findTags.tags;
  }

  // ---------------------------------------------------------------------
  // Scene tag mutations
  // ---------------------------------------------------------------------
  async function updateSceneTagIds(sceneId, tagIds) {
    await gql(
      `mutation TagChipsSceneUpdate($input: SceneUpdateInput!) {
         sceneUpdate(input: $input) { id tags { id } }
       }`,
      { input: { id: sceneId, tag_ids: tagIds } }
    );
  }

  // ---------------------------------------------------------------------
  // Group persistence (config-store based)
  // ---------------------------------------------------------------------
  async function saveGroup({ id, label, memberTagIds }) {
    const current = await readConfig();
    const groups = id
      ? current.groups.map((g) => (g.id === id ? { ...g, label: label.trim(), memberTagIds } : g))
      : [...current.groups, { id: genId("grp"), label: label.trim(), memberTagIds }];
    return writeConfig({ groups });
  }

  async function deleteGroup(id) {
    const current = await readConfig();
    const groups = current.groups.filter((g) => g.id !== id);
    return writeConfig({ groups });
  }

  // ---------------------------------------------------------------------
  // Category persistence (config-store based). A tag may only belong to
  // one category: saving a category strips its tagIds out of every other
  // category first, then applies, in a single writeConfig call.
  // ---------------------------------------------------------------------
  function stripFromOtherCategories(categories, exceptId, tagIds) {
    const tagSet = new Set(tagIds);
    return categories.map((c) =>
      c.id === exceptId ? c : { ...c, tagIds: c.tagIds.filter((t) => !tagSet.has(t)) }
    );
  }

  async function saveCategory({ id, label, tagIds }) {
    const current = await readConfig();
    let categories;
    if (id) {
      categories = stripFromOtherCategories(current.categories, id, tagIds).map((c) =>
        c.id === id ? { ...c, label: label.trim(), tagIds } : c
      );
    } else {
      const newId = genId("cat");
      categories = [
        ...stripFromOtherCategories(current.categories, newId, tagIds),
        { id: newId, label: label.trim(), tagIds },
      ];
    }
    return writeConfig({ categories });
  }

  async function deleteCategory(id) {
    const current = await readConfig();
    const categories = current.categories.filter((c) => c.id !== id);
    return writeConfig({ categories });
  }

  async function reorderCategory(id, direction) {
    const current = await readConfig();
    const idx = current.categories.findIndex((c) => c.id === id);
    if (idx < 0) return current;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= current.categories.length) return current;
    const categories = current.categories.slice();
    const tmp = categories[idx];
    categories[idx] = categories[newIdx];
    categories[newIdx] = tmp;
    return writeConfig({ categories });
  }

  // ---------------------------------------------------------------------
  // Category grouping for the scene-tab grid.
  // Order: categories in stored array order, Uncategorized last.
  // Within each section: sort by scene_count descending.
  // ---------------------------------------------------------------------
  function buildCategorizedSections(tags, categories) {
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const usedIds = new Set();
    const sections = categories.map((cat) => {
      const catTags = cat.tagIds.map((id) => tagById.get(id)).filter(Boolean);
      catTags.forEach((t) => usedIds.add(t.id));
      catTags.sort((a, b) => (b.scene_count || 0) - (a.scene_count || 0));
      return { id: cat.id, label: cat.label, tags: catTags };
    });
    const uncategorized = tags.filter((t) => !usedIds.has(t.id));
    uncategorized.sort((a, b) => (b.scene_count || 0) - (a.scene_count || 0));
    sections.push({ id: "__uncategorized", label: "Uncategorized", tags: uncategorized });
    return sections;
  }

  // ---------------------------------------------------------------------
  // Chip component
  // ---------------------------------------------------------------------
  function Chip({ label, active, pending, error, onClick, variant }) {
    const cls = [
      "tc-chip",
      variant === "group" ? "tc-chip-group" : "",
      active ? "tc-chip-on" : "",
      pending ? "tc-chip-pending" : "",
      error ? "tc-chip-error" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return h(
      "span",
      { className: cls, title: label, onClick: pending ? undefined : onClick },
      label
    );
  }

  // ---------------------------------------------------------------------
  // Categorized tag grid — Step 4 layout: heading + divider per section,
  // fixed-size chips via CSS grid (see .tc-tag-grid in TagChips.css).
  // ---------------------------------------------------------------------
  function CategorizedTagGrid({ sections, sceneTagIds, pendingIds, errorIds, onToggle }) {
    const nonEmpty = sections.filter((s) => s.tags.length > 0);
    if (nonEmpty.length === 0) {
      return h("span", { style: { color: "#888", fontSize: ".8rem" } }, "No tags match.");
    }
    return h(
      React.Fragment,
      null,
      nonEmpty.map((s) =>
        h("div", { key: s.id, className: "tc-cat-section" }, [
          h("div", { key: "hd", className: "tc-cat-heading" }, s.label),
          h("hr", { key: "hr", className: "tc-cat-divider" }),
          h(
            "div",
            { key: "grid", className: "tc-tag-grid" },
            s.tags.map((t) =>
              h(Chip, {
                key: t.id,
                label: t.name,
                active: sceneTagIds.has(t.id),
                pending: pendingIds.has(t.id),
                error: errorIds.has(t.id),
                onClick: () => onToggle(t.id),
              })
            )
          ),
        ])
      )
    );
  }

  // ---------------------------------------------------------------------
  // Shared create/edit form for both categories and groups: a name input
  // plus a tag-toggle picker. Persistence + delete are injected by the
  // caller (onPersist/onDelete) so this component stays storage-agnostic.
  // ---------------------------------------------------------------------
  function CategoryOrGroupEditor({ allTags, item, noun, onCancel, onPersist, onSaved, onDelete, onDeleted }) {
    const [label, setLabel] = React.useState(item ? item.label : "");
    const [selectedIds, setSelectedIds] = React.useState(new Set(item ? item.selectedIds : []));
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");

    function toggle(id) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function handleSave() {
      if (!label.trim()) {
        setError(`${noun} name is required.`);
        return;
      }
      setBusy(true);
      setError("");
      try {
        await onPersist({ id: item ? item.id : null, label: label.trim(), tagIds: Array.from(selectedIds) });
        onSaved();
      } catch (e) {
        setError(e.message);
        setBusy(false);
      }
    }

    async function handleDelete() {
      if (!item) return;
      setBusy(true);
      try {
        await onDelete(item.id);
        onDeleted();
      } catch (e) {
        setError(e.message);
        setBusy(false);
      }
    }

    return h(
      "div",
      { className: "tc-panel" },
      h("div", { className: "tc-editor-row" }, [
        h("input", {
          key: "name",
          className: "tc-editor-input",
          placeholder: `${noun} name`,
          value: label,
          onChange: (e) => setLabel(e.target.value),
        }),
        h(
          "button",
          { key: "save", className: "btn btn-primary btn-sm", disabled: busy, onClick: handleSave },
          item ? "Save" : "Create"
        ),
        item &&
          h(
            "button",
            { key: "del", className: "btn btn-danger btn-sm", disabled: busy, onClick: handleDelete },
            "Delete"
          ),
        h(
          "button",
          { key: "cancel", className: "btn btn-secondary btn-sm", disabled: busy, onClick: onCancel },
          "Cancel"
        ),
      ]),
      error && h("div", { className: "tc-error-bar" }, error),
      h("div", { className: "tc-section-label" }, "Tags"),
      h(
        "div",
        { className: "tc-grid" },
        allTags.map((t) =>
          h(Chip, {
            key: t.id,
            label: t.name,
            active: selectedIds.has(t.id),
            onClick: () => toggle(t.id),
          })
        )
      )
    );
  }

  // ---------------------------------------------------------------------
  // Categories tab (Manage Tags modal)
  // ---------------------------------------------------------------------
  function CategoriesTab({ allTags, categories, onReload }) {
    const [editing, setEditing] = React.useState(undefined); // undefined=list, null=new, obj=edit
    const [busyId, setBusyId] = React.useState(null);
    const [error, setError] = React.useState("");

    async function move(id, direction) {
      setBusyId(id);
      setError("");
      try {
        await reorderCategory(id, direction);
        onReload();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusyId(null);
      }
    }

    if (editing !== undefined) {
      const item = editing ? { id: editing.id, label: editing.label, selectedIds: editing.tagIds } : null;
      return h(CategoryOrGroupEditor, {
        allTags,
        item,
        noun: "Category",
        onCancel: () => setEditing(undefined),
        onPersist: (data) => saveCategory(data),
        onSaved: () => {
          setEditing(undefined);
          onReload();
        },
        onDelete: (id) => deleteCategory(id),
        onDeleted: () => {
          setEditing(undefined);
          onReload();
        },
      });
    }

    return h("div", { className: "tc-panel" }, [
      error && h("div", { key: "err", className: "tc-error-bar" }, error),
      h("div", { key: "hdr", className: "tc-editor-row" }, [
        h("span", { key: "lbl", className: "tc-section-label", style: { margin: 0 } }, "Categories"),
        h(
          "button",
          { key: "new", className: "tc-group-manage-btn", onClick: () => setEditing(null) },
          "+ new category"
        ),
      ]),
      categories.length === 0
        ? h("div", { key: "empty", style: { color: "#888", fontSize: ".8rem" } }, "No categories yet.")
        : h(
            "div",
            { key: "list", className: "tc-cat-list" },
            categories.map((c, idx) =>
              h("div", { key: c.id, className: "tc-cat-row" }, [
                h("div", { key: "order", className: "tc-cat-order" }, [
                  h(
                    "button",
                    {
                      key: "up",
                      className: "tc-order-btn",
                      disabled: idx === 0 || busyId === c.id,
                      onClick: () => move(c.id, -1),
                    },
                    "▲"
                  ),
                  h(
                    "button",
                    {
                      key: "down",
                      className: "tc-order-btn",
                      disabled: idx === categories.length - 1 || busyId === c.id,
                      onClick: () => move(c.id, 1),
                    },
                    "▼"
                  ),
                ]),
                h("span", { key: "label", className: "tc-cat-label" }, c.label),
                h(
                  "span",
                  { key: "count", className: "tc-cat-count" },
                  `${c.tagIds.length} tag${c.tagIds.length === 1 ? "" : "s"}`
                ),
                h(
                  "button",
                  { key: "edit", className: "tc-group-manage-btn", onClick: () => setEditing(c) },
                  "edit"
                ),
              ])
            )
          ),
    ]);
  }

  // ---------------------------------------------------------------------
  // Groups tab (Manage Tags modal) — same CRUD as categories, no ordering.
  // ---------------------------------------------------------------------
  function GroupsTab({ allTags, groups, onReload }) {
    const [editing, setEditing] = React.useState(undefined);

    if (editing !== undefined) {
      const item = editing ? { id: editing.id, label: editing.label, selectedIds: editing.memberTagIds } : null;
      return h(CategoryOrGroupEditor, {
        allTags,
        item,
        noun: "Group",
        onCancel: () => setEditing(undefined),
        onPersist: (data) => saveGroup({ id: data.id, label: data.label, memberTagIds: data.tagIds }),
        onSaved: () => {
          setEditing(undefined);
          onReload();
        },
        onDelete: (id) => deleteGroup(id),
        onDeleted: () => {
          setEditing(undefined);
          onReload();
        },
      });
    }

    return h("div", { className: "tc-panel" }, [
      h("div", { key: "hdr", className: "tc-editor-row" }, [
        h("span", { key: "lbl", className: "tc-section-label", style: { margin: 0 } }, "Groups"),
        h(
          "button",
          { key: "new", className: "tc-group-manage-btn", onClick: () => setEditing(null) },
          "+ new group"
        ),
      ]),
      groups.length === 0
        ? h("div", { key: "empty", style: { color: "#888", fontSize: ".8rem" } }, "No groups yet.")
        : h(
            "div",
            { key: "list", className: "tc-cat-list" },
            groups.map((g) =>
              h("div", { key: g.id, className: "tc-cat-row" }, [
                h("span", { key: "label", className: "tc-cat-label" }, g.label),
                h(
                  "span",
                  { key: "count", className: "tc-cat-count" },
                  `${g.memberTagIds.length} tag${g.memberTagIds.length === 1 ? "" : "s"}`
                ),
                h(
                  "button",
                  { key: "edit", className: "tc-group-manage-btn", onClick: () => setEditing(g) },
                  "edit"
                ),
              ])
            )
          ),
    ]);
  }

  // ---------------------------------------------------------------------
  // Manage Tags modal — position:fixed overlay + backdrop-click-to-close,
  // header with close button, Categories/Groups tabs. Structural skeleton
  // matches Data18StashDB's modal (see TagChips.css .tc-modal-*).
  // ---------------------------------------------------------------------
  function ManageTagsModal({ allTags, config, onClose, onReload }) {
    const [activeTab, setActiveTab] = React.useState("categories");

    React.useEffect(() => {
      function onKeyDown(e) {
        if (e.key === "Escape") onClose();
      }
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return h(
      "div",
      {
        className: "tc-modal-overlay",
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose();
        },
      },
      h("div", { className: "tc-modal-box" }, [
        h("div", { key: "header", className: "tc-modal-header" }, [
          h("span", { key: "title" }, "Manage Tags"),
          h("button", { key: "close", className: "tc-modal-close", onClick: onClose }, "✕"),
        ]),
        h("div", { key: "tabs", className: "tc-modal-tabs" }, [
          h(
            "button",
            {
              key: "cat",
              className: "tc-modal-tab" + (activeTab === "categories" ? " tc-modal-tab-active" : ""),
              onClick: () => setActiveTab("categories"),
            },
            "Categories"
          ),
          h(
            "button",
            {
              key: "grp",
              className: "tc-modal-tab" + (activeTab === "groups" ? " tc-modal-tab-active" : ""),
              onClick: () => setActiveTab("groups"),
            },
            "Groups"
          ),
        ]),
        h(
          "div",
          { key: "body", className: "tc-modal-body" },
          activeTab === "categories"
            ? h(CategoriesTab, { allTags, categories: config.categories, onReload })
            : h(GroupsTab, { allTags, groups: config.groups, onReload })
        ),
      ])
    );
  }

  // ---------------------------------------------------------------------
  // Main panel
  // ---------------------------------------------------------------------
  function TagChipsPanel({ scene }) {
    const [allTags, setAllTags] = React.useState([]);
    const [config, setConfig] = React.useState({ groups: [], categories: [] });
    const [sceneTagIds, setSceneTagIds] = React.useState(
      () => new Set((scene.tags || []).map((t) => t.id))
    );
    const [search, setSearch] = React.useState("");
    const [pendingIds, setPendingIds] = React.useState(new Set());
    const [errorIds, setErrorIds] = React.useState(new Set());
    const [error, setError] = React.useState("");
    const [modalOpen, setModalOpen] = React.useState(false);

    const loadAll = React.useCallback(() => {
      Promise.all([fetchAllTags(), readConfig()])
        .then(([tags, cfg]) => {
          setAllTags(tags);
          setConfig(cfg);
        })
        .catch((e) => setError(e.message));
    }, []);

    React.useEffect(() => {
      loadAll();
    }, [loadAll]);

    // Keep local state in sync if the user edits tags elsewhere and comes back
    React.useEffect(() => {
      setSceneTagIds(new Set((scene.tags || []).map((t) => t.id)));
    }, [scene.id, scene.tags]);

    function markPending(id, on) {
      setPendingIds((prev) => {
        const next = new Set(prev);
        on ? next.add(id) : next.delete(id);
        return next;
      });
    }
    function markError(id, on) {
      setErrorIds((prev) => {
        const next = new Set(prev);
        on ? next.add(id) : next.delete(id);
        return next;
      });
    }

    async function toggleTag(tagId) {
      const wasOn = sceneTagIds.has(tagId);
      const nextSet = new Set(sceneTagIds);
      wasOn ? nextSet.delete(tagId) : nextSet.add(tagId);

      // optimistic update
      setSceneTagIds(nextSet);
      markPending(tagId, true);
      markError(tagId, false);
      setError("");

      try {
        await updateSceneTagIds(scene.id, Array.from(nextSet));
      } catch (e) {
        // revert on failure
        setSceneTagIds(sceneTagIds);
        markError(tagId, true);
        setError(`Failed to update tag: ${e.message}`);
      } finally {
        markPending(tagId, false);
      }
    }

    async function applyGroup(group) {
      const missing = group.memberTagIds.filter((id) => !sceneTagIds.has(id));
      if (missing.length === 0) return; // nothing to do
      const nextSet = new Set([...sceneTagIds, ...missing]);

      setSceneTagIds(nextSet);
      missing.forEach((id) => markPending(id, true));
      missing.forEach((id) => markError(id, false));
      setError("");

      try {
        await updateSceneTagIds(scene.id, Array.from(nextSet));
      } catch (e) {
        setSceneTagIds(sceneTagIds);
        missing.forEach((id) => markError(id, true));
        setError(`Failed to apply group "${group.label}": ${e.message}`);
      } finally {
        missing.forEach((id) => markPending(id, false));
      }
    }

    const filteredTags = search.trim()
      ? allTags.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()))
      : allTags;
    const sections = buildCategorizedSections(filteredTags, config.categories);

    return h("div", { className: "tc-panel" }, [
      h("div", { key: "hdr", className: "tc-editor-row" }, [
        h("span", { key: "spacer", style: { flex: 1 } }),
        h(
          "button",
          { key: "manage", className: "btn btn-secondary btn-sm", onClick: () => setModalOpen(true) },
          "Manage Tags"
        ),
      ]),
      error && h("div", { key: "err", className: "tc-error-bar" }, error),

      h("div", { key: "gh", className: "tc-section-label" }, "Groups"),
      h(
        "div",
        { key: "gg", className: "tc-grid" },
        config.groups.length === 0
          ? h("span", { style: { color: "#888", fontSize: ".8rem" } }, "No groups yet.")
          : config.groups.map((g) =>
              h(Chip, {
                key: g.id,
                label: g.label,
                variant: "group",
                onClick: () => applyGroup(g),
              })
            )
      ),

      h("div", { key: "th", className: "tc-section-label" }, "Tags"),
      h("input", {
        key: "search",
        className: "tc-search",
        placeholder: "Filter tags…",
        value: search,
        onChange: (e) => setSearch(e.target.value),
      }),
      h(CategorizedTagGrid, {
        key: "catgrid",
        sections,
        sceneTagIds,
        pendingIds,
        errorIds,
        onToggle: toggleTag,
      }),

      modalOpen &&
        h(ManageTagsModal, {
          key: "modal",
          allTags,
          config,
          onClose: () => setModalOpen(false),
          onReload: loadAll,
        }),
    ]);
  }

  // ---------------------------------------------------------------------
  // Wire into the Scene page tabs (v0.25+ PluginApi.patch.after pattern —
  // see project docs section 8. patch.after, not register.component.)
  // ---------------------------------------------------------------------
  const { Nav, Tab } = PluginApi.libraries.Bootstrap;

  PluginApi.patch.after("ScenePage.Tabs", function ({ children }) {
    const tab = h(Nav.Item, { key: "tagchips-nav" },
      h(Nav.Link, { eventKey: "tagchips-panel" }, "Tag Chips")
    );
    return [...React.Children.toArray(children), tab];
  });

  PluginApi.patch.after("ScenePage.TabContent", function ({ children, ...props }) {
    const scene = props.scene;
    if (!scene) return React.Children.toArray(children);
    const pane = h(
      Tab.Pane,
      { key: "tagchips-pane", eventKey: "tagchips-panel" },
      h(TagChipsPanel, { scene })
    );
    return [...React.Children.toArray(children), pane];
  });
})();
