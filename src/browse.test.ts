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
const runBrowseLoggedOut = () => {
  const home = mkdtempSync(join(tmpdir(), "pcloud-cli-home-"))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.PCLOUD_AUTH
  delete env.PCLOUD_ACCESS_TOKEN
  delete env.PCLOUD_CLIENT_ID
  delete env.PCLOUD_CLIENT_SECRET

  try {
    return spawnSync(TSX, [CLI, "browse"], {
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
    expect(runBrowseLoggedOut().status).toBe(1)
  })

  it("says how to authenticate", () => {
    expect(runBrowseLoggedOut().stderr).toMatch(/Not authenticated/)
  })

  it("refuses before mounting the browser, not from inside it", () => {
    expect(runBrowseLoggedOut().stderr).not.toMatch(RENDER_REACHED)
  })
})
