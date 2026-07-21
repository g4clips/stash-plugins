# Standing instructions for this repo

## 1. Propose, then wait
Before writing or applying ANY change to any file, show the full diff (or
complete new file content, if the file is new) as plain text in the
response, then STOP. Do not call Edit/Write against the actual file until
the user explicitly approves that specific diff.

This applies to small changes too, and applies mid-task, not just at the
start of a request. If a file has already been modified by the time the
user sees the message, that is not acceptable — only a proposal counts as
"showing" a change; an applied edit does not retroactively count as having
asked. When unsure whether something counts as "a change," treat it as one
and propose it first.

## 2. Version bump travels with the diff
Any functional change to a plugin's `.py`/`.js`/`.css` (new feature, bug
fix, behavior change — not pure documentation/README edits) must include a
version bump to that plugin's `.yml` in the SAME proposed diff, not as a
follow-up or something the user has to ask for separately.

Convention (matches this repo's git history): patch (x.x.X) for fixes,
minor (x.X.0) for features/new capability, major (X.0.0) for breaking
changes.

## Local dev plugin sync
Every plugin in this repo uses the same deployment model (GitHub Pages
install/update) — a plugin built/edited in the git tree is NOT
automatically live in the local Stash instance; it requires a push to
`main` AND a manual "Update" click in Stash. See `PLUGIN-DEV-GUIDE.md`
§15 for the full canonical instructions, including how to verify via
GraphQL (`{ plugins { id version } }`) that a deploy actually landed
before trusting any "live" test.
