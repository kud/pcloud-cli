# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
