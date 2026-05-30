# Data18StashDB

A [Stash](https://github.com/stashapp/stash) plugin that scrapes scene metadata from [Data18](https://www.data18.com) and matches it against your [StashDB](https://stashdb.org) instance.

## Features

- Adds a **Data18** button to every scene page in Stash
- Paste a `data18.com/scenes/` URL → scrapes metadata and searches StashDB in one step
- Paste a `data18.com/movies/` URL → shows a scene picker, then enters the same flow
- Side-by-side comparison of current vs incoming values before applying anything
- Per-performer and per-tag selection with local Stash match status badges
- All HTTP requests run server-side (no CORS issues)

## Requirements

- Stash v24+
- Python 3.9+
- Python dependencies: `pip install requests beautifulsoup4`
- A [StashDB](https://stashdb.org) account and API key

## Installation

### Via Plugin Source (recommended)

1. In Stash go to **Settings → Plugins → Available Plugins → Add Source**
2. Name: `g4clips plugins`
3. URL: `https://g4clips.github.io/stash-plugins/main/index.yml`
4. Find **Data18StashDB** and click Install

### Manual

1. Download the latest zip from [Releases](../../releases)
2. Extract into your Stash plugins directory (e.g. `~/.stash/plugins/Data18StashDB/`)
3. Copy `config.ini.example` to `config.ini` and fill in your StashDB API key
4. In Stash go to **Settings → Plugins → Reload Plugins**

## Configuration

Copy `config.ini.example` to `config.ini` in the plugin folder and add your StashDB API key:

```ini
[StashDB]
api_key = your_stashdb_api_key_here
url = https://stashdb.org/graphql
```

Get your API key from [stashdb.org](https://stashdb.org) → Profile → API Key.

## Usage

1. Open any scene in Stash
2. Click the **Data18** button in the scene toolbar
3. Paste a `data18.com/scenes/` or `data18.com/movies/` URL
4. For movie URLs: pick the matching scene from the list
5. Review the StashDB candidates and select the best match
6. Check which fields to apply in the comparison table
7. Click **Apply to Scene**

## License

AGPL-3.0
