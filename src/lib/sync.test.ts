import { describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEBUG_TABLES,
  OPEN,
  applyClearTasks,
  applyPrune,
  backupPath,
  planClearTasks,
  planPrune,
  readPairs,
  tableCounts,
  unlistedTables,
  verdicts,
} from "./sync.js"

// The database pCloud ships is a moving target — snapshotting a live one gives a
// torn WAL whose recovered contents differ between opens. These fixtures build
// only the columns the checks read, so a failure names a real regression rather
// than a shifted snapshot.
const SCHEMA = `
  CREATE TABLE folder (id INTEGER PRIMARY KEY, parentfolderid INTEGER, name TEXT);
  CREATE TABLE syncfolder (id INTEGER PRIMARY KEY, folderid INTEGER REFERENCES folder(id) ON DELETE SET NULL, localpath TEXT);
  CREATE TABLE syncedfolder (syncid INTEGER, folderid INTEGER, localfolderid INTEGER);
  CREATE TABLE localfolder (id INTEGER PRIMARY KEY, syncid INTEGER);
  CREATE TABLE localfile (id INTEGER PRIMARY KEY, syncid INTEGER);
  CREATE TABLE task (id INTEGER PRIMARY KEY, type INTEGER, syncid INTEGER, itemid INTEGER, localitemid INTEGER, inprogress INTEGER, name TEXT);
  CREATE TABLE setting (id TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE cryptofilekey (fileid INTEGER PRIMARY KEY, key TEXT);
  CREATE TABLE cryptofolderkey (folderid INTEGER PRIMARY KEY, key TEXT);
`

type Fixture = { db: DatabaseSync; path: string; dispose: () => void }

const fixture = (): Fixture => {
  const dir = mkdtempSync(join(tmpdir(), "pcloud-cli-test-"))
  // Only pairs 1 and 2 share a local path, so a prune of 2 is expected to clear
  // the duplicate flag outright rather than leave other pairs still colliding.
  const solo = mkdtempSync(join(tmpdir(), "pcloud-cli-solo-"))
  const spare = mkdtempSync(join(tmpdir(), "pcloud-cli-spare-"))
  const path = join(dir, "data.db")
  const db = new DatabaseSync(path, OPEN)
  db.exec(SCHEMA)

  db.exec(`
    INSERT INTO folder (id, parentfolderid, name) VALUES
      (100, 0, 'Appdata'),
      (200, 0, 'Docs'),
      (201, 200, 'Invoices');

    INSERT INTO syncfolder (id, folderid, localpath) VALUES
      (1, 100, '${dir}'),
      (2, NULL, '${dir}'),
      (3, 200, '${solo}'),
      (4, 999, '${spare}'),
      (5, 201, '/nonexistent/path/for/test');

    INSERT INTO localfolder (id, syncid) VALUES (1, 2), (2, 2), (3, 1);
    INSERT INTO localfile (id, syncid) VALUES (1, 2), (2, 2), (3, 2), (4, 1);
    INSERT INTO syncedfolder (syncid, folderid, localfolderid) VALUES (2, NULL, 1), (2, NULL, 2);
    INSERT INTO task (id, type, syncid, itemid, localitemid, inprogress, name) VALUES
      (10, 1, 2, 0, 1868, 2, 'usage'),
      (11, 3, 2, 0, 7182, 2, 'usage.tsv'),
      (12, 1, 1, 4155, 900, 0, 'fine');

    INSERT INTO setting (id, value) VALUES ('auth', 'SECRET-TOKEN-DO-NOT-PRINT');
    INSERT INTO cryptofilekey (fileid, key) VALUES (1, 'SECRET-KEY-MATERIAL');
  `)

  return {
    db,
    path,
    dispose: () => {
      db.close()
      ;[dir, solo, spare].forEach((target) =>
        rmSync(target, { recursive: true, force: true }),
      )
    },
  }
}

const rowCount = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const kindsFor = (db: DatabaseSync, id: number): string[] =>
  (readPairs(db).find((pair) => pair.id === id)?.issues ?? []).map(
    (issue) => issue.kind,
  )

describe("readPairs", () => {
  it("flags a sync pair whose remote folder was set to NULL", () => {
    const f = fixture()
    expect(kindsFor(f.db, 2)).toContain("orphaned")
    f.dispose()
  })

  it("flags every pair sharing a local path, not just the broken one", () => {
    const f = fixture()
    expect(kindsFor(f.db, 1)).toContain("duplicate")
    expect(kindsFor(f.db, 2)).toContain("duplicate")
    f.dispose()
  })

  it("flags a folderid that is no longer in the folder index", () => {
    const f = fixture()
    expect(kindsFor(f.db, 4)).toContain("remote-missing")
    f.dispose()
  })

  it("flags a local path that no longer exists on disk", () => {
    const f = fixture()
    expect(kindsFor(f.db, 5)).toContain("local-missing")
    f.dispose()
  })

  // Pair 3 is the shape that passed every other check on 2026-08-03: a valid
  // syncfolder row, a folderid that resolves, a local folder on disk — and no
  // syncedfolder rows, so the daemon has nowhere to upload into. The pair moves
  // nothing while looking entirely well.
  it("flags a pair the daemon never indexed", () => {
    const f = fixture()
    expect(kindsFor(f.db, 3)).toContain("unindexed")
    f.dispose()
  })

  // An orphaned pair has no remote folder to be indexed against, so reporting
  // both would name one fault twice and point at the wrong remedy.
  it("does not report unindexed on top of an orphaned pair", () => {
    const f = fixture()
    expect(kindsFor(f.db, 2)).toContain("orphaned")
    expect(kindsFor(f.db, 2)).not.toContain("unindexed")
    f.dispose()
  })

  it("flags queued tasks that have no destination folder", () => {
    const f = fixture()
    expect(kindsFor(f.db, 2)).toContain("stuck")
    expect(kindsFor(f.db, 1)).not.toContain("stuck")
    f.dispose()
  })

  it("resolves a nested remote path by walking to the root", () => {
    const f = fixture()
    const pair = readPairs(f.db).find((candidate) => candidate.id === 5)
    expect(pair?.remotepath).toBe("/Docs/Invoices")
    f.dispose()
  })

  it("reports no remote path for an orphan rather than inventing one", () => {
    const f = fixture()
    const pair = readPairs(f.db).find((candidate) => candidate.id === 2)
    expect(pair?.remotepath).toBeNull()
    f.dispose()
  })

  it("counts indexed folders, files and queued tasks per pair", () => {
    const f = fixture()
    const pair = readPairs(f.db).find((candidate) => candidate.id === 2)
    expect(pair).toMatchObject({ folders: 2, files: 3, queued: 2 })
    f.dispose()
  })
})

describe("verdicts", () => {
  it("counts affected pairs per issue kind and drops the clean ones", () => {
    const f = fixture()
    const summary = Object.fromEntries(
      verdicts(readPairs(f.db)).map((verdict) => [verdict.kind, verdict.count]),
    )
    expect(summary).toMatchObject({
      orphaned: 1,
      duplicate: 2,
      "remote-missing": 1,
      "local-missing": 1,
      stuck: 1,
    })
    f.dispose()
  })
})

describe("planPrune", () => {
  it("counts every row the prune would remove", () => {
    const f = fixture()
    const plan = planPrune(f.db, 2)
    expect(plan.counts).toEqual({
      task: 2,
      syncedfolder: 2,
      localfile: 3,
      localfolder: 2,
      syncfolder: 1,
    })
    expect(plan.total).toBe(10)
    f.dispose()
  })

  it("refuses an id that is not a sync pair", () => {
    const f = fixture()
    expect(() => planPrune(f.db, 99)).toThrow(/No sync pair/)
    f.dispose()
  })
})

describe("applyPrune", () => {
  it("removes the pair and leaves the others untouched", () => {
    const f = fixture()
    f.db.close()

    const { removed, backup } = applyPrune(f.path, 2, new Date(0))
    expect(removed).toBe(10)
    expect(existsSync(backup)).toBe(true)

    const after = new DatabaseSync(f.path, OPEN)
    expect(readPairs(after).map((pair) => pair.id)).toEqual([1, 3, 4, 5])
    expect(
      after.prepare("SELECT COUNT(*) AS n FROM localfile").get(),
    ).toMatchObject({ n: 1 })
    expect(after.prepare("SELECT COUNT(*) AS n FROM task").get()).toMatchObject(
      {
        n: 1,
      },
    )
    after.close()

    rmSync(f.path, { force: true })
    rmSync(backup, { force: true })
  })

  it("clears the duplicate flag on the pair that survives", () => {
    const f = fixture()
    f.db.close()

    const { backup } = applyPrune(f.path, 2, new Date(0))
    const after = new DatabaseSync(f.path, OPEN)
    expect(kindsFor(after, 1)).not.toContain("duplicate")
    after.close()

    rmSync(f.path, { force: true })
    rmSync(backup, { force: true })
  })
})

describe("backupPath", () => {
  it("builds a colon-free name so the path is safe on every filesystem", () => {
    expect(backupPath("/tmp/data.db", new Date("2026-07-31T14:05:09Z"))).toBe(
      "/tmp/data.db.backup-2026-07-31T14-05-09",
    )
  })
})

describe("debug allowlist", () => {
  it("never lists a table holding credentials or crypto keys", () => {
    const forbidden = ["setting", "cryptofilekey", "cryptofolderkey"]
    forbidden.forEach((table) =>
      expect(DEBUG_TABLES as readonly string[]).not.toContain(table),
    )
  })

  it("reports counts only for allowlisted tables present in the database", () => {
    const f = fixture()
    const shown = tableCounts(f.db).map((row) => row.table)
    expect(shown).toContain("syncfolder")
    expect(shown).not.toContain("setting")
    expect(shown).not.toContain("cryptofilekey")
    f.dispose()
  })

  it("names withheld tables without reading them", () => {
    const f = fixture()
    expect(unlistedTables(f.db)).toEqual([
      "cryptofilekey",
      "cryptofolderkey",
      "setting",
    ])
    f.dispose()
  })
})

// prune and clear-tasks answer different faults, and confusing them is
// expensive: pruning pair #1 on a real machine deletes 1,180 rows and unpairs
// the folder, which is right for a pair pointed at a deleted remote and
// catastrophic for a healthy one carrying stale queue entries.
describe("planClearTasks", () => {
  it("counts only the queued rows that never resolved a destination", () => {
    const f = fixture()
    try {
      // Pair 2 has two tasks with itemid = 0 and one healthy pair-1 task with
      // a real itemid, which must not be swept up.
      expect(planClearTasks(f.db, 2).tasks.map((t) => t.name)).toEqual([
        "usage",
        "usage.tsv",
      ])
      expect(planClearTasks(f.db, 1).tasks).toEqual([])
    } finally {
      f.dispose()
    }
  })

  it("refuses an id that is not a sync pair", () => {
    const f = fixture()
    try {
      expect(() => planClearTasks(f.db, 999)).toThrow(/No sync pair/)
    } finally {
      f.dispose()
    }
  })
})

describe("applyClearTasks", () => {
  it("deletes the stranded tasks and nothing else", () => {
    const f = fixture()
    const before = {
      localfile: rowCount(f.db, "localfile"),
      localfolder: rowCount(f.db, "localfolder"),
      syncfolder: rowCount(f.db, "syncfolder"),
      syncedfolder: rowCount(f.db, "syncedfolder"),
    }
    f.db.close()

    try {
      const { removed } = applyClearTasks(f.path, 2)
      expect(removed).toBe(2)

      const db = new DatabaseSync(f.path, OPEN)
      // The pair, its index and its synced folders all survive — this is the
      // whole difference from prune.
      expect(rowCount(db, "localfile")).toBe(before.localfile)
      expect(rowCount(db, "localfolder")).toBe(before.localfolder)
      expect(rowCount(db, "syncfolder")).toBe(before.syncfolder)
      expect(rowCount(db, "syncedfolder")).toBe(before.syncedfolder)
      // The healthy task with a real destination is untouched.
      expect(
        (db.prepare("SELECT id FROM task").all() as { id: number }[]).map(
          (r) => r.id,
        ),
      ).toEqual([12])
      db.close()
    } finally {
      rmSync(f.path, { force: true })
    }
  })

  it("backs the database up before touching it", () => {
    const f = fixture()
    f.db.close()
    try {
      const { backup } = applyClearTasks(f.path, 2)
      expect(existsSync(backup)).toBe(true)

      // The backup still holds the rows that were just removed.
      const db = new DatabaseSync(backup, OPEN)
      expect(rowCount(db, "task")).toBe(3)
      db.close()
    } finally {
      rmSync(f.path, { force: true })
    }
  })
})
