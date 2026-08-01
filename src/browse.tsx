import React from "react"
import { render } from "ink"
import {
  createMockAPI,
  mockSettings,
  mockSyncPairs,
} from "@kud/pcloud"
import {
  PCloudBrowser,
  type SettingsView,
  type SyncPairView,
} from "@kud/pcloud-ink"
import { homedir } from "os"
import { PCLOUD_DB, readPairs, snapshot } from "./lib/sync.js"
import {
  formatList,
  parseList,
  readSettings,
  writeSettings,
} from "./lib/settings.js"

// The browser itself lives in @kud/pcloud-ink so that cockpit can mount the
// same component rather than shelling out to `pcloud browse`. All that remains
// here is the terminal lifecycle, which only a standalone CLI should own — and
// the two providers below, which read a local SQLite database that a rendering
// package has no business opening.

const shortenHome = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

// A fresh snapshot per call rather than a held connection: pCloud Drive keeps
// the database under an exclusive lock while it runs, so every read copies the
// WAL set and opens the copy. Reloading is therefore a real refresh.
const readSyncPairs = (): SyncPairView[] => {
  const snap = snapshot(PCLOUD_DB)
  try {
    return readPairs(snap.db).map((pair) => ({
      id: pair.id,
      local: shortenHome(pair.localpath),
      remote: pair.remotepath ?? undefined,
      files: pair.files,
      queued: pair.queued,
      issues: pair.issues.map((issue) => issue.detail),
    }))
  } finally {
    snap.close()
  }
}

const readIgnoreRules = (): SettingsView => {
  const values = readSettings()
  return {
    ignorePatterns: parseList(values.ignorepatterns),
    ignorePaths: parseList(values.ignorepaths),
  }
}

// Throws when pCloud Drive is running, and the browser surfaces that rather
// than swallowing it: the daemon rewrites its settings from memory on quit, so
// a write made underneath it is undone silently and long after it looked to
// have worked.
const writeIgnoreRules = (next: SettingsView): void => {
  writeSettings({
    ignorepatterns: formatList(next.ignorePatterns),
    ignorepaths: formatList(next.ignorePaths),
  })
}

// Mock mode swaps every source at once — the client, the sync pairs and the
// settings. Half-mocking would be worse than not offering it: a screenshot
// showing invented files beside your real sync folders is the one outcome this
// exists to prevent.
export const startBrowse = async (mock = false): Promise<void> => {
  const { unmount, waitUntilExit } = render(
    mock ? (
      <PCloudBrowser
        onExit={() => unmount()}
        api={createMockAPI()}
        sync={mockSyncPairs}
        settings={{ read: mockSettings, write: () => {} }}
      />
    ) : (
      <PCloudBrowser
        onExit={() => unmount()}
        sync={readSyncPairs}
        settings={{ read: readIgnoreRules, write: writeIgnoreRules }}
      />
    ),
    { alternateScreen: true },
  )
  await waitUntilExit()
}
