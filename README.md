# pCloud CLI

A TypeScript CLI tool for managing pCloud files, with focus on restoring files from trash and rewind.

## Installation

```bash
npm install
```

## First Time Setup

Before using the CLI, you need to connect it to your pCloud account. **This is a one-time setup!**

Run:

```bash
npm start login
```

This will:
1. Open your browser to pCloud's login page
2. You log in with your pCloud credentials (in the browser)
3. pCloud redirects you back to the CLI automatically
4. Your access token is saved securely

**That's it!** Your browser session handles the login, and the CLI never sees your password.

## Build

```bash
npm run build
```

## Usage

### List files in trash

```bash
npm start list-trash
```

### Restore a file from trash

```bash
npm start restore-trash <fileid>
```

Example:
```bash
npm start restore-trash 12345
```

### List rewind events for a file

```bash
npm start list-rewind <path>
```

Example:
```bash
npm start list-rewind /mydocument.txt
```

### Restore a file from rewind

```bash
npm start restore-rewind <fileid> <destination-path>
```

Example:
```bash
npm start restore-rewind 12345 /restored-document.txt
```

## Development

Run without building:

```bash
npm run dev list-trash
```

## API Methods Used

- `userinfo` - Authentication
- `listtrash` - List files in trash
- `trash_clear` - Restore file from trash
- `listrewindevents` - List rewind events for a file
- `file_restore` - Restore file from rewind

## License

ISC
