# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-07-31

### Added

- **The Rewind tab in `pcloud browse` now rewinds.** It has always been a change log with single-row undo, which is a useful thing but not the thing its name promised — the actual bulk rewind existed only as `pcloud rewind` on the command line. Pressing enter on any event now offers "Rewind everything to just before this", which plans the same undo the CLI does and asks before applying it, stating exactly how many files it will restore and revert. Creations are counted and left alone, since the only way to undo one is to delete real data.

### Fixed

- The Rewind action modal no longer renders as a single garbled line. The list claimed every row the terminal had, so any overlay drawn beneath it had nowhere to go and its label and hint were composited into the same cell. The list now gives up rows to whatever overlay is open.
- Pressing enter on a Rewind event that cannot be undone used to do nothing at all, which is indistinguishable from a broken key. It now says why.
- Deleted **folders** in the Rewind tab offered no recovery action. Restoring a folder needs its `folderid` and only `fileid` was ever consulted — so the events that fill the trash in the first place were the ones you could not act on. This was already fixed once in the Trash tab; the Rewind path had its own copy of the logic and its own copy of the bug.
- "Revert to previous revision" took whichever revision the API happened to return first rather than the most recent one, so it could undo far more than the last edit.
- The preview panel in the Rewind tab showed whatever was selected in Files before you switched tabs. It now describes the selected change.
- Image previews are no longer squashed. Both a width and a height were passed to the image renderer, which then treats them as an exact box and discards the image's aspect ratio — a landscape screenshot was forced into the panel's portrait shape. Width is now the only size given and the panel height is a bound. The rendering protocol is also auto-detected rather than pinned to half-blocks, so terminals with native image support (iTerm2, Kitty, WezTerm) show a real image at true proportions.

### Changed

- `planRewind`, `applyRewind` and the diff path resolver moved into `@kud/pcloud` so the CLI and the browser share one implementation. Two of the bugs above existed only because the browser had reimplemented logic the CLI already had right.

[0.9.0]: https://github.com/kud/pcloud-cli/compare/v0.8.0...v0.9.0

## [0.8.0] - 2026-07-31

### Changed

- **`pcloud login` now logs in with your email and password by default.** The browser-based OAuth flow has moved to `pcloud login --oauth`. The old default required you to register a pCloud OAuth application first and then reached _less_ of the API than the alternative — OAuth access tokens cannot touch revisions, trash, zip or downloads, and there is no workaround. Session login needs no setup and reaches everything, so it becomes the default. `--session` is still accepted and does nothing, since it now describes the default.
- If you have `PCLOUD_CLIENT_ID` and `PCLOUD_CLIENT_SECRET` exported and want the browser flow, add `--oauth`. Stored credentials are untouched by this change — nobody is logged out.

### Fixed

- `pcloud login` no longer announces "You will be redirected to pCloud in your browser" before checking whether it has the credentials to do so. The check now runs first, and when it fails it points at the setup-free alternative rather than only naming the two environment variables.
- Passing `--oauth` and `--session` together is now refused instead of silently picking one.

### Documentation

- Authentication docs rewritten to cover both login methods, opening with a comparison of what each costs and what each reaches. The session flow was previously undocumented.
- Corrected the introduction, which still claimed Node 20 (0.7.0 raised the floor to 24), described authentication as OAuth-only, and did not mention the `sync` commands added in 0.7.0.

[0.8.0]: https://github.com/kud/pcloud-cli/compare/v0.7.1...v0.8.0

## [0.7.1] - 2026-07-31

### Fixed

- `pcloud browse` no longer exits silently when you are not logged in. The authentication check was running inside the browser's render, by which point the terminal had already switched to the alternate screen buffer — so the "Not authenticated" message was written to a buffer that was discarded microseconds later, and the command appeared to do nothing at all. The check now runs before the browser mounts, so `browse` fails with the same clear "run `pcloud login`" guidance as every other command.

[0.7.1]: https://github.com/kud/pcloud-cli/compare/v0.7.0...v0.7.1

## [0.7.0] - 2026-07-31

### Added

- New `pcloud sync` command family gives visibility into the local sync database (`~/.pcloud/data.db`) that the pCloud Drive desktop app keeps but never exposes. Until now a broken sync pair was invisible to the CLI, and the desktop app's own error for it is actively misleading — "pCloud doesn't have permissions to upload this item" against a folder shown as `/`, which is neither a permissions problem nor a folder actually named `/`. The real cause is that `syncfolder.folderid` is declared `ON DELETE SET NULL`, so deleting a remote folder blanks the reference instead of removing the pair, leaving a zombie sync pointed at nothing.
  - `pcloud sync` — table of local sync pairs with local path, remote path, file count, queue depth, and health.
  - `pcloud sync <id>` — detail view for a single pair, including any stranded queue entries.
  - `pcloud sync --json` — machine-readable output.
  - `pcloud sync --debug` — daemon state, database size, write-ahead-log status, and per-table row counts.
  - `pcloud sync prune <id>` — removes an orphaned pair; dry-run by default, `--apply` to actually perform it.
  - Five health checks catch what the desktop app misses: orphaned pairs, pairs pointing at a folder no longer in the remote index, duplicate pairs claiming the same local folder, pairs whose local folder is gone from disk, and stuck pairs with queued tasks that have no destination.

### Changed

- **Requires Node 24 or newer** — the new sync inspection uses the built-in `node:sqlite` module, so this release raises the minimum Node version and adds an `engines` field to `package.json`. Anyone installing the package on an older Node will need to upgrade first.
- `pcloud doctor` now runs the local sync checks as a second section after its credential-reach report. The local half works even when logged out, since reading the local database needs no pCloud credential.

### Security

- `sync prune --apply` backs up `data.db` before writing and refuses to run while pCloud Drive is open. It only ever touches local index rows — no files on disk or in the cloud are affected.
- `sync --debug` reads from an allowlist of tables, never an exclusion list, so credential and crypto-key tables are withheld by design.

<details>
<summary>Internal (1 commit)</summary>

- Added Vitest as the test runner (the repo previously had none) and wired `npm test` into the CI workflow between typecheck and build, so test failures now block CI.

</details>

[0.7.0]: https://github.com/kud/pcloud-cli/compare/v0.6.2...v0.7.0

## [0.1.0] - 2026-04-18

### Added

- Initial release of `@kud/pcloud-cli` — a CLI tool for pCloud file operations.
- OAuth authentication flow with token persistence via `TokenStore`.
- Support for authenticating with a direct `PCLOUD_ACCESS_TOKEN` environment variable.
- `login` command to initiate the OAuth flow and store credentials locally.
- pCloud API client (`src/api.ts`) covering core file and trash operations.
- TypeScript source with strict configuration (`tsconfig.json`).
- `.env.example` documenting required environment variables.

### Changed

- Renamed the npm package from `pcloud-cli` to the scoped `@kud/pcloud-cli`.
- Set initial published version to `0.1.0` (corrected from `1.0.0`).

[0.1.0]: https://github.com/kud/pcloud-cli/commits/main
