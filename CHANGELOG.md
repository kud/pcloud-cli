# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
