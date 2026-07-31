import { describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url))
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url))

// The old failure printed "You will be redirected to pCloud in your browser"
// and only then discovered it had no credentials to redirect with. Asserting the
// promise is absent is the regression test; asserting the error is present is not,
// since the error was always there — just below a line that contradicted it.
const PROMISED_A_BROWSER = /redirected/i

// --oauth reads only environment variables, so unlike the browse tests this needs
// no HOME isolation: there is no credential store on the path being exercised.
const runLogin = (args: string[]) => {
  const env = { ...process.env } as NodeJS.ProcessEnv
  delete env.PCLOUD_CLIENT_ID
  delete env.PCLOUD_CLIENT_SECRET

  return spawnSync(TSX, [CLI, "login", ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
}

describe("login --oauth without an OAuth application", () => {
  it("exits non-zero", () => {
    expect(runLogin(["--oauth"]).status).toBe(1)
  })

  it("names both variables it needs", () => {
    const { stderr } = runLogin(["--oauth"])
    expect(stderr).toContain("PCLOUD_CLIENT_ID")
    expect(stderr).toContain("PCLOUD_CLIENT_SECRET")
  })

  it("offers the setup-free alternative", () => {
    expect(runLogin(["--oauth"]).stderr).toContain("pcloud login")
  })

  it("does not promise a browser it cannot open", () => {
    const { stdout, stderr } = runLogin(["--oauth"])
    expect(stdout + stderr).not.toMatch(PROMISED_A_BROWSER)
  })
})

describe("login flag conflicts", () => {
  it("refuses --oauth and --session together rather than silently picking one", () => {
    const { status, stderr } = runLogin(["--oauth", "--session"])
    expect(status).toBe(1)
    expect(stderr).toMatch(/Pick one/)
  })
})

describe("login default", () => {
  // Killed by the timeout at the password prompt — reaching the prompt at all is
  // the assertion, since it can only be reached through the session branch.
  it("goes to session login, not OAuth", () => {
    const { stdout } = runLogin([])
    expect(stdout).toContain("pCloud session login")
    expect(stdout).not.toMatch(PROMISED_A_BROWSER)
  })
})
