import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url))
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))

// Reaching the render is precisely what the gate prevents, and it leaves a trace:
// mounting the browser without a TTY drives ink-picture's terminal query into a
// crash. Asserting that stack is absent is what makes this a real regression test
// — exit status alone does not discriminate, since the crash also exits non-zero.
const RENDER_REACHED = /ink-picture|TerminalInfo|at async/

// TokenStore reads os.homedir(), which is $HOME on POSIX, so pointing HOME at an
// empty directory is what makes "logged out" deterministic. cwd goes there too:
// cli.ts calls dotenv.config(), and a .env in the repo root would otherwise hand
// the subprocess the very credentials this test is trying to withhold.
const runLoggedOut = (...args: string[]) => {
  const home = mkdtempSync(join(tmpdir(), "pcloud-cli-home-"))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.PCLOUD_AUTH
  delete env.PCLOUD_ACCESS_TOKEN
  delete env.PCLOUD_CLIENT_ID
  delete env.PCLOUD_CLIENT_SECRET

  try {
    return spawnSync(TSX, [CLI, ...args], {
      cwd: home,
      env,
      encoding: "utf8",
      timeout: 60_000,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe("browse without credentials", () => {
  it("exits non-zero instead of opening the browser", () => {
    expect(runLoggedOut("browse").status).toBe(1)
  })

  it("says how to authenticate", () => {
    expect(runLoggedOut("browse").stderr).toMatch(/Not authenticated/)
  })

  it("refuses before mounting the browser, not from inside it", () => {
    expect(runLoggedOut("browse").stderr).not.toMatch(RENDER_REACHED)
  })
})

describe("--screen", () => {
  // A capture tool reads this to know which screens exist, so it has to answer
  // without a credential: enumerating tabs needs no account, and demanding one
  // would make taking screenshots require a login.
  it("lists the screens without authenticating", () => {
    const run = runLoggedOut("--screen", "list")
    expect(run.status).toBe(0)
    expect(run.stdout.trim().split("\n")).toEqual([
      "files",
      "rewind",
      "trash",
      "shares",
      "sync",
      "settings",
    ])
  })

  it("rejects an unknown screen with the names that would have worked", () => {
    const run = runLoggedOut("--screen", "nope")
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/Unknown screen "nope"/)
    expect(run.stderr).toMatch(/files, rewind, trash, shares, sync, settings/)
  })

  // --screen takes a value, so the name after it must not be counted towards
  // deciding this is a subcommand invocation. Discounting only the flag sent
  // `pcloud --screen sync` into commander, which has no `sync` command and
  // failed with an error naming neither the flag nor the real problem.
  it("still reads as a bare invocation when a screen is named", () => {
    const run = runLoggedOut("--screen", "sync")
    expect(run.stderr).toMatch(/Not authenticated/)
    expect(run.stderr).not.toMatch(/unknown command/i)
  })
})
