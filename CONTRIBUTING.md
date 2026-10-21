# Contributing

## Development

Requires Node.js and npm.

```sh
npm install
npm run dev      # rebuild main.js on change
npm run build    # type check and lint, then production build of main.js
npm test         # unit tests
```

## Source layout

`src/core/` holds the parts that do not depend on where they run: the interface a remote implements, and the decision of what to download, upload, and delete.

- Code there must not import `obsidian` (a types-only package that the tests cannot load) or any Node API (the mobile app has none). A test checks this.
- Code that touches the Obsidian API stays outside `src/core/` and is kept thin.

The in-memory remote used by the tests is in `tests/support/`.

`pro/` holds Dropbox, Google Drive and the license key check, with their tests. It is under another license; see [Contributions and licenses](#contributions-and-licenses).

## Text and translations

Every text the plugin shows comes from `src/core/i18n/`, never from a string written where it is used. A test searches the code outside `src/core/` for a string given to `setName`, `Notice`, and the like.

To add a message:

- Add it to `en.ts` (the base) and to `ja.ts`.
- Read it through the plugin's `t("key", { name: value })`.
- Placeholders are `{name}`.
- A message that changes with a number is written as `{ one: "{count} file", other: "{count} files" }`.

What is checked:

- The build fails if Japanese lacks a key, has one the base does not, or names a placeholder differently.
- The type check also stops an empty message, a misnamed or empty plural form, and an `other` form that drops a placeholder.
- The tests (`npm test`, which `npm run build` does not run) stop what the types cannot see, such as text that is only spaces.

To add a language, add its file and register it in `index.ts` under the code Obsidian uses for that language. Mark the file with `partialTranslation` while it is incomplete. Missing messages are shown in English.

The names of the file type and vault configuration options follow the wording of the same options of Obsidian Sync in the app ([obsidian-translations](https://github.com/obsidianmd/obsidian-translations)), so that they read the same in each language.

## The Google client secret

The client secret of Sync Evo's Google client is not in the repository: Google's OAuth 2.0 Policies ask that client credentials not be committed to a public one. The build puts it into `main.js`, taken from the environment variable `SYNC_EVO_GOOGLE_CLIENT_SECRET`, or else from the file `~/.config/sync-evo/google-client-secret` (the value alone). Without either, `npm run build` warns and makes a `main.js` that cannot connect to Google Drive; `npm run release:beta` fails.

## Installing into a vault

`npm run install:vault` copies `main.js` and `manifest.json` (and `styles.css`, if present) into `<vault>/.obsidian/plugins/sync-evo/`.

Set the vault folder in the `SYNC_EVO_VAULT` environment variable. Or copy `.env.example` to `.env.local` (ignored by git) and edit it there.

```sh
npm run build
SYNC_EVO_VAULT=/path/to/your/vault npm run install:vault
```

Then enable Sync Evo under Settings → Community plugins. After installing a new build, reload the app, or turn the plugin off and on.

## Testing on a phone

`npm run release:beta` creates a GitHub prerelease of the current commit, tagged `<version>-beta.<N>`. It attaches `main.js` and a `manifest.json` carrying that version.

- It needs the [GitHub CLI](https://cli.github.com) (`gh`), a clean working tree, and the commit pushed.
- Add `-- --dry-run` to see what it would do without creating the release.

On the phone, install [BRAT](https://github.com/TfTHacker/obsidian42-brat) and add this repository as a beta plugin. To pick up a newer beta, use BRAT's check for updates.

## Contributions and licenses

Sync Evo has two parts, under two licenses (see [LICENSE](LICENSE)).

- Everything except `pro/` is under AGPL-3.0-only. A change to it is welcome. By sending one, you agree that it is under AGPL-3.0-only with the additional permission in [LICENSE](LICENSE), so that it can be combined with `pro/`.
- `pro/` (Dropbox, Google Drive and the license key check) is under the Elastic License 2.0. Changes to it from outside are not taken for now, because the author keeps the right to change its terms. Issues about it are welcome.

## Bugs and requests

Report a bug or ask for a feature in the [issues](https://github.com/seking/obsidian-sync-evo/issues). Do not put a token, or a file name you would rather keep private, into a report.
