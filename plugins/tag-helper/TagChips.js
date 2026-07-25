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
// Groups may also carry an optional performerId/studioId (add-only for
// performer, replace-with-confirm for studio — see applyGroup()). The
// scene-tab tag grid's sort order (usage vs. alphabetical) is likewise
// stored per-user in the same config, under sortMode.
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
    const categories = Array.isArray(cfg.categories) ? cfg.categories : [];
    return {
      groups: Array.isArray(cfg.groups) ? cfg.groups : [],
      // defaultCollapsed defaults to false for categories saved before this field existed
      categories: categories.map((c) => ({ defaultCollapsed: false, ...c })),
      // "usage" (scene_count desc) matches this plugin's original, undeclared
      // default sort; "alpha" is the only other mode. Anything else in the
      // stored config (unset, corrupt) also falls back to "usage".
      sortMode: cfg.sortMode === "alpha" ? "alpha" : "usage",
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
  // Scene mutations. updateSceneTagIds is used by the per-chip toggle
  // (tag_ids only). updateScene is used by group-apply, which may also
  // need to touch performer_ids / studio_id — only the fields actually
  // being changed are included, since SceneUpdateInput leaves omitted
  // fields untouched (unlike tag_ids/performer_ids, which are whole-array
  // replace when present, per RelationshipUpdateModeSet).
  // ---------------------------------------------------------------------
  async function updateSceneTagIds(sceneId, tagIds) {
    await gql(
      `mutation TagChipsSceneUpdate($input: SceneUpdateInput!) {
         sceneUpdate(input: $input) { id tags { id } }
       }`,
      { input: { id: sceneId, tag_ids: tagIds } }
    );
  }

  async function updateScene(sceneId, fields) {
    await gql(
      `mutation TagChipsSceneUpdate2($input: SceneUpdateInput!) {
         sceneUpdate(input: $input) { id tags { id } performers { id } studio { id } }
       }`,
      { input: { id: sceneId, ...fields } }
    );
  }

  // ---------------------------------------------------------------------
  // Performer / studio search, for the group editor's picker (name-filter
  // queries, same shape already used by Data18StashDB.js / SuperScrape.py
  // in this repo).
  // ---------------------------------------------------------------------
  async function searchPerformers(q) {
    const data = await gql(
      `query TagChipsFindPerformers($q: String) {
         findPerformers(filter: { q: $q, per_page: 8 }) { performers { id name } }
       }`,
      { q }
    );
    return data.findPerformers.performers;
  }

  async function searchStudios(q) {
    const data = await gql(
      `query TagChipsFindStudios($q: String) {
         findStudios(filter: { q: $q, per_page: 8 }) { studios { id name } }
       }`,
      { q }
    );
    return data.findStudios.studios;
  }

  // ---------------------------------------------------------------------
  // Group persistence (config-store based). A group may optionally carry
  // a performerId/studioId (plus a cached label, so the Groups list and
  // apply-confirmation don't need an extra fetch). Groups saved before
  // this field existed simply have performerId/studioId undefined, which
  // every read site already treats as "no performer/studio on this group".
  // ---------------------------------------------------------------------
  async function saveGroup({ id, label, memberTagIds, performerId, performerLabel, studioId, studioLabel }) {
    const current = await readConfig();
    const data = {
      label: label.trim(),
      memberTagIds,
      performerId: performerId || null,
      performerLabel: performerId ? performerLabel : null,
      studioId: studioId || null,
      studioLabel: studioId ? studioLabel : null,
    };
    const groups = id
      ? current.groups.map((g) => (g.id === id ? { ...g, ...data } : g))
      : [...current.groups, { id: genId("grp"), ...data }];
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

  async function saveCategory({ id, label, tagIds, defaultCollapsed }) {
    const current = await readConfig();
    const dc = !!defaultCollapsed;
    let categories;
    if (id) {
      categories = stripFromOtherCategories(current.categories, id, tagIds).map((c) =>
        c.id === id ? { ...c, label: label.trim(), tagIds, defaultCollapsed: dc } : c
      );
    } else {
      const newId = genId("cat");
      categories = [
        ...stripFromOtherCategories(current.categories, newId, tagIds),
        { id: newId, label: label.trim(), tagIds, defaultCollapsed: dc },
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
  // Within each section: sorted per sortMode ("usage" = scene_count desc,
  // the long-standing default; "alpha" = tag name).
  // ---------------------------------------------------------------------
  function tagComparator(sortMode) {
    return sortMode === "alpha"
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => (b.scene_count || 0) - (a.scene_count || 0);
  }

  function buildCategorizedSections(tags, categories, sortMode) {
    const cmp = tagComparator(sortMode);
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const usedIds = new Set();
    const sections = categories.map((cat) => {
      const catTags = cat.tagIds.map((id) => tagById.get(id)).filter(Boolean);
      catTags.forEach((t) => usedIds.add(t.id));
      catTags.sort(cmp);
      return { id: cat.id, label: cat.label, tags: catTags, defaultCollapsed: !!cat.defaultCollapsed };
    });
    const uncategorized = tags.filter((t) => !usedIds.has(t.id));
    uncategorized.sort(cmp);
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
  // Sort-mode toggle for the scene-tab tag grid (persisted via config).
  // ---------------------------------------------------------------------
  function SortToggle({ mode, onChange }) {
    return h("div", { className: "tc-sort-toggle" }, [
      h(
        "button",
        {
          key: "usage",
          className: "tc-sort-btn" + (mode !== "alpha" ? " tc-sort-btn-active" : ""),
          onClick: () => onChange("usage"),
        },
        "Most used"
      ),
      h(
        "button",
        {
          key: "alpha",
          className: "tc-sort-btn" + (mode === "alpha" ? " tc-sort-btn-active" : ""),
          onClick: () => onChange("alpha"),
        },
        "A–Z"
      ),
    ]);
  }

  // ---------------------------------------------------------------------
  // Performer/studio search-and-select, used by the group editor. Shows a
  // debounced search box + result list while nothing is picked, or the
  // picked name with a clear button once one is selected.
  // ---------------------------------------------------------------------
  function EntityPicker({ label, kind, selectedId, selectedLabel, onPick, onClear }) {
    const [query, setQuery] = React.useState("");
    const [results, setResults] = React.useState([]);
    const [busy, setBusy] = React.useState(false);

    React.useEffect(() => {
      if (!query.trim()) {
        setResults([]);
        return;
      }
      let cancelled = false;
      setBusy(true);
      const timer = setTimeout(() => {
        const fn = kind === "performer" ? searchPerformers : searchStudios;
        fn(query.trim())
          .then((r) => {
            if (!cancelled) setResults(r);
          })
          .catch(() => {
            if (!cancelled) setResults([]);
          })
          .finally(() => {
            if (!cancelled) setBusy(false);
          });
      }, 250);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [query, kind]);

    return h("div", { className: "tc-entity-picker" }, [
      h("div", { key: "lbl", className: "tc-section-label" }, label),
      selectedId
        ? h("div", { key: "sel", className: "tc-entity-selected" }, [
            h("span", { key: "n" }, selectedLabel || selectedId),
            h(
              "button",
              { key: "x", type: "button", className: "tc-entity-clear", onClick: onClear },
              "✕"
            ),
          ])
        : h(React.Fragment, { key: "search" }, [
            h("input", {
              key: "in",
              className: "tc-editor-input",
              placeholder: `Search ${kind}s…`,
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
            busy && h("div", { key: "busy", className: "tc-entity-hint" }, "Searching…"),
            results.length > 0 &&
              h(
                "div",
                { key: "results", className: "tc-entity-results" },
                results.map((r) =>
                  h(
                    "div",
                    {
                      key: r.id,
                      className: "tc-entity-result",
                      onClick: () => {
                        onPick(r.id, r.name);
                        setQuery("");
                        setResults([]);
                      },
                    },
                    r.name
                  )
                )
              ),
          ]),
    ]);
  }

  // ---------------------------------------------------------------------
  // Categorized tag grid — Step 4 layout: heading + divider per section,
  // fixed-size chips via CSS grid (see .tc-tag-grid in TagChips.css).
  // ---------------------------------------------------------------------
  function CategorizedTagGrid({ sections, sceneTagIds, pendingIds, errorIds, onToggle }) {
    // Collapse state is local to this render of the panel: seeded once from
    // each category's stored defaultCollapsed, never written back to config.
    // Reopening the tab / revisiting the scene always re-derives from the
    // stored defaults, not from whatever the user last clicked.
    const [collapsedIds, setCollapsedIds] = React.useState(
      () => new Set(sections.filter((s) => s.id !== "__uncategorized" && s.defaultCollapsed).map((s) => s.id))
    );

    function toggleCollapsed(id) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    const nonEmpty = sections.filter((s) => s.tags.length > 0);
    if (nonEmpty.length === 0) {
      return h("span", { style: { color: "#888", fontSize: ".8rem" } }, "No tags match.");
    }
    return h(
      React.Fragment,
      null,
      nonEmpty.map((s) => {
        const collapsible = s.id !== "__uncategorized";
        const collapsed = collapsible && collapsedIds.has(s.id);
        return h("div", { key: s.id, className: "tc-cat-section" }, [
          h(
            "div",
            {
              key: "hd",
              className: "tc-cat-heading" + (collapsible ? " tc-cat-heading-clickable" : ""),
              onClick: collapsible ? () => toggleCollapsed(s.id) : undefined,
            },
            collapsible
              ? [
                  h(
                    "span",
                    {
                      key: "tri",
                      className: "tc-cat-triangle" + (collapsed ? "" : " tc-cat-triangle-expanded"),
                    },
                    "▶"
                  ),
                  s.label,
                ]
              : s.label
          ),
          h("hr", { key: "hr", className: "tc-cat-divider" }),
          !collapsed &&
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
        ]);
      })
    );
  }

  // ---------------------------------------------------------------------
  // Shared create/edit form for both categories and groups: a name input
  // plus a tag-toggle picker. Persistence + delete are injected by the
  // caller (onPersist/onDelete) so this component stays storage-agnostic.
  // ---------------------------------------------------------------------
  function CategoryOrGroupEditor({ allTags, item, noun, allGroups, allCategories, onCancel, onPersist, onSaved, onDelete, onDeleted }) {
    const [label, setLabel] = React.useState(item ? item.label : "");
    const [selectedIds, setSelectedIds] = React.useState(new Set(item ? item.selectedIds : []));
    const [defaultCollapsed, setDefaultCollapsed] = React.useState(item ? !!item.defaultCollapsed : false);
    const [performerId, setPerformerId] = React.useState(item && item.performerId ? item.performerId : null);
    const [performerLabel, setPerformerLabel] = React.useState(item ? item.performerLabel || "" : "");
    const [studioId, setStudioId] = React.useState(item && item.studioId ? item.studioId : null);
    const [studioLabel, setStudioLabel] = React.useState(item ? item.studioLabel || "" : "");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");

    // Tags already claimed by some *other* group/category don't show as
    // available to pick here — makes it easier to see what's left
    // unassigned when building either one. The item being edited never
    // excludes its own current members (so re-opening it still shows its
    // own tags); the two branches are otherwise the same self-exclusion
    // logic, just sourced from a different array/field (groups store
    // memberTagIds, categories store tagIds).
    const claimedTagIds = React.useMemo(() => {
      if (noun === "Group") {
        if (!allGroups) return new Set();
        const set = new Set();
        allGroups.forEach((g) => {
          if (item && g.id === item.id) return;
          (g.memberTagIds || []).forEach((id) => set.add(id));
        });
        return set;
      }
      if (noun === "Category") {
        if (!allCategories) return new Set();
        const set = new Set();
        allCategories.forEach((c) => {
          if (item && c.id === item.id) return;
          (c.tagIds || []).forEach((id) => set.add(id));
        });
        return set;
      }
      return new Set();
    }, [noun, allGroups, allCategories, item]);

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
        await onPersist({
          id: item ? item.id : null,
          label: label.trim(),
          tagIds: Array.from(selectedIds),
          defaultCollapsed,
          performerId,
          performerLabel,
          studioId,
          studioLabel,
        });
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
      noun === "Category" &&
        h("label", { className: "tc-checkbox-row" }, [
          h("input", {
            key: "cb",
            type: "checkbox",
            checked: defaultCollapsed,
            onChange: (e) => setDefaultCollapsed(e.target.checked),
          }),
          " Start collapsed",
        ]),
      noun === "Group" &&
        h("div", { className: "tc-entity-pickers" }, [
          h(EntityPicker, {
            key: "performer",
            label: "Performer (optional, add-only)",
            kind: "performer",
            selectedId: performerId,
            selectedLabel: performerLabel,
            onPick: (id, name) => {
              setPerformerId(id);
              setPerformerLabel(name);
            },
            onClear: () => {
              setPerformerId(null);
              setPerformerLabel("");
            },
          }),
          h(EntityPicker, {
            key: "studio",
            label: "Studio (optional, replaces the scene's studio)",
            kind: "studio",
            selectedId: studioId,
            selectedLabel: studioLabel,
            onPick: (id, name) => {
              setStudioId(id);
              setStudioLabel(name);
            },
            onClear: () => {
              setStudioId(null);
              setStudioLabel("");
            },
          }),
        ]),
      error && h("div", { className: "tc-error-bar" }, error),
      (() => {
        const availableTags = allTags.filter((t) => !selectedIds.has(t.id) && !claimedTagIds.has(t.id));
        const usedTags = allTags.filter((t) => selectedIds.has(t.id));
        const hiddenByOtherContainers = allTags.filter(
          (t) => !selectedIds.has(t.id) && claimedTagIds.has(t.id)
        ).length;
        return h(React.Fragment, null, [
          availableTags.length > 0
            ? h(React.Fragment, { key: "available" }, [
                h("div", { key: "hd", className: "tc-section-label" }, "Available"),
                h(
                  "div",
                  { key: "grid", className: "tc-grid" },
                  availableTags.map((t) =>
                    h(Chip, { key: t.id, label: t.name, active: false, onClick: () => toggle(t.id) })
                  )
                ),
              ])
            : hiddenByOtherContainers > 0 &&
              h(
                "div",
                { key: "none-left", style: { color: "#888", fontSize: ".8rem" } },
                `No unassigned tags left — every remaining tag is already in another ${
                  noun === "Category" ? "category" : "group"
                }.`
              ),
          usedTags.length > 0 &&
            h(React.Fragment, { key: "used" }, [
              h("hr", { key: "hr", className: "tc-cat-divider" }),
              h("div", { key: "hd", className: "tc-section-label" }, "Used Tags"),
              h(
                "div",
                { key: "grid", className: "tc-grid" },
                usedTags.map((t) =>
                  h(Chip, { key: t.id, label: t.name, active: true, onClick: () => toggle(t.id) })
                )
              ),
            ]),
        ]);
      })()
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
      const item = editing
        ? { id: editing.id, label: editing.label, selectedIds: editing.tagIds, defaultCollapsed: editing.defaultCollapsed }
        : null;
      return h(CategoryOrGroupEditor, {
        allTags,
        item,
        noun: "Category",
        allCategories: categories,
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
      const item = editing
        ? {
            id: editing.id,
            label: editing.label,
            selectedIds: editing.memberTagIds,
            performerId: editing.performerId,
            performerLabel: editing.performerLabel,
            studioId: editing.studioId,
            studioLabel: editing.studioLabel,
          }
        : null;
      return h(CategoryOrGroupEditor, {
        allTags,
        item,
        noun: "Group",
        allGroups: groups,
        onCancel: () => setEditing(undefined),
        onPersist: (data) =>
          saveGroup({
            id: data.id,
            label: data.label,
            memberTagIds: data.tagIds,
            performerId: data.performerId,
            performerLabel: data.performerLabel,
            studioId: data.studioId,
            studioLabel: data.studioLabel,
          }),
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
                g.performerLabel && h("span", { key: "perf", className: "tc-entity-badge" }, `🎭 ${g.performerLabel}`),
                g.studioLabel && h("span", { key: "studio", className: "tc-entity-badge" }, `🏢 ${g.studioLabel}`),
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
    const [config, setConfig] = React.useState({ groups: [], categories: [], sortMode: "usage" });
    const [sceneTagIds, setSceneTagIds] = React.useState(
      () => new Set((scene.tags || []).map((t) => t.id))
    );
    const [scenePerformerIds, setScenePerformerIds] = React.useState(
      () => new Set((scene.performers || []).map((p) => p.id))
    );
    const [sceneStudioId, setSceneStudioId] = React.useState(() => (scene.studio ? scene.studio.id : null));
    const [sceneStudioLabel, setSceneStudioLabel] = React.useState(() => (scene.studio ? scene.studio.name : ""));
    const [search, setSearch] = React.useState("");
    const [pendingIds, setPendingIds] = React.useState(new Set());
    const [errorIds, setErrorIds] = React.useState(new Set());
    const [error, setError] = React.useState("");
    const [modalOpen, setModalOpen] = React.useState(false);
    // Set only when applyGroup() hits a studio conflict — holds everything
    // needed to finish the apply once the user resolves the inline banner
    // (Confirm/Cancel), instead of firing a blocking window.confirm().
    const [groupConflict, setGroupConflict] = React.useState(null);

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

    // Keep local state in sync if the user edits tags/performers/studio
    // elsewhere and comes back
    React.useEffect(() => {
      setSceneTagIds(new Set((scene.tags || []).map((t) => t.id)));
      setScenePerformerIds(new Set((scene.performers || []).map((p) => p.id)));
      setSceneStudioId(scene.studio ? scene.studio.id : null);
      setSceneStudioLabel(scene.studio ? scene.studio.name : "");
      setGroupConflict(null); // stale banner would reference the old scene's studio
    }, [scene.id, scene.tags, scene.performers, scene.studio]);

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

    // Entry point from a group chip click. Tags/performer/studio are still
    // applied as one atomic write (matching the single-mutation shape the
    // rest of this flow already uses) — so when the group's studio would
    // replace a *different* existing studio, nothing is written yet; the
    // whole apply (tags + performer + studio together) waits behind the
    // inline confirm banner instead of firing immediately.
    async function applyGroup(group) {
      const missingTagIds = group.memberTagIds.filter((id) => !sceneTagIds.has(id));
      const addPerformerId =
        group.performerId && !scenePerformerIds.has(group.performerId) ? group.performerId : null;
      const changeStudio = !!group.studioId && group.studioId !== sceneStudioId;

      if (missingTagIds.length === 0 && !addPerformerId && !changeStudio) return; // nothing to do

      if (changeStudio && sceneStudioId) {
        setGroupConflict({ group, missingTagIds, addPerformerId });
        return;
      }

      await performGroupApply(group, missingTagIds, addPerformerId, changeStudio);
    }

    async function confirmGroupConflict() {
      if (!groupConflict) return;
      const { group, missingTagIds, addPerformerId } = groupConflict;
      setGroupConflict(null);
      await performGroupApply(group, missingTagIds, addPerformerId, true);
    }

    function cancelGroupConflict() {
      setGroupConflict(null);
    }

    async function performGroupApply(group, missingTagIds, addPerformerId, changeStudio) {
      const nextTagIds = new Set([...sceneTagIds, ...missingTagIds]);
      const nextPerformerIds = new Set(scenePerformerIds);
      if (addPerformerId) nextPerformerIds.add(addPerformerId);

      const prevTagIds = sceneTagIds;
      const prevPerformerIds = scenePerformerIds;
      const prevStudioId = sceneStudioId;
      const prevStudioLabel = sceneStudioLabel;

      // optimistic update
      setSceneTagIds(nextTagIds);
      setScenePerformerIds(nextPerformerIds);
      if (changeStudio) {
        setSceneStudioId(group.studioId);
        setSceneStudioLabel(group.studioLabel || "");
      }
      missingTagIds.forEach((id) => markPending(id, true));
      missingTagIds.forEach((id) => markError(id, false));
      setError("");

      const fields = {};
      if (missingTagIds.length) fields.tag_ids = Array.from(nextTagIds);
      if (addPerformerId) fields.performer_ids = Array.from(nextPerformerIds);
      if (changeStudio) fields.studio_id = group.studioId;

      try {
        await updateScene(scene.id, fields);
      } catch (e) {
        // revert on failure
        setSceneTagIds(prevTagIds);
        setScenePerformerIds(prevPerformerIds);
        setSceneStudioId(prevStudioId);
        setSceneStudioLabel(prevStudioLabel);
        missingTagIds.forEach((id) => markError(id, true));
        setError(`Failed to apply group "${group.label}": ${e.message}`);
      } finally {
        missingTagIds.forEach((id) => markPending(id, false));
      }
    }

    async function changeSortMode(mode) {
      if (mode === config.sortMode) return;
      const prev = config;
      setConfig({ ...config, sortMode: mode }); // optimistic
      try {
        await writeConfig({ sortMode: mode });
      } catch (e) {
        setConfig(prev);
        setError(e.message);
      }
    }

    const filteredTags = search.trim()
      ? allTags.filter((t) => t.name.toLowerCase().includes(search.trim().toLowerCase()))
      : allTags;
    const sections = buildCategorizedSections(filteredTags, config.categories, config.sortMode);

    return h("div", { className: "tc-panel" }, [
      h("div", { key: "top", className: "tc-panel-top" }, [
        h("div", { key: "hdr", className: "tc-editor-row" }, [
          h("input", {
            key: "search",
            className: "tc-search",
            style: { flex: 1 },
            placeholder: "Filter tags…",
            value: search,
            onChange: (e) => setSearch(e.target.value),
          }),
          h(SortToggle, { key: "sort", mode: config.sortMode, onChange: changeSortMode }),
          h(
            "button",
            { key: "manage", className: "btn btn-secondary btn-sm", onClick: () => setModalOpen(true) },
            "Manage Tags"
          ),
        ]),
        error && h("div", { key: "err", className: "tc-error-bar" }, error),
        groupConflict &&
          h("div", { key: "conflict", className: "tc-warning-bar" }, [
            h(
              "span",
              { key: "msg" },
              `This group will change the studio from "${sceneStudioLabel}" to ` +
                `"${groupConflict.group.studioLabel || groupConflict.group.studioId}".`
            ),
            h("div", { key: "actions", className: "tc-warning-actions" }, [
              h(
                "button",
                { key: "confirm", className: "btn btn-primary btn-sm", onClick: confirmGroupConflict },
                "Confirm"
              ),
              h(
                "button",
                { key: "cancel", className: "btn btn-secondary btn-sm", onClick: cancelGroupConflict },
                "Cancel"
              ),
            ]),
          ]),

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
      ]),

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
