# SubmitToMyStashBox — Stash plugin

Submits a scene to a configured destination stash-box as a draft edit and
immediately applies (auto-approves) it, via the scene ellipsis menu.

## Local dev setup

This plugin uses **Model B (GitHub Pages install/update)** — see
[`PLUGIN-DEV-GUIDE.md` §15](../../PLUGIN-DEV-GUIDE.md#model-b-github-pages-installupdate)
for the full canonical instructions. In short: push to `main`, then click
**Update** on this plugin in Stash's **Settings → Plugins → Available
Plugins** (pushing alone does not update a running instance). Confirm via
`{ plugins { id version } }` that the commit-hash suffix matches your new
`HEAD` before trusting a "live" test.
