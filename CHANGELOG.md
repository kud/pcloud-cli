# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0] - 2026-08-01

### Added

- **A Shares tab in the browser**, listing what you have shared out and what has been shared with you, with the share id that `remove-share` takes. Enter on an outgoing share offers to revoke it, behind a confirmation naming the recipient. Incoming shares offer nothing: leaving one is `declineshare`, on a request id that no longer exists once accepted.
- **Shared folders are marked in the file list** — `→ shared` for ones you granted, `← shared` for ones you were given. A share is a property of a folder rather than a place, so a tab alone would have left the file list silent about it. The direction is an arrow rather than a colour, since which way access runs is the whole point.
- **Upload with `u`**, into the folder you are already looking at. A GUI makes Upload a destination because there is nowhere else to drop; here the cursor has already answered that, so the prompt asks for a local path and nothing else. Also available from the enter menu.

[0.16.0]: https://github.com/kud/pcloud-cli/compare/v0.15.1...v0.16.0

## [0.15.1] - 2026-07-31

### Fixed

- **`pcloud settings ignore set --paths` wrote the paths list into the patterns list.** `--paths` was declared on both the `ignore` command and its `set` subcommand, so commander bound it to the parent and the subcommand saw no flag at all. Options now bind to the subcommand they follow.
- **Writes are a dry run by default**, matching `pcloud sync prune`. The first version of these commands shipped without one and rewrote a live ignore list. Add `--apply` to write; `--db <path>` operates on a copy.
- `pcloud settings` is readable: sizes render as sizes, flags as on/off, and the ignore lists show a count with a sample rather than the bare number of entries.

[0.15.1]: https://github.com/kud/pcloud-cli/compare/v0.15.0...v0.15.1

## [0.15.0] - 2026-07-31

### Added

- **`pcloud settings`** reads pCloud Drive's local client settings, and **`pcloud settings ignore`** manages what it refuses to sync. These live in each machine's own `~/.pcloud/data.db` rather than in your account, so a folder ignored on one laptop uploads freely from another — which is how a `node_modules` tree ends up in the cloud with no machine considering itself responsible for it.
  - `pcloud settings ignore` — list the rules.
  - `pcloud settings ignore add|remove <patterns...>` — nudge one entry.
  - `pcloud settings ignore set <patterns...>` — replace the list. Declarative and idempotent, for config management.
  - `--paths` operates on `ignorepaths` instead of `ignorepatterns`.
- Writes refuse while pCloud Drive is running, because it rewrites its settings from memory when it quits and would silently undo the change long after the command reported success. `--force` overrides, and says what it costs.
- Only two keys are writable and six readable, by allowlist rather than deny-list. The same table holds your session token, and a deny-list would leak whatever sensitive key pCloud adds in a future release.

### Fixed

- The build no longer ships stale output. `tsc` does not remove artefacts for deleted sources, so a module moved into `@kud/pcloud` this morning was still being published from `dist/`. `npm run build` now cleans first.

[0.15.0]: https://github.com/kud/pcloud-cli/compare/v0.14.0...v0.15.0

## [0.14.0] - 2026-07-31

### Added

- **`pcloud` on its own opens the browser**, the way `k9s`, `lazygit` and `btop` do — once a tool has a full interface, that interface is the tool and needs no verb. `pcloud browse` still works, `--help` still prints usage, and every subcommand is untouched, so nothing scripted changes.

### Changed

- `list-trash`, `list-publinks` and `list-revisions` render through components rather than hand-padded strings, so they line up with `pcloud ls` instead of reading like output from three different programs.
- `list-revisions` orders by revision id and marks the newest as `latest`. pCloud promises no order, and taking whichever arrived first is the bug that shipped twice — once in the browser's revert, once in the CLI.
- `list-trash` shows whichever id restores the item. Trash is mostly folders, which carry `folderid` rather than `fileid`, so the id you needed was the one the listing would not print.
- Public links with no expiry now say `never` rather than leaving the column blank, which read as missing data on the most consequential value a link has.

### Fixed

- **Long names no longer run into the next column.** Every fixed-width column was built on `padEnd`, which only ever pads — a trashed file called `"8 Folders" from 30 Jul 2026 16:00.zip` is exactly 38 characters and printed as `…16:00.zip0 Bytes`, with the size welded to the name. Columns now pad _and_ truncate, and always keep a trailing gutter.
- Image previews no longer paint over the preview panel's border. The native image protocols draw in absolute pixels rather than being laid out in cells and round their cell reservation up, so an image whose height was not an exact multiple of the cell height claimed one more row than the box gave it.

[0.14.0]: https://github.com/kud/pcloud-cli/compare/v0.13.0...v0.14.0

## [0.13.0] - 2026-07-31

### Fixed

- **`pcloud list-shares` worked at all.** It died with `response.shares.forEach is not a function` on every run. pCloud answers `listshares` with two objects split by direction — `{outgoing, incoming}` — while the type declared a flat array, so the call typechecked and threw at runtime.
- **`pcloud remove-share` never removed anything.** `removeshare` ends an accepted share and takes `shareid`; `accept-share` and `decline-share` act on a pending request and take `sharerequestid`. The CLI sent the latter to all three, so pCloud answered "Please provide 'shareid'." and the removal silently did not happen. The argument is now `<shareid>`, which `list-shares` prints in its first column.
- Test files were being compiled into `dist/`, where the runner then picked up stale copies alongside the real ones. `tsconfig.json` now excludes them from the build.

### Changed

- `list-shares` renders through a `ShareList` component rather than hand-padded strings, so it lines up with `pcloud ls` instead of reading like output from a different program. Active shares and pending requests are listed separately — they carry different ids, and conflating them is what sent `remove-share` the wrong one.
- Share permissions render positionally as `rwcd`, since `rw--` and `r--d` both grant two rights and a list of the granted ones cannot tell them apart.

[0.13.0]: https://github.com/kud/pcloud-cli/compare/v0.12.1...v0.13.0

## [0.12.0] - 2026-07-31

### Changed

- **The Rewind tab reads as a history rather than a log.** It was two hundred rows each repeating `31 Jul 2026`, with the same file appearing forty times over because it had been saved every few minutes. A day's events on one file now fold into a single row — `21:13  ~ modified  ×12  /Reports/quarterly.tsv  2m ago` — grouped under `Today`, `Yesterday` or a weekday heading. The right arrow opens a run into its individual saves when one particular moment is what you want; the left arrow closes it again.
- Rows show where a file actually lives. `main`, `index` and `HEAD` are meaningless on their own; they now read as `/Dev/pcloud/.git/index`, resolved in the background so the list appears immediately and fills in a moment later.
- Recovering from a folded run acts on its most recent save, while rewinding from one starts at its oldest — so choosing a run undoes the run, not just its final moment. Expand it to reach anything in between.
- The Rewind panel describes the selected run: how many changes, over what span, and a sparkline of where the activity actually fell. A burst and a steady trickle produce the same count, which is worth knowing before undoing either.
- Folders in the change list are marked with a trailing slash, matching the file browser, in place of the old `dir` / `file` column.

[0.12.0]: https://github.com/kud/pcloud-cli/compare/v0.11.0...v0.12.0

## [0.11.0] - 2026-07-31

### Changed

- The action modal now lists every option first and describes the one under the cursor in a fixed slot at the bottom. Drawing each description directly beneath its own option pushed the remaining options down as the cursor travelled, which made the list restless to read and the modal's height depend on the selection.

### Fixed

- The action modal no longer draws its options on top of each other. It reserved rows for itself but not for the "N more" markers the file list draws around its scroll window, so on a folder that did not fit the screen, four options were composited into two lines. Long labels also truncate instead of wrapping, since a line that silently becomes two puts the same budget out again.
- The scroll markers themselves rendered as the literal text `↑ 5 more` — the escape was written into JSX text, where it is six characters rather than an arrow.

[0.11.0]: https://github.com/kud/pcloud-cli/compare/v0.10.0...v0.11.0

## [0.10.0] - 2026-07-31

### Added

- **New action: "Open a copy in the default app".** `pcloud browse` could already open a file, but only by handing the pCloud download link to your browser — which for an image means a tab, not an image viewer. The new action downloads a copy and gives it to the OS, so a PNG opens in Preview and a PDF opens wherever you read PDFs. The old behaviour is still there as "Open in browser".
- Every action carries a one-line description, including the destructive ones. "Rewind everything to just before this" did not say _when_ "this" was or how far "everything" reached; it now reads "Rewind the whole account to 31 Jul 2026 13:20:29", described as "Undoes this change and every deletion or edit after it. You will see the counts before anything moves."

### Fixed

- Image previews no longer paint over the preview panel's border. The panel's inner width was being recomputed by hand — 45% of the terminal, less borders, less padding — and a native-protocol image is positioned in pixels rather than laid out in cells, so a guess one column too wide spilled straight through the frame. The image is now fitted to the measured box and no size is passed at all.

[0.10.0]: https://github.com/kud/pcloud-cli/compare/v0.9.0...v0.10.0

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
