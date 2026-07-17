// TagChips.js
// Adds a "Tags" tab to the Scene page: click chips to toggle tags on the
// current scene in real time, plus preset "groups" of tags applied in one click.
//
// Storage trick for groups (no native concept in Stash): a group is a normal
// Stash tag named "zzz-group:<Group Name>" whose `description` field holds
// JSON: { "memberTagIds": ["12","47","103"] }. The zzz- prefix keeps them
// sorted out of the way in ordinary tag pickers/lists.
//
// See project docs: stash-plugin-dev-notes-2026-07-15-v2.md sections 3, 4, 8, 13
// for the GraphQL / PluginApi patterns this file follows.

(function () {
  const { React } = PluginApi;
  const h = React.createElement;

  const GROUP_PREFIX = "zzz-group:";

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

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  async function fetchAllTags() {
    const data = await gql(`
      query TagChipsAllTags {
        findTags(filter: { per_page: -1, sort: "name", direction: ASC }) {
          tags { id name description }
        }
      }
    `);
    return data.findTags.tags;
  }

  function splitTagsAndGroups(allTags) {
    const tags = [];
    const groups = [];
    for (const t of allTags) {
      if (t.name.startsWith(GROUP_PREFIX)) {
        let memberTagIds = [];
        try {
          memberTagIds = JSON.parse(t.description || "{}").memberTagIds || [];
        } catch (_) {
          /* malformed — treat as empty group, editable to fix */
        }
        groups.push({
          id: t.id,
          label: t.name.slice(GROUP_PREFIX.length),
          memberTagIds,
        });
      } else {
        tags.push(t);
      }
    }
    return { tags, groups };
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
  // Group persistence (create / update / delete the backing tag)
  // ---------------------------------------------------------------------
  async function saveGroup({ id, label, memberTagIds }) {
    const name = GROUP_PREFIX + label.trim();
    const description = JSON.stringify({ memberTagIds });
    if (id) {
      await gql(
        `mutation TagChipsGroupUpdate($input: TagUpdateInput!) {
           tagUpdate(input: $input) { id }
         }`,
        { input: { id, name, description } }
      );
    } else {
      await gql(
        `mutation TagChipsGroupCreate($input: TagCreateInput!) {
           tagCreate(input: $input) { id }
         }`,
        { input: { name, description } }
      );
    }
  }

  async function deleteGroup(id) {
    await gql(
      `mutation TagChipsGroupDestroy($id: ID!) { tagDestroy(input: { id: $id }) }`,
      { id }
    );
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
      { className: cls, onClick: pending ? undefined : onClick },
      label
    );
  }

  // ---------------------------------------------------------------------
  // Group editor sub-view: create/edit a preset's name + member tags
  // ---------------------------------------------------------------------
  function GroupEditor({ allTags, group, onCancel, onSaved, onDeleted }) {
    const [label, setLabel] = React.useState(group ? group.label : "");
    const [memberIds, setMemberIds] = React.useState(
      new Set(group ? group.memberTagIds : [])
    );
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");

    function toggleMember(id) {
      setMemberIds((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function handleSave() {
      if (!label.trim()) {
        setError("Group name is required.");
        return;
      }
      setBusy(true);
      setError("");
      try {
        await saveGroup({
          id: group ? group.id : null,
          label,
          memberTagIds: Array.from(memberIds),
        });
        onSaved();
      } catch (e) {
        setError(e.message);
        setBusy(false);
      }
    }

    async function handleDelete() {
      if (!group) return;
      setBusy(true);
      try {
        await deleteGroup(group.id);
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
          placeholder: "Group name",
          value: label,
          onChange: (e) => setLabel(e.target.value),
        }),
        h(
          "button",
          { key: "save", className: "btn btn-primary btn-sm", disabled: busy, onClick: handleSave },
          group ? "Save" : "Create"
        ),
        group &&
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
      h("div", { className: "tc-section-label" }, "Member tags"),
      h(
        "div",
        { className: "tc-grid" },
        allTags.map((t) =>
          h(Chip, {
            key: t.id,
            label: t.name,
            active: memberIds.has(t.id),
            onClick: () => toggleMember(t.id),
          })
        )
      )
    );
  }

  // ---------------------------------------------------------------------
  // Main panel
  // ---------------------------------------------------------------------
  function TagChipsPanel({ scene }) {
    const [allTags, setAllTags] = React.useState([]);
    const [groups, setGroups] = React.useState([]);
    const [sceneTagIds, setSceneTagIds] = React.useState(
      () => new Set((scene.tags || []).map((t) => t.id))
    );
    const [search, setSearch] = React.useState("");
    const [pendingIds, setPendingIds] = React.useState(new Set());
    const [errorIds, setErrorIds] = React.useState(new Set());
    const [error, setError] = React.useState("");
    const [editingGroup, setEditingGroup] = React.useState(undefined); // undefined=hidden, null=new, obj=edit

    const loadAll = React.useCallback(() => {
      fetchAllTags()
        .then((raw) => {
          const { tags, groups } = splitTagsAndGroups(raw);
          setAllTags(tags);
          setGroups(groups);
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

    if (editingGroup !== undefined) {
      return h(GroupEditor, {
        allTags,
        group: editingGroup,
        onCancel: () => setEditingGroup(undefined),
        onSaved: () => {
          setEditingGroup(undefined);
          loadAll();
        },
        onDeleted: () => {
          setEditingGroup(undefined);
          loadAll();
        },
      });
    }

    const filtered = search.trim()
      ? allTags.filter((t) =>
          t.name.toLowerCase().includes(search.trim().toLowerCase())
        )
      : allTags;

    return h(
      "div",
      { className: "tc-panel" },
      error && h("div", { className: "tc-error-bar" }, error),

      h("div", { className: "tc-editor-row" }, [
        h("span", { key: "lbl", className: "tc-section-label", style: { margin: 0 } }, "Groups"),
        h(
          "button",
          {
            key: "new",
            className: "tc-group-manage-btn",
            onClick: () => setEditingGroup(null),
          },
          "+ new group"
        ),
      ]),
      h(
        "div",
        { className: "tc-grid" },
        groups.length === 0
          ? h("span", { style: { color: "#888", fontSize: ".8rem" } }, "No groups yet.")
          : groups.map((g) =>
              h(
                "span",
                { key: g.id, style: { display: "inline-flex", alignItems: "center", gap: ".3rem" } },
                h(Chip, {
                  label: g.label,
                  variant: "group",
                  onClick: () => applyGroup(g),
                }),
                h(
                  "button",
                  {
                    className: "tc-group-manage-btn",
                    onClick: () => setEditingGroup(g),
                  },
                  "edit"
                )
              )
            )
      ),

      h("div", { className: "tc-section-label" }, "Tags"),
      h("input", {
        className: "tc-search",
        placeholder: "Filter tags…",
        value: search,
        onChange: (e) => setSearch(e.target.value),
      }),
      h(
        "div",
        { className: "tc-grid" },
        filtered.map((t) =>
          h(Chip, {
            key: t.id,
            label: t.name,
            active: sceneTagIds.has(t.id),
            pending: pendingIds.has(t.id),
            error: errorIds.has(t.id),
            onClick: () => toggleTag(t.id),
          })
        )
      )
    );
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
