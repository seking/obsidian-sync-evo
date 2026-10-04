# Sync Evo

Sync Evo is a plugin for [Obsidian](https://obsidian.md) that is being built to sync large vaults, with a focus on mobile.

## Status

Under development. The current version is an empty plugin: it loads and unloads, and does nothing else. It does not sync anything yet.

## Network use

Sync Evo does not make any network requests yet. This section will list each service the plugin contacts, and what is sent and why, as those features are added.

## Development

Requires Node.js and npm.

```sh
npm install
npm run dev      # rebuild main.js on change
npm run build    # type check, then production build of main.js
npm test         # unit tests
```

### Installing into a vault

`npm run install:vault` copies `main.js` and `manifest.json` (and `styles.css`, if present) into `<vault>/.obsidian/plugins/sync-evo/`.

Set the vault folder in the `SYNC_EVO_VAULT` environment variable, or copy `.env.example` to `.env.local` (ignored by git) and edit it there.

```sh
npm run build
SYNC_EVO_VAULT=/path/to/your/vault npm run install:vault
```

Then enable Sync Evo under Settings → Community plugins. Reload the app, or turn the plugin off and on, after installing a new build.

## License

Copyright (C) 2026 seking

Sync Evo is free software licensed under the GNU Affero General Public License, version 3. See [LICENSE](LICENSE) for the full text. It comes with no warranty.

The source code is at <https://github.com/seking/obsidian-sync-evo>.
