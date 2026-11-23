# {{SOURCE_NAME}}

{{SOURCE_DESCRIPTION}}

> [!WARNING]
> Plugins run with full access to Discord and your computer. Only install plugins from sources you trust.

## Table of Contents

{{TOC}}

## Installation

### Add this repo as a plugin source (recommended)

Requires [CrusherD2's Vencord fork](https://github.com/CrusherD2/Vencord) installed from source.

1. Open **Settings → Vencord → Plugins**.
2. Under **Plugin sources**, paste `{{REPOSITORY}}` and click **Add**.
3. Every plugin below now appears in the plugin list. Switch on the ones you want and click **Install & restart**.

### Install a single plugin from a .zip

1. Click **Download .zip** under any plugin below.
2. Drop it on **Add plugins** in **Settings → Vencord → Plugins** (CrusherD2's fork), or extract it into `src/userplugins` of any Vencord source install and rebuild.

## Plugins

{{PLUGINS}}

## Making your own plugin source

Any public GitHub repo with this layout works as a source:

```
plugins.json            generated list of plugins (read by the Vencord fork)
plugins/<folder>/       one folder per plugin
    index.ts(x)         plugin entry point
    plugin.json         name, description, category, version, authors
    README.md           details shown on GitHub
```

Folder suffixes like `.desktop` limit where a plugin is built, the same as in Vencord.

### Adding a plugin to this repo

1. Create `plugins/<folder>/` with the plugin code, a `plugin.json` and a `README.md`.
2. Run `node scripts/generate.mjs` to update `plugins.json` and this README.
3. Commit and push. CI checks that both files are up to date and publishes a `.zip` for every plugin.

### Updating a plugin

1. Change the code and raise `version` in its `plugin.json` (for example `1.0.0` → `1.1.0`).
2. Run `node scripts/generate.mjs`, then commit and push.

Anyone who installed it from this source sees **UPDATE** on the plugin card and an **Update all & restart** bar in the Plugins tab. Versions are compared number by number, so `1.10.0` is newer than `1.9.0`.

## License

[GPL-3.0](LICENSE). Each plugin is credited to its author above.
