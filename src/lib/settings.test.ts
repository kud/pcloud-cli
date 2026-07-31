import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  READABLE_SETTINGS,
  WRITABLE_SETTINGS,
  formatList,
  isReadable,
  isWritable,
  parseList,
  readSettings,
  sameSet,
  writeSettings,
} from "./settings.js"

// pCloud's own value, verbatim: newlines inside the list, a space after most
// separators and none after one of them. Parsing has to tolerate all of it.
const MESSY = `.ds_store; .ds_store?; .appledouble;
._*; .spotlight-v100; node_modules;.stfolder;`

const fixture = (): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "pcloud-settings-test-"))
  const path = join(dir, "data.db")
  const db = new DatabaseSync(path)
  db.exec(
    "CREATE TABLE setting (id VARCHAR(16) PRIMARY KEY, value TEXT) WITHOUT ROWID",
  )
  db.prepare("INSERT INTO setting (id, value) VALUES (?, ?)").run(
    "ignorepatterns",
    MESSY,
  )
  // The account's session token lives in this very table. Nothing here may
  // read, return or disturb it.
  db.prepare("INSERT INTO setting (id, value) VALUES (?, ?)").run(
    "auth",
    "SENTINEL-TOKEN",
  )
  db.prepare("INSERT INTO setting (id, value) VALUES (?, ?)").run(
    "language",
    "en",
  )
  db.close()
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("the allowlist is what keeps the auth token out of reach", () => {
  it("never lists a credential-bearing key as readable", () => {
    for (const key of [
      "auth",
      "cryptofilekey",
      "cryptofolderkey",
      "randomhash",
    ])
      expect(isReadable(key)).toBe(false)
  })

  it("allows fewer keys to be written than read", () => {
    expect(WRITABLE_SETTINGS.length).toBeLessThan(READABLE_SETTINGS.length)
    for (const key of WRITABLE_SETTINGS) expect(isReadable(key)).toBe(true)
  })

  it("does not return auth even though it shares the table", () => {
    const { path, cleanup } = fixture()
    try {
      const values = readSettings(path)
      expect(values.language).toBe("en")
      expect(Object.keys(values)).not.toContain("auth")
      expect(JSON.stringify(values)).not.toContain("SENTINEL")
    } finally {
      cleanup()
    }
  })
})

describe("parsing tolerates the whitespace pCloud actually ships", () => {
  it("survives newlines mid-list and a missing space after a separator", () => {
    expect(parseList(MESSY)).toEqual([
      ".ds_store",
      ".ds_store?",
      ".appledouble",
      "._*",
      ".spotlight-v100",
      "node_modules",
      ".stfolder",
    ])
  })

  it("drops the empties a trailing separator creates", () => {
    expect(parseList(";; ;")).toEqual([])
    expect(parseList(undefined)).toEqual([])
  })

  it("round-trips through formatList", () => {
    expect(parseList(formatList(parseList(MESSY)))).toEqual(parseList(MESSY))
  })

  it("formats an empty list as empty rather than a lone separator", () => {
    expect(formatList([])).toBe("")
  })
})

// Without this, an apply would report drift on every run and quit pCloud Drive
// to rewrite a list identical to the one already there.
describe("comparison is order- and case-insensitive, as pCloud's matching is", () => {
  it("ignores order and duplicates", () => {
    expect(sameSet(["a", "b"], ["b", "a"])).toBe(true)
    expect(sameSet(["a", "a", "b"], ["b", "a"])).toBe(true)
  })

  it("ignores case", () => {
    expect(sameSet(["NODE_MODULES"], ["node_modules"])).toBe(true)
  })

  it("still notices a genuine difference", () => {
    expect(sameSet(["a"], ["a", "b"])).toBe(false)
  })
})

describe("writing", () => {
  it("upserts a key that has no row yet", () => {
    const { path, cleanup } = fixture()
    try {
      // ignorepaths is absent from the fixture — an UPDATE would match nothing
      // and still succeed, which is how a cleared machine stays cleared.
      writeSettings(
        { ignorepaths: formatList(["/System"]) },
        path,
        new Date(),
        {
          force: true,
        },
      )
      expect(parseList(readSettings(path).ignorepaths)).toEqual(["/System"])
    } finally {
      cleanup()
    }
  })

  it("leaves the auth row untouched", () => {
    const { path, cleanup } = fixture()
    try {
      writeSettings({ ignorepatterns: formatList(["x"]) }, path, new Date(), {
        force: true,
      })
      const db = new DatabaseSync(path)
      const row = db
        .prepare("SELECT value FROM setting WHERE id = 'auth'")
        .get() as { value: string }
      db.close()
      expect(row.value).toBe("SENTINEL-TOKEN")
    } finally {
      cleanup()
    }
  })

  it("backs the database up before changing it", () => {
    const { path, cleanup } = fixture()
    try {
      const { backup, changed } = writeSettings(
        { ignorepatterns: formatList(["only"]) },
        path,
        new Date(),
        { force: true },
      )
      expect(existsSync(backup)).toBe(true)
      expect(changed).toEqual(["ignorepatterns"])

      // The backup must hold the old value, not the new one.
      const db = new DatabaseSync(backup)
      const row = db
        .prepare("SELECT value FROM setting WHERE id = 'ignorepatterns'")
        .get() as { value: string }
      db.close()
      expect(parseList(row.value)).toContain("node_modules")
    } finally {
      cleanup()
    }
  })

  it("ignores keys outside the writable allowlist", () => {
    const { path, cleanup } = fixture()
    try {
      writeSettings(
        { auth: "hijacked", language: "fr" } as never,
        path,
        new Date(),
        { force: true },
      )
      const db = new DatabaseSync(path)
      const rows = db
        .prepare(
          "SELECT id, value FROM setting WHERE id IN ('auth','language')",
        )
        .all() as { id: string; value: string }[]
      db.close()
      expect(rows.find((r) => r.id === "auth")?.value).toBe("SENTINEL-TOKEN")
      expect(rows.find((r) => r.id === "language")?.value).toBe("en")
    } finally {
      cleanup()
    }
  })
})

describe("isWritable", () => {
  it("refuses anything not explicitly named", () => {
    expect(isWritable("ignorepatterns")).toBe(true)
    expect(isWritable("auth")).toBe(false)
    expect(isWritable("language")).toBe(false)
  })
})

// The parsing bug that overwrote a live ignore list: `--paths` was declared on
// both the parent `ignore` command and its `set` subcommand, so commander bound
// it to the parent and `set` saw no flag — writing the paths list into
// ignorepatterns. Asserting on the shape of the fix rather than on commander.
describe("the writable keys are distinguishable, not interchangeable", () => {
  it("keeps patterns and paths as separate keys", () => {
    expect(WRITABLE_SETTINGS).toContain("ignorepatterns")
    expect(WRITABLE_SETTINGS).toContain("ignorepaths")
    expect(new Set(WRITABLE_SETTINGS).size).toBe(WRITABLE_SETTINGS.length)
  })

  it("writes only the key it was given", () => {
    const { path, cleanup } = fixture()
    try {
      writeSettings({ ignorepaths: formatList(["/System"]) }, path, new Date(), {
        force: true,
      })
      // The patterns list must be exactly as the fixture left it.
      expect(parseList(readSettings(path).ignorepatterns)).toContain(
        "node_modules",
      )
      expect(parseList(readSettings(path).ignorepatterns)).not.toContain(
        "/System",
      )
    } finally {
      cleanup()
    }
  })
})
