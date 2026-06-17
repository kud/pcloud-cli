<div align="center">
  <img src="./assets/logo.png" width="80" alt="pCloud CLI logo" />
</div>

<div align="center">

# pcloud-cli

[![npm version](https://img.shields.io/npm/v/@kud/pcloud-cli?style=flat-square)](https://www.npmjs.com/package/@kud/pcloud-cli)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square)](https://www.typescriptlang.org)
[![MIT Licence](https://img.shields.io/badge/licence-MIT-green?style=flat-square)](LICENSE)

CLI tool for pCloud file operations — list, restore from trash and rewind.

<a href="https://kud.io/projects/pcloud-cli">Website</a> · <a href="https://kud.io/projects/pcloud-cli/docs">Documentation</a>

</div>

---

CLI tool for pCloud file operations — list your trash, restore deleted files, browse version history, and rewind files to an earlier version, all from the terminal.

## ✨ Features

- List all files currently in pCloud trash
- Restore individual files from trash by file ID
- Browse version history for any file path
- Restore a specific version to a new destination
- OAuth 2.0 authentication — browser-based, token stored locally
- Bypass stored credentials with an environment variable for CI use

## 🚀 Install

```bash
npm install -g @kud/pcloud-cli
```

## 📖 Documentation

Full usage, options, and examples live on the docs site:

**→ [kud.io/projects/pcloud-cli/docs](https://kud.io/projects/pcloud-cli/docs)**

## 🔧 Development

Run directly from source without a build step:

```bash
npm run dev -- list-trash
npm run dev -- list-rewind /some/path
```

Build compiled output to `dist/`:

```bash
npm run build
```

## License

MIT © [kud](https://github.com/kud)
