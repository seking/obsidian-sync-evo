# Sync Evo

Sync Evo is a plugin for [Obsidian](https://obsidian.md) that is being built to sync large vaults, with a focus on mobile.

## Status

Under development. The current version has a settings screen where you enter the repository, the branch, the token, and a name for the device, and can test the connection. It has one command, "Pull", which brings the vault in line with the repository: it fetches the files that are new or changed there, and deletes the ones that were deleted there. It does not send anything to the repository yet, and nothing runs on its own.

A file that was changed both in the vault and in the repository is not overwritten: the repository's version takes the name, and the vault's version is kept beside it as `<name>.conflict-from-<device>-<date>-<time>.<extension>`. A file in the configuration folder gets no such copy: the vault's version goes to `.trash/` in the vault. Before a pull deletes many files, or follows a history that was rewritten, it stops and asks.

The settings and the record of what was synced are kept on the device, outside the vault. The token is kept in Obsidian's Keychain; the settings hold only the name it is saved under.

## Network use

Sync Evo makes network requests only when you press "Test connection" in its settings or run the "Pull" command. All of them go to GitHub (`api.github.com`) and carry the token and the names of the repository and the branch. One kind of request, the download of a zip described below, is redirected by GitHub to another of its hosts (`codeload.github.com`).

- "Test connection" asks for the branch you entered, and for the repository when the branch is not found, to tell you whether the token can reach them.
- "Pull" asks for the branch (and, like the test, for the repository when the branch is not found), for the list of files in its latest commit, and for the content of each file that is new or changed. For a symbolic link, which is not written to the vault, it reads where the link points: one small request per link that is new or changed. When the branch has moved since the last pull, it also asks whether the new commit builds on the old one. When more than 1,000 files are new or changed (a first pull of a large repository, for one), it asks for the zip of that commit in one request instead of for each file, and then only for the files the zip does not hold as they are listed. The zip is kept in memory and never saved.

Nothing from the vault is sent: no file, no file name, and no content.

This section will list each service the plugin contacts, and what is sent and why, as more features are added.

## Development

Requires Node.js and npm.

```sh
npm install
npm run dev      # rebuild main.js on change
npm run build    # type check, then production build of main.js
npm test         # unit tests
```

### Source layout

`src/core/` holds the parts that do not depend on where they run: the interface a remote implements, and the decision of what to fetch, send, and delete. Code there must not import `obsidian` (a types-only package that the tests cannot load) or any Node API (the mobile app has none); a test checks this. Code that touches the Obsidian API stays outside `src/core/` and is kept thin.

The in-memory remote used by the tests is in `tests/support/`.

Every text the plugin shows comes from `src/core/i18n/`, never from a string written where it is used; a test searches the code outside `src/core/` for a string given to `setName`, `Notice`, and the like. To add a message, add it to `en.ts` (the base) and to `ja.ts`, and read it through the plugin's `t("key", { name: value })`; placeholders are `{name}`, and a message that changes with a number is written as `{ one: "{count} file", other: "{count} files" }`. The build fails if Japanese lacks a key, has one the base does not, or names a placeholder differently. The type check also stops an empty message, a misnamed or empty plural form, and an `other` form that drops a placeholder, while the tests (`npm test`, which `npm run build` does not run) stop what the types cannot see, such as text that is only spaces. To add a language, add its file (with `partialTranslation` while it is incomplete; missing messages are shown in English) and register it in `index.ts` under the code Obsidian uses for that language.

The names of the file type and vault configuration options follow the wording of the same options of Obsidian Sync in the app ([obsidian-translations](https://github.com/obsidianmd/obsidian-translations)), so that they read the same in each language.

### Installing into a vault

`npm run install:vault` copies `main.js` and `manifest.json` (and `styles.css`, if present) into `<vault>/.obsidian/plugins/sync-evo/`.

Set the vault folder in the `SYNC_EVO_VAULT` environment variable, or copy `.env.example` to `.env.local` (ignored by git) and edit it there.

```sh
npm run build
SYNC_EVO_VAULT=/path/to/your/vault npm run install:vault
```

Then enable Sync Evo under Settings → Community plugins. Reload the app, or turn the plugin off and on, after installing a new build.

### Testing on a phone

`npm run release:beta` creates a GitHub prerelease of the current commit, tagged `<version>-beta.<N>`, with `main.js` and a `manifest.json` carrying that version attached. It needs the [GitHub CLI](https://cli.github.com) (`gh`), a clean working tree, and the commit pushed. Add `-- --dry-run` to see what it would do without creating the release.

On the phone, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository as a beta plugin. While the repository is private, create a fine-grained personal access token that can only read the Contents of this repository, and select it as the GitHub token when adding the repository in BRAT. BRAT keeps the token in the app's secret storage. To pick up a newer beta, use BRAT's check for updates.

## License

Copyright (C) 2026 seking

Sync Evo is free software licensed under the GNU Affero General Public License, version 3. See [LICENSE](LICENSE) for the full text. It comes with no warranty.

The source code is at <https://github.com/seking/obsidian-sync-evo>.

### Third-party licences

The distributed `main.js` bundles the packages below. Their copyright notices and the text of their licence are also at the top of `main.js`.

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett |
| [ignore](https://github.com/kaelzhang/node-ignore) | 7.0.12 | MIT | Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors |
