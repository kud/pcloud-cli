import { DatabaseSync } from "node:sqlite"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

export const PCLOUD_DB = join(homedir(), ".pcloud", "data.db")

const WAL_SUFFIXES = ["-wal", "-shm"] as const

// node:sqlite turns foreign keys on by default where pCloud's own writer leaves
// them off, and this database is full of references its writer tolerates — a
// dangling syncfolder.folderid is the very fault these checks exist to find.
// Enforcing constraints we did not author would reject the broken rows we came
// to read, so the connection matches the writer rather than the language default.
export const OPEN = { enableForeignKeyConstraints: false } as const

// pCloud Drive holds the database under an exclusive WAL lock for as long as it
// runs, so opening it in place fails outright ("database is locked") rather than
// degrading to a stale read. Copying the WAL set and opening the copy is the only
// way to read a consistent snapshot without stopping the daemon. The -wal and
// -shm files are absent after a clean checkpoint, which is a valid state and not
// something to report as a broken database.
export type Snapshot = {
  db: DatabaseSync
  source: string
  bytes: number
  hadWal: boolean
  close: () => void
}

export const snapshot = (dbPath: string = PCLOUD_DB): Snapshot => {
  if (!existsSync(dbPath)) {
    throw new Error(
      `No pCloud database at ${dbPath}. Is pCloud Drive installed?`,
    )
  }

  const dir = mkdtempSync(join(tmpdir(), "pcloud-cli-"))
  const copy = join(dir, "data.db")
  copyFileSync(dbPath, copy)

  const hadWal = WAL_SUFFIXES.reduce((seen, suffix) => {
    if (!existsSync(dbPath + suffix)) return seen
    copyFileSync(dbPath + suffix, copy + suffix)
    return true
  }, false)

  // Opened writable on purpose: SQLite replays the copied -wal into the copy on
  // first access, which is what makes the snapshot reflect committed state. A
  // read-only handle would refuse that recovery and read the pre-WAL pages.
  const db = new DatabaseSync(copy, OPEN)

  return {
    db,
    source: dbPath,
    bytes: statSync(dbPath).size,
    hadWal,
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const DAEMON_BINARY = "pCloud Drive.app/Contents/MacOS/pCloud Drive"

// pgrep exits 1 with no match, which execFileSync surfaces as a throw. Matching
// the binary path rather than the bare name keeps the Finder extension — a
// separate, transient process that does not hold the database — from reading as
// a running daemon.
export const daemonRunning = (): boolean => {
  try {
    execFileSync("pgrep", ["-f", DAEMON_BINARY], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

// AppleScript rather than a signal, so pCloud Drive shuts down cleanly and
// finishes flushing its own state first — the very state a SIGTERM mid-write is
// most likely to leave torn.
//
// Quitting is not enough on its own; the exit has to be confirmed. Sleeping and
// assuming produces the same corruption with an extra delay in front of it.
export const quitDaemon = (timeoutMs = 15_000): boolean => {
  if (!daemonRunning()) return true
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application "pCloud Drive" to quit'],
      {
        stdio: "ignore",
      },
    )
  } catch {
    return false
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!daemonRunning()) return true
    execFileSync("sleep", ["0.5"], { stdio: "ignore" })
  }
  return false
}

// -g keeps it behind the terminal: stealing focus at the end of a command is
// its own small breakage.
export const startDaemon = (): boolean => {
  try {
    execFileSync("open", ["-g", "-a", "pCloud Drive"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export const databaseLocked = (dbPath: string = PCLOUD_DB): boolean => {
  try {
    execFileSync("lsof", ["--", dbPath], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export type IssueKind =
  "orphaned" | "duplicate" | "local-missing" | "remote-missing" | "stuck"

export type Issue = { kind: IssueKind; detail: string }

export type SyncPair = {
  id: number
  folderid: number | null
  localpath: string
  remotepath: string | null
  folders: number
  files: number
  queued: number
  issues: Issue[]
}

type Row = Record<string, unknown>

const rows = (db: DatabaseSync, sql: string, ...params: unknown[]): Row[] =>
  db.prepare(sql).all(...(params as never[])) as Row[]

const num = (value: unknown): number => Number(value ?? 0)

const countBySync = (db: DatabaseSync, table: string): Map<number, number> =>
  new Map(
    rows(db, `SELECT syncid, COUNT(*) AS n FROM ${table} GROUP BY syncid`)
      .filter((row) => row.syncid !== null)
      .map((row) => [num(row.syncid), num(row.n)]),
  )

const MAX_DEPTH = 64

// Walking parentfolderid to the root is the only way to render a remote path:
// syncfolder stores an id, and the id alone tells the user nothing about which
// cloud folder a pair is bound to. A missing ancestor means the remote side was
// deleted out from under the sync, so the walk reports that rather than guessing.
const remotePath = (db: DatabaseSync, folderid: number): string | null => {
  const parts: string[] = []
  let id = folderid

  for (let depth = 0; id !== 0 && depth < MAX_DEPTH; depth += 1) {
    const row = db
      .prepare("SELECT name, parentfolderid FROM folder WHERE id = ?")
      .get(id) as Row | undefined
    if (!row) return null
    parts.unshift(String(row.name ?? "?"))
    id = num(row.parentfolderid)
  }

  return "/" + parts.join("/")
}

export const readPairs = (db: DatabaseSync): SyncPair[] => {
  const folders = countBySync(db, "localfolder")
  const files = countBySync(db, "localfile")
  const queued = countBySync(db, "task")

  const raw = rows(
    db,
    "SELECT id, folderid, localpath FROM syncfolder ORDER BY id",
  )

  const localpathCounts = raw.reduce((counts, row) => {
    const path = String(row.localpath ?? "")
    return counts.set(path, (counts.get(path) ?? 0) + 1)
  }, new Map<string, number>())

  return raw.map((row) => {
    const id = num(row.id)
    const folderid = row.folderid === null ? null : num(row.folderid)
    const localpath = String(row.localpath ?? "")
    const resolved = folderid === null ? null : remotePath(db, folderid)

    // itemid 0 is a queued operation with no destination folder to act on — the
    // shape every task takes once its sync pair has lost its remote side.
    const stranded = num(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM task WHERE syncid = ? AND itemid = 0",
          )
          .get(id) as Row
      ).n,
    )

    const issues: Issue[] = []

    if (folderid === null) {
      issues.push({
        kind: "orphaned",
        detail: "no remote folder — pCloud shows this pair as “/”",
      })
    } else if (resolved === null) {
      issues.push({
        kind: "remote-missing",
        detail: `remote folder ${folderid} is no longer in the index`,
      })
    }

    if ((localpathCounts.get(localpath) ?? 0) > 1) {
      issues.push({
        kind: "duplicate",
        detail: "a second sync pair claims the same local folder",
      })
    }

    if (localpath && !existsSync(localpath)) {
      issues.push({ kind: "local-missing", detail: "local folder is gone" })
    }

    if (stranded > 0) {
      issues.push({
        kind: "stuck",
        detail: `${stranded} queued operation${stranded === 1 ? "" : "s"} with no destination`,
      })
    }

    return {
      id,
      folderid,
      localpath,
      remotepath: resolved,
      folders: folders.get(id) ?? 0,
      files: files.get(id) ?? 0,
      queued: queued.get(id) ?? 0,
      issues,
    }
  })
}

export const strandedTasks = (db: DatabaseSync, syncid: number): Row[] =>
  rows(
    db,
    "SELECT id, type, name, localitemid, inprogress FROM task WHERE syncid = ? AND itemid = 0",
    syncid,
  )

// Deleted child-first so no statement ever leaves a row pointing at a parent that
// has already gone. syncfolder is last because every other table keys off its id.
export const PRUNE_TABLES = [
  "task",
  "syncedfolder",
  "localfile",
  "localfolder",
] as const

export type PrunePlan = {
  pair: SyncPair
  counts: Record<string, number>
  total: number
}

export const planPrune = (db: DatabaseSync, syncid: number): PrunePlan => {
  const pair = readPairs(db).find((candidate) => candidate.id === syncid)
  if (!pair) throw new Error(`No sync pair with id ${syncid}`)

  const counts = PRUNE_TABLES.reduce<Record<string, number>>((acc, table) => {
    acc[table] = num(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE syncid = ?`)
          .get(syncid) as Row
      ).n,
    )
    return acc
  }, {})
  counts.syncfolder = 1

  return {
    pair,
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  }
}

export type ClearTasksPlan = {
  pair: SyncPair
  tasks: Row[]
}

// Narrower than prune by two orders of magnitude, and deliberately so. Pruning
// pair #1 deletes 1,180 rows and unpairs the folder outright — the right remedy
// for a zombie pair whose remote was deleted, and wildly wrong for a healthy
// pair carrying two stale queue entries.
export const planClearTasks = (
  db: DatabaseSync,
  syncid: number,
): ClearTasksPlan => {
  const pair = readPairs(db).find((candidate) => candidate.id === syncid)
  if (!pair) throw new Error(`No sync pair with id ${syncid}`)
  return { pair, tasks: strandedTasks(db, syncid) }
}

export const backupPath = (dbPath: string, stamp: Date): string =>
  `${dbPath}.backup-${stamp.toISOString().slice(0, 19).replace(/:/g, "-")}`

// Only rows with itemid = 0 — a task that never resolved a remote destination.
// Anything with a destination is work the daemon can still finish, and deleting
// it would drop a real upload rather than a stale entry.
export const applyClearTasks = (
  dbPath: string,
  syncid: number,
  stamp: Date = new Date(),
): { backup: string; removed: number } => {
  const backup = backupPath(dbPath, stamp)
  copyFileSync(dbPath, backup)

  const db = new DatabaseSync(dbPath, OPEN)
  try {
    db.exec("BEGIN")
    try {
      const result = db
        .prepare("DELETE FROM task WHERE syncid = ? AND itemid = 0")
        .run(syncid)
      db.exec("COMMIT")
      return { backup, removed: Number(result.changes) }
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  } finally {
    db.close()
  }
}

export const applyPrune = (
  dbPath: string,
  syncid: number,
  stamp: Date = new Date(),
): { backup: string; removed: number } => {
  const backup = backupPath(dbPath, stamp)
  copyFileSync(dbPath, backup)

  const db = new DatabaseSync(dbPath, OPEN)
  try {
    const plan = planPrune(db, syncid)
    db.exec("BEGIN")
    try {
      PRUNE_TABLES.forEach((table) =>
        db.prepare(`DELETE FROM ${table} WHERE syncid = ?`).run(syncid),
      )
      db.prepare("DELETE FROM syncfolder WHERE id = ?").run(syncid)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    return { backup, removed: plan.total }
  } finally {
    db.close()
  }
}

// Derived, never stored. A setting recording where synced folders live can
// drift from the pairs it claims to describe; the pairs cannot drift from
// themselves. Returns null when they disagree, so the caller falls through to
// its own default rather than picking a winner among them.
export const syncRoot = (db: DatabaseSync): string | null => {
  const paths = rows(db, "SELECT localpath FROM syncfolder")
    .map((row) => String(row.localpath ?? ""))
    .filter(Boolean)
  if (paths.length === 0) return null
  const parents = new Set(paths.map((path) => dirname(path)))
  return parents.size === 1 ? [...parents][0] : null
}

// There is deliberately no planAdd/applyAdd here, and this note is why.
//
// On 2026-08-03 a row was inserted straight into `syncfolder` with folderid,
// inode and deviceid all copied correctly from working pairs. The daemon took
// it: it watched the folder and indexed a test file into `localfile`. But
// `syncedfolder` and `localfolder` stayed at 0 where a working pair carries 67
// and 66, so it held a file it knew about and no remote folder to put it in.
// Nothing uploaded, and readPairs() reported the pair healthy throughout —
// these checks look for an orphaned folderid, not for an index the daemon
// never built.
//
// That is the whole hazard: a sync that will not start announces itself, and
// this one reports fine indefinitely while moving nothing. Creating pairs
// belongs to pCloud Drive, which builds its own index. This module reads and
// removes; it does not create.

// An allowlist rather than an exclusion list: the same database holds `setting`,
// `cryptofilekey` and `cryptofolderkey`, which carry the account's auth token and
// crypto key material. A deny-list would leak the first sensitive table pCloud
// adds in a future release; naming what may be shown cannot.
export const DEBUG_TABLES = [
  "syncfolder",
  "syncedfolder",
  "syncfolderdelayed",
  "localfolder",
  "localfile",
  "localfileupload",
  "task",
  "fstask",
  "fstaskupload",
  "fstaskdepend",
  "fstaskfileid",
  "upload_tasks",
  "uptask_fileupload",
  "folder",
  "file",
  "filerevision",
  "sharedfolder",
  "bsharedfolder",
  "sharerequest",
  "links",
  "devices",
  "pagecache",
  "pagecachetask",
  "resolver",
  "hashchecksum",
  "contacts",
  "myteams",
] as const

export type TableCount = { table: string; rows: number | null }

export const tableCounts = (db: DatabaseSync): TableCount[] => {
  const present = new Set(
    rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) =>
      String(row.name),
    ),
  )

  return DEBUG_TABLES.filter((table) => present.has(table)).map((table) => ({
    table,
    rows: num(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n,
    ),
  }))
}

export const unlistedTables = (db: DatabaseSync): string[] => {
  const known = new Set<string>(DEBUG_TABLES)
  return rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => String(row.name))
    .filter((name) => !known.has(name) && !name.startsWith("sqlite_"))
    .sort()
}

export type SyncVerdict = { kind: IssueKind; count: number; detail: string }

const VERDICT_LABEL: Record<IssueKind, string> = {
  orphaned: "orphaned sync pair(s) — local folder with no remote target",
  duplicate: "duplicate local path(s) across sync pairs",
  "local-missing": "sync pair(s) whose local folder no longer exists",
  "remote-missing": "sync pair(s) whose remote folder left the index",
  stuck: "sync pair(s) with queued operations that cannot complete",
}

export const verdicts = (pairs: SyncPair[]): SyncVerdict[] =>
  (Object.keys(VERDICT_LABEL) as IssueKind[])
    .map((kind) => ({
      kind,
      count: pairs.filter((pair) =>
        pair.issues.some((issue) => issue.kind === kind),
      ).length,
      detail: VERDICT_LABEL[kind],
    }))
    .filter((verdict) => verdict.count > 0)
