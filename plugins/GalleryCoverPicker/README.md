# Gallery Cover Picker

Choose a gallery's cover image from its own images, using the same two entry
points scenes use for their cover:

- **Edit tab:** a **Set cover…** button under *Cover Image*.
- **Ellipsis menu:** a **Set cover…** item next to *Reset cover*.
- **Image page:** a **Set as gallery cover** item in an image's ⋮ menu
  (one item per gallery if the image is in several).

Both open a paginated thumbnail picker for the gallery's images. Click to
select then **Set as cover**, or double-click to apply immediately. The current
cover is badged.

It calls Stash's existing `setGalleryCover` mutation (via
`PluginApi.utils.StashService.mutateSetGalleryCover`, with a plain GraphQL
fallback), so covers refresh in place without a reload and unsaved edits in the
Edit tab are kept. No backend task, no config.

## Install

Copy this folder into your Stash `plugins` directory, then
**Settings → Plugins → Reload plugins** and hard-refresh the browser
(`Ctrl+Shift+R`). Plugin JS is cached by the browser, not by Stash.

## Notes

- Injection uses a persistent `MutationObserver` because the ellipsis
  `Dropdown.Menu` only mounts the first time it is opened.
- Only images that belong to the gallery can be chosen; that is a Stash rule
  for gallery covers.
