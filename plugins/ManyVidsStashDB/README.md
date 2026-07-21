# ManyVidsStashDB — Stash plugin

Scrapes ManyVids and matches against local Stash. Adds a Scrape button to
scene pages.

## Local dev setup

This plugin uses **Model A (manual copy)** — see
[`PLUGIN-DEV-GUIDE.md` §15](../../PLUGIN-DEV-GUIDE.md#model-a-manual-copy-robocopy)
for the full canonical instructions, including the GraphQL steps to verify
a deploy actually landed.

```powershell
robocopy C:\Users\<you>\Documents\stash-plugins\plugins\ManyVidsStashDB `
    C:\Users\<you>\.stash\plugins\ManyVidsStashDB /MIR /XD __pycache__
```

Then in Stash: Settings → Plugins → Reload Plugins. **Re-run the robocopy
after every source edit** — there's no live symlink.
