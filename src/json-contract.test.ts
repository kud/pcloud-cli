import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { Command } from "commander"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// --json is a contract rather than a habit: any command may be passed it
// without the caller first checking a list. Documentation alone drifts, so the
// command tree is walked here and a new command cannot ship without the flag.

// Interactive by nature: one takes over the terminal, the other prompts for a
// password or opens a browser. There is no payload to emit.
const INTERACTIVE = new Set(["browse", "login"])

// Dry-run/apply commands whose JSON shape — and what --json does when the
// command would prompt — is still an open decision on #7. Listed so the gap is
// visible and shrinks; the test below fails if one of them gains the flag
// without being removed from here.
const PENDING = new Set([
  "doctor",
  "rewind",
  "sync add",
  "sync clear-tasks",
  "sync prune",
  "settings ignore add",
  "settings ignore remove",
  "settings ignore set",
])

const home = mkdtempSync(join(tmpdir(), "pcloud-cli-json-"))
const saved = { ...process.env }

let program: Command

beforeAll(async () => {
  // Set before the import: TokenStore reads $HOME, and a credential in the
  // environment keeps resolveAuth away from any stored or interactive one.
  process.env.HOME = home
  process.env.PCLOUD_AUTH = "fixture-token"
  delete process.env.PCLOUD_ACCESS_TOKEN
  delete process.env.PCLOUD_CLIENT_ID
  delete process.env.PCLOUD_CLIENT_SECRET
  ;({ program } = await import("./cli.js"))
})

afterAll(() => {
  process.env = saved
  rmSync(home, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// commander keeps the handler private; a command with neither a handler nor
// subcommands cannot exist, so this only separates groups such as `sync` (whose
// default subcommand carries the flag) from commands that run something.
const runnable = (cmd: Command): boolean =>
  (cmd as unknown as { _actionHandler: unknown })._actionHandler != null

const walk = (cmd: Command, prefix: string[] = []): [string, Command][] =>
  cmd.commands.flatMap((child) => {
    const path = [...prefix, child.name()]
    return [
      ...(runnable(child)
        ? [[path.join(" "), child] as [string, Command]]
        : []),
      ...walk(child, path),
    ]
  })

const hasJson = (cmd: Command): boolean =>
  cmd.options.some((option) => option.long === "--json")

describe("--json on every command", () => {
  it("is accepted by every non-interactive command", () => {
    const missing = walk(program)
      .filter(([path]) => !INTERACTIVE.has(path) && !PENDING.has(path))
      .filter(([, cmd]) => !hasJson(cmd))
      .map(([path]) => path)
    expect(missing).toEqual([])
  })

  it("keeps the pending list honest", () => {
    const paths = new Map(walk(program))
    for (const path of PENDING) {
      expect(paths.has(path), `${path} no longer exists`).toBe(true)
      expect(
        hasJson(paths.get(path)!),
        `${path} has --json — remove it from PENDING`,
      ).toBe(false)
    }
  })
})

// pCloud answers every method with a JSON body; the client reads it as text.
// Routed by method name so each command sees only what it asked for — no real
// API is ever reached.
const stubApi = (answers: Record<string, unknown>) => {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const method = new URL(url).pathname.slice(1)
      calls.push(method)
      const body = answers[method] ?? { result: 0 }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response
    }),
  )
  return calls
}

const run = async (...args: string[]): Promise<unknown> => {
  const out: string[] = []
  vi.spyOn(console, "log").mockImplementation((...parts) => {
    out.push(parts.join(" "))
  })
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`)
  })
  await program.parseAsync(args, { from: "user" })
  return JSON.parse(out.join("\n"))
}

const FILE = { fileid: 7, name: "notes.md", isfolder: false, path: "/notes.md" }
const FOLDER = { folderid: 42, name: "Docs", isfolder: true, path: "/Docs" }

// The fields below are the contract: a mutation emits the metadata of the item
// it produced or affected, and where pCloud returns none, an object naming the
// identifier it acted on. Changing any of these is a breaking change.
describe("mutations under --json", () => {
  it("mkdir emits the folder's metadata", async () => {
    stubApi({ createfolderifnotexists: { result: 0, metadata: FOLDER } })
    expect(await run("mkdir", "/Docs", "--json")).toEqual(FOLDER)
  })

  it("rmdir emits what was deleted", async () => {
    stubApi({
      deletefolderrecursive: { result: 0, deletedfiles: 3, deletedfolders: 1 },
    })
    expect(await run("rmdir", "42", "--json")).toEqual({
      folderid: 42,
      deletedfiles: 3,
      deletedfolders: 1,
    })
  })

  it.each([
    ["copy-file", "copyfile", ["7", "/copy.md"]],
    ["move-file", "renamefile", ["7", "/Docs/"]],
    ["rename-file", "renamefile", ["7", "renamed.md"]],
    ["delete-file", "deletefile", ["7"]],
    ["revert-revision", "revertrevision", ["7", "3"]],
  ])("%s emits the file's metadata", async (command, method, args) => {
    const calls = stubApi({ [method]: { result: 0, metadata: FILE } })
    expect(await run(command, ...args, "--json")).toEqual(FILE)
    expect(calls).toEqual([method])
  })

  it("share-folder emits the share it requested", async () => {
    stubApi({})
    expect(
      await run("share-folder", "42", "friend@example.com", "3", "--json"),
    ).toEqual({ folderid: 42, email: "friend@example.com", permissions: 3 })
  })

  it.each([
    ["accept-share", { sharerequestid: 11 }],
    ["decline-share", { sharerequestid: 11 }],
    ["remove-share", { shareid: 11 }],
  ])("%s emits the id it acted on", async (command, expected) => {
    stubApi({})
    expect(await run(command, "11", "--json")).toEqual(expected)
  })

  it("delete-publink emits the code", async () => {
    stubApi({})
    expect(await run("delete-publink", "XZabc", "--json")).toEqual({
      code: "XZabc",
    })
  })

  it("restore-trash emits the restored item's metadata", async () => {
    stubApi({
      trash_list: { result: 0, metadata: { contents: [FILE] } },
      trash_restore: { result: 0, metadata: FILE },
    })
    expect(await run("restore-trash", "7", "--json")).toEqual(FILE)
  })

  it("logout reports nothing to remove without stored credentials", async () => {
    expect(await run("logout", "--json")).toEqual({
      revoked: null,
      removed: false,
    })
  })
})
