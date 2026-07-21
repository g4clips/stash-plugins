# SuperScrape — Stash plugin

Unified scraper for iWantClips, ManyVids, Clips4Sale, and goddesssnow.com,
matching against local Stash. Adds a Scrape button to scene pages.

## Local dev setup

This plugin uses **Model A (manual copy)** — see
[`PLUGIN-DEV-GUIDE.md` §15](../../PLUGIN-DEV-GUIDE.md#model-a-manual-copy-robocopy)
for the full canonical instructions, including the GraphQL steps to
verify a deploy actually landed (this plugin is the reason that
verification step exists at all — see the incident noted there).

```powershell
robocopy C:\Users\<you>\Documents\stash-plugins\plugins\SuperScrape `
    C:\Users\<you>\.stash\plugins\SuperScrape /MIR /XD __pycache__
```

Then in Stash: Settings → Plugins → Reload Plugins. **Re-run the robocopy
after every source edit** — there's no live symlink.
