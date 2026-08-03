#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { basename, join } from "path"
import readline from "readline"
import { Writable } from "stream"
import { Command } from "commander"
import dotenv from "dotenv"
import {
  PCloudAPI,
  PCloudDiffEntry,
  PCloudFolderItem,
  PCloudPublink,
  PCloudRevision,
  PCloudShareItem,
  PCloudShareRequest,
  TokenStore,
  OAuthFlow,
  sessionLogin,
  resolveAuth,
  resolveStoredAuth,
  planRewind,
  applyRewind,
  pathResolver,
} from "@kud/pcloud"
import { tabsFor, type Mode } from "@kud/pcloud-ink"
import {
  renderAccount,
  renderChanges,
  renderDoctor,
  renderFileList,
  renderPublinks,
  renderRevisions,
  renderShares,
  renderTable,
  renderTrash,
  fail,
  fields,
  heading,
  note,
  ok,
  warn,
  type DoctorLine,
  type DoctorSection,
} from "./render.js"
import { checkAll } from "./lib/health.js"
import { resolveFileId, resolveFolderId } from "./lib/refs.js"
import {
  PCLOUD_DB,
  applyClearTasks,
  applyPrune,
  syncRoot,
  daemonRunning,
  databaseLocked,
  planClearTasks,
  planPrune,
  quitDaemon,
  startDaemon,
  readPairs,
  snapshot,
  strandedTasks,
  tableCounts,
  unlistedTables,
  verdicts,
  type SyncPair,
} from "./lib/sync.js"
import {
  READABLE_SETTINGS,
  assertWritable,
  formatList,
  parseList,
  readSettings,
  sameSet,
  writeSettings,
} from "./lib/settings.js"

dotenv.config({ quiet: true })

const program = new Command()

// Options bind to the subcommand they follow, rather than being hoisted to the
// nearest ancestor that happens to declare the same name. Without this,
// `settings ignore set --paths …` handed --paths to the parent `ignore`
// command, so `set` saw no flag and rewrote ignorepatterns with the paths
// list — on a live database, before there was a dry run to catch it.
program.enablePositionalOptions()
const tokenStore = new TokenStore()

const region = (process.env.PCLOUD_REGION ?? "eu").toLowerCase()
const authBaseUrl = "https://my.pcloud.com"
const defaultApiServer =
  region === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com"

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }

// Dev mode reveals machine-facing affordances in --help. It never changes what
// a flag does: cli-shot drives this CLI as a subprocess, and a --screen list
// that only worked under the variable would fail deep inside a capture run,
// where nothing in the error names the missing environment.
const devMode = process.env.PCLOUD_DEV === "1"

// browse.tsx supplies both providers on every path, so every tab exists here —
// unlike a host that omits one and gets a shorter bar.
const SCREENS = tabsFor({ sync: true, settings: true }).map((tab) => tab.value)

const screenHelp = `Open on a named screen (${SCREENS.join(", ")})`

// `--screen list` is the discovery half of the pair: a capture tool asks which
// screens exist and shoots each one, instead of carrying a table of which
// keystrokes reach which tab in this particular CLI.
const resolveScreen = (value: string | undefined): Mode | undefined => {
  if (value === undefined) return undefined
  if (value === "list") {
    console.log(SCREENS.join("\n"))
    process.exit(0)
  }
  if ((SCREENS as readonly string[]).includes(value)) return value as Mode
  console.error(`Unknown screen "${value}". Available: ${SCREENS.join(", ")}`)
  process.exit(1)
}

program
  .name("pcloud-cli")
  .description("CLI tool for pCloud file operations")
  .version(pkg.version)

const exitNotAuthenticated = (): never => {
  console.error("\n❌ Not authenticated!\n")
  console.error("It looks like you haven't set up pCloud CLI yet.\n")
  console.error("Please run this command first:\n")
  console.error("  pcloud login\n")
  console.error("This is a one-time setup that takes less than a minute.\n")
  process.exit(1)
}

const getAuthenticatedAPI = async (): Promise<PCloudAPI> => {
  try {
    return await resolveAuth({ defaultApiServer })
  } catch {
    return exitNotAuthenticated()
  }
}

// resolveStoredAuth rather than resolveAuth: the latter falls through to an
// interactive OAuth browser round-trip when PCLOUD_CLIENT_ID and _SECRET are set,
// which is the wrong thing to trigger from a precondition check. This only asks
// whether a credential is already on hand.
const requireStoredAuth = (): void => {
  if (!resolveStoredAuth({ defaultApiServer })) exitNotAuthenticated()
}

const handleError = (error: unknown): never => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

// 2000 "Log in failed" and 1000 "Log in required" are what a dead credential
// looks like on every single command. Session tokens expire on a schedule — 30
// days, or 7 idle — so this is a certainty rather than an edge case, and the
// bare pCloud wording gives no clue that re-authenticating is the remedy.
const CREDENTIAL_FAILURES = new Set([1000, 2000])

const assertSuccess = (result: number, error?: string): void => {
  if (result === 0) return

  if (CREDENTIAL_FAILURES.has(result)) {
    const stored = tokenStore.load()
    console.error(`Error: ${error || "Not authenticated"}\n`)
    console.error(
      stored?.auth
        ? "Your session token is no longer valid — they expire after 30 days,\nor 7 days unused. Sign in again:\n\n  pcloud login --session\n"
        : "Sign in again:\n\n  pcloud login\n",
    )
    process.exit(1)
  }

  console.error(`Error: ${error || "Unknown error"}`)
  process.exit(1)
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i]
}

const padEnd = (str: string, length: number): string =>
  str.length >= length ? str : str + " ".repeat(length - str.length)

const tally = <T>(items: T[], key: (item: T) => string): [string, number][] => {
  const counts = new Map<string, number>()
  items.forEach((item) => {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  })
  return [...counts.entries()]
}

const printChangeSummary = (entries: PCloudDiffEntry[]): void => {
  console.log("By event type:")
  tally(entries, (entry) => entry.event)
    .sort((a, b) => b[1] - a[1])
    .forEach(([event, count]) => console.log(`  ${padEnd(event, 18)}${count}`))

  console.log("\nBy minute:")
  tally(entries, (entry) =>
    (entry.time ?? "?").replace(/:\d\d \+\d+$/, ""),
  ).forEach(([minute, count]) => console.log(`  ${padEnd(minute, 26)}${count}`))

  console.log(`\n${entries.length} events`)
}

const ask = (question: string): Promise<string> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })

const askHidden = (question: string): Promise<string> => {
  let muted = false
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding)
      callback()
    },
  })
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write("\n")
      resolve(answer)
    })
    muted = true
  })
}

const runSessionLogin = async (): Promise<void> => {
  console.log("\n🔐 pCloud session login\n")
  console.log(
    "Session tokens reach the parts OAuth cannot: revisions, trash, zip",
  )
  console.log("and downloads. Your password is sent to pCloud over HTTPS and")
  console.log("is never written to disk — only the returned token is stored.\n")
  console.log("Prefer not to type it here? `pcloud login --oauth` uses the")
  console.log("browser instead, if you have an OAuth application registered.\n")

  const username = await ask("Email: ")
  const password = await askHidden("Password: ")

  const { auth, apiServer, expiresAt } = await sessionLogin({
    username,
    password,
    apiServer: defaultApiServer,
    requestCode: async () => ask("Two-factor code: "),
  })

  const stored = tokenStore.load()
  tokenStore.save({
    ...stored,
    auth,
    expiresAt,
    hostname: new URL(apiServer).host,
  })

  console.log("\n✓ Session token saved.")
  if (expiresAt) {
    console.log(`  Expires ${new Date(expiresAt).toLocaleString()}`)
    console.log("  Also expires after 7 days unused.")
  }
  console.log("  Revoke any time with: pcloud logout\n")
  console.log("Try: pcloud list-trash\n")
}

program
  .command("login")
  .description("Set up authentication with pCloud")
  .option(
    "--oauth",
    "Log in through the browser instead (requires PCLOUD_CLIENT_ID and PCLOUD_CLIENT_SECRET)",
  )
  .option("--session", "Accepted and ignored — session login is the default")
  .action(async (options) => {
    if (options.oauth && options.session) {
      console.error(
        "Error: --oauth and --session ask for different flows. Pick one.\n",
      )
      process.exit(1)
    }

    // Session is the default because it is both the cheaper and the more capable
    // tier: it needs no registered OAuth application, and it is the only one that
    // reaches revisions, trash, zip and downloads. OAuth's advantage — never
    // handling the password — is real but narrow, so it earns a flag rather than
    // the default.
    if (!options.oauth) {
      try {
        await runSessionLogin()
        return
      } catch (error) {
        console.error("\n❌ Session login failed.")
        console.error(
          `   ${error instanceof Error ? error.message : "Unknown error"}\n`,
        )
        process.exit(1)
      }
    }

    try {
      // Checked before the welcome banner rather than after it. Announcing "you
      // will be redirected to your browser" and only then discovering there is
      // nothing to redirect with leaves the user reading an instruction the next
      // line contradicts.
      const clientId = process.env.PCLOUD_CLIENT_ID
      const clientSecret = process.env.PCLOUD_CLIENT_SECRET

      if (!clientId || !clientSecret) {
        console.error(
          "\n❌ OAuth needs PCLOUD_CLIENT_ID and PCLOUD_CLIENT_SECRET.\n",
        )
        console.error("Register an application at")
        console.error("  https://docs.pcloud.com/methods/oauth_2.0/")
        console.error("then export both in your shell or a .env file.\n")
        console.error(
          "Or just run `pcloud login` — it needs no setup at all, and",
        )
        console.error(
          "reaches revisions, trash, zip and downloads that OAuth cannot.\n",
        )
        process.exit(1)
      }

      console.log("\n🔐 pCloud OAuth login\n")
      console.log("You will be redirected to pCloud in your browser to log in.")
      console.log(
        "After logging in, you'll be redirected back automatically.\n",
      )

      const oauth = new OAuthFlow(clientId, clientSecret, authBaseUrl)
      const tokens = await oauth.authenticate()

      console.log("\n✓ Authentication successful!")

      tokenStore.save({
        access_token: tokens.access_token,
        hostname: tokens.hostname,
      })

      console.log("\n🎉 Setup complete!")
      console.log("   Your access has been saved securely.")
      console.log("   You can now use all pCloud CLI commands.\n")
      console.log("Try: pcloud ls\n")
    } catch (error) {
      console.error("\n❌ Authentication failed.")
      console.error(
        `   ${error instanceof Error ? error.message : "Unknown error"}\n`,
      )
      process.exit(1)
    }
  })

program
  .command("logout")
  .description("Revoke the session token and remove stored credentials")
  .action(async () => {
    const stored = tokenStore.load()
    if (!stored) {
      console.log("No stored credentials found")
      return
    }

    // Deleting the local file leaves a session token live on pCloud until it
    // expires, so revoke first and only report success for what actually happened.
    if (stored.auth) {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.logout()
        console.log(
          response.auth_deleted
            ? "✓ Session token revoked on pCloud"
            : "⚠ pCloud did not confirm revocation — check pcloud.com → Settings → Devices",
        )
      } catch (error) {
        console.error(
          `⚠ Could not reach pCloud to revoke the token: ${error instanceof Error ? error.message : error}`,
        )
        console.error(
          "  The token may still be valid. Revoke it at pcloud.com.",
        )
      }
    }

    tokenStore.delete()
    ok("Local credentials removed")
  })

// Every data-returning command renders by default and emits the raw payload
// under --json. Registered per command rather than as one option on `program`:
// enablePositionalOptions() binds an option to the subcommand it follows, so a
// program-level flag would only ever parse as `pcloud --json ls` — the opposite
// end of the line from where anyone types it.
const jsonOption = (cmd: Command): Command =>
  cmd.option("--json", "Output raw JSON")

const emit = <T>(
  options: { json?: boolean },
  data: T,
  render: () => void,
): void => {
  if (options.json) console.log(JSON.stringify(data, null, 2))
  else render()
}

// The rendered half of `stat`. The API returns twelve keys, several of which
// (thumb, comments, icon) answer questions nobody asked of a metadata command —
// they stay reachable under --json rather than crowding the default view.
const renderStat = (meta: Record<string, unknown>): void => {
  const isFolder = Boolean(meta.isfolder)
  const rows = [
    {
      label: "Type",
      value: isFolder ? "folder" : String(meta.contenttype ?? "file"),
    },
    { label: "ID", value: String(meta.id ?? "—") },
  ]
  if (!isFolder && meta.size !== undefined)
    rows.push({
      label: "Size",
      value: `${Number(meta.size).toLocaleString()} bytes`,
    })
  rows.push(
    { label: "Created", value: String(meta.created ?? "—") },
    { label: "Modified", value: String(meta.modified ?? "—") },
    { label: "Owner", value: meta.ismine ? "you" : "shared with you" },
    { label: "Shared", value: meta.isshared ? "yes" : "no" },
  )
  heading(String(meta.name ?? "—"))
  fields(rows)
}

jsonOption(
  program
    .command("whoami")
    .description("Show account information")
    .action(async (options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.userInfo()
        assertSuccess(response.result, response.error)
        emit(options, response, () => renderAccount(response))
      } catch (error) {
        handleError(error)
      }
    }),
)

jsonOption(
  program
    .command("ls")
    .description("List folder contents")
    .argument("[path]", "Folder path", "/")
    .action(async (path: string, options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.listFolder(path)
        assertSuccess(response.result, response.error)

        const contents = response.metadata?.contents ?? []
        emit(options, contents, () => renderFileList(contents))
      } catch (error) {
        handleError(error)
      }
    }),
)

jsonOption(
  program
    .command("stat")
    .description("Show file or folder metadata")
    .argument("<path>", "File or folder path")
    .action(async (path: string, options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.stat(path)
        assertSuccess(response.result, response.error)
        const meta = response.metadata as unknown as Record<string, unknown>
        emit(options, response.metadata, () => renderStat(meta))
      } catch (error) {
        handleError(error)
      }
    }),
)

program
  .command("mkdir")
  .description("Create a folder (no-op if it already exists)")
  .argument("<path>", "Folder path to create")
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.createFolder(path)
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("rmdir")
  .description("Recursively delete a folder and all its contents")
  .argument("<folder>", "Folder path or id to delete")
  .action(async (folder: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deleteFolder(
        await resolveFolderId(api, folder),
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("copy-file")
  .description("Copy a file to a new path")
  .argument("<file>", "File path or id to copy")
  .argument("<topath>", "Destination path")
  .action(async (file: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.copyFile(
        await resolveFileId(api, file),
        topath,
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("move-file")
  .description("Move a file to a new path")
  .argument("<file>", "File path or id to move")
  .argument("<topath>", "Destination path")
  .action(async (file: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.moveFile(
        await resolveFileId(api, file),
        topath,
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("rename-file")
  .description("Rename a file")
  .argument("<file>", "File path or id to rename")
  .argument("<toname>", "New file name")
  .action(async (file: string, toname: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.renameFile(
        await resolveFileId(api, file),
        toname,
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("delete-file")
  .description("Permanently delete a file")
  .argument("<file>", "File path or id to delete")
  .action(async (file: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deleteFile(await resolveFileId(api, file))
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

// The bare default stays bare — `value()` exists so a link pipes without jq,
// and wrapping one string in an object would make the common case worse. The
// flag is here so a script can pass --json to any command without first
// checking which ones happen to return a single value.
jsonOption(
  program
    .command("get-link")
    .description("Get a download URL for a file")
    .argument("<file>", "File path or id")
    .action(async (file: string, options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getFileLink(await resolveFileId(api, file))
        assertSuccess(response.result, response.error)
        const link = `https://${response.hosts[0]}${response.path}`
        emit(options, { link }, () => console.log(link))
      } catch (error) {
        handleError(error)
      }
    }),
)

jsonOption(
  program
    .command("checksum")
    .description("Print SHA256, SHA1 and MD5 checksums for a file")
    .argument("<file>", "File path or id")
    .action(async (file: string, options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.checksumFile(await resolveFileId(api, file))
        assertSuccess(response.result, response.error)
        const sums = {
          sha256: response.sha256,
          sha1: response.sha1,
          md5: response.md5,
        }
        emit(options, sums, () => {
          console.log(`SHA256  ${response.sha256}`)
          console.log(`SHA1    ${response.sha1}`)
          console.log(`MD5     ${response.md5}`)
        })
      } catch (error) {
        handleError(error)
      }
    }),
)

jsonOption(
  program
    .command("list-revisions")
    .description("List revisions for a file")
    .argument("<file>", "File path or id")
    .action(async (file: string, options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.listRevisions(await resolveFileId(api, file))
        assertSuccess(response.result, response.error)

        const revisions = response.revisions ?? []
        emit(options, revisions, () => renderRevisions(revisions))
      } catch (error) {
        handleError(error)
      }
    }),
)

program
  .command("revert-revision")
  .description("Revert a file to a previous revision")
  .argument("<file>", "File path or id")
  .argument("<revisionid>", "Revision ID to revert to")
  .action(async (file: string, revisionid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.revertRevision(
        await resolveFileId(api, file),
        parseInt(revisionid, 10),
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("list-shares")
  .description("List all active folder shares")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listShares()
      assertSuccess(response.result, response.error)

      const shares = response.shares ?? {}
      const requests = response.requests ?? {}

      // Emitted before the sections rather than through `emit`: this command
      // renders four heterogeneous tables and an empty-state, so the JSON half
      // is a single payload where the rendered half is not a single call.
      if (options.json) {
        console.log(JSON.stringify({ shares, requests }, null, 2))
        return
      }
      const sections: [string, "outgoing" | "incoming", PCloudShareItem[]][] = [
        ["Shared with others", "outgoing", shares.outgoing ?? []],
        ["Shared with you", "incoming", shares.incoming ?? []],
      ]
      const pending: [string, PCloudShareRequest[]][] = [
        ["Requests you sent", requests.outgoing ?? []],
        ["Requests awaiting you", requests.incoming ?? []],
      ]

      const total =
        sections.reduce((n, [, , rows]) => n + rows.length, 0) +
        pending.reduce((n, [, rows]) => n + rows.length, 0)
      if (total === 0) {
        console.log("No shares found")
        return
      }

      for (const [title, direction, rows] of sections) {
        if (rows.length === 0) continue
        renderShares(rows, direction, title)
      }

      // Kept separate rather than merged: these carry sharerequestid and the
      // permissions bitmask, and it is the request id that accept and decline
      // take. Listing them as one table is what sent `remove-share` the wrong id.
      for (const [title, rows] of pending) {
        if (rows.length === 0) continue
        renderTable(
          rows.map((req) => ({
            id: String(req.sharerequestid ?? "-"),
            folder: req.sharename ?? String(req.folderid),
            address: req.mail ?? "-",
            permissions: String(req.permissions ?? "-"),
          })),
          [
            { key: "id", header: "Request ID" },
            { key: "folder", header: "Folder" },
            { key: "address", header: "Address" },
            { key: "permissions", header: "Permissions" },
          ],
          title,
        )
      }
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("share-folder")
  .description(
    "Share a folder with another pCloud user (permissions: 1=Create, 2=Modify, 4=Delete)",
  )
  .argument("<folder>", "Folder path or id to share")
  .argument("<email>", "Recipient email address")
  .argument(
    "<permissions>",
    "Permission bitmask (1=Create, 2=Modify, 4=Delete)",
  )
  .action(async (folder: string, email: string, permissions: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.shareFolder(
        await resolveFolderId(api, folder),
        email,
        parseInt(permissions, 10),
      )
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("accept-share")
  .description("Accept an incoming share request")
  .argument("<sharerequestid>", "Share request ID")
  .action(async (sharerequestid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.acceptShare(parseInt(sharerequestid, 10))
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("decline-share")
  .description("Decline an incoming share request")
  .argument("<sharerequestid>", "Share request ID")
  .action(async (sharerequestid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.declineShare(parseInt(sharerequestid, 10))
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("remove-share")
  .description("Remove an active share (see Share ID in `pcloud list-shares`)")
  .argument("<shareid>", "Share ID of the accepted share")
  .action(async (shareid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.removeShare(parseInt(shareid, 10))
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("publink-file")
  .description("Create a public download link for a file")
  .argument("<file>", "File path or id")
  .option("--expire <date>", "Expiry datetime (YYYY-MM-DD HH:MM:SS)")
  .option("--max-downloads <n>", "Maximum number of downloads")
  .option("--json", "Output raw JSON")
  .action(
    async (
      file: string,
      options: { expire?: string; maxDownloads?: string; json?: boolean },
    ) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getFilePublink(
          await resolveFileId(api, file),
          options.expire,
          options.maxDownloads !== undefined
            ? parseInt(options.maxDownloads, 10)
            : undefined,
        )
        assertSuccess(response.result, response.error)
        emit(options, { link: response.link }, () => console.log(response.link))
      } catch (error) {
        handleError(error)
      }
    },
  )

program
  .command("publink-folder")
  .description("Create a public link for a folder")
  .argument("<folder>", "Folder path or id")
  .option("--expire <date>", "Expiry datetime (YYYY-MM-DD HH:MM:SS)")
  .option("--json", "Output raw JSON")
  .action(
    async (folder: string, options: { expire?: string; json?: boolean }) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getFolderPublink(
          await resolveFolderId(api, folder),
          options.expire,
        )
        assertSuccess(response.result, response.error)
        emit(options, { link: response.link }, () => console.log(response.link))
      } catch (error) {
        handleError(error)
      }
    },
  )

jsonOption(
  program
    .command("list-publinks")
    .description("List all active public links")
    .action(async (options) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.listPublinks()
        assertSuccess(response.result, response.error)

        const publinks = response.publinks ?? []
        emit(options, publinks, () => renderPublinks(publinks))
      } catch (error) {
        handleError(error)
      }
    }),
)

program
  .command("delete-publink")
  .description("Delete a public link by its code")
  .argument("<code>", "Public link code")
  .action(async (code: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deletePublink(code)
      assertSuccess(response.result, response.error)
      ok("Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("zip")
  .description("Get a download URL for a ZIP archive of files and/or folders")
  .argument("<files...>", "File paths or ids to include in the ZIP")
  .option("--folder <folder...>", "Folder paths or ids to include")
  .option("--filename <name>", "Name for the ZIP file")
  .option("--json", "Output raw JSON")
  .action(
    async (
      files: string[],
      options: { folder?: string[]; filename?: string; json?: boolean },
    ) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getZipLink(
          await Promise.all(files.map((ref) => resolveFileId(api, ref))),
          options.folder &&
            (await Promise.all(
              options.folder.map((ref) => resolveFolderId(api, ref)),
            )),
          options.filename,
        )
        assertSuccess(response.result, response.error)
        const link = `https://${response.hosts[0]}${response.path}`
        emit(options, { link }, () => console.log(link))
      } catch (error) {
        handleError(error)
      }
    },
  )

const TRASH_OAUTH_WARNING =
  "\n⚠  Trash endpoints require a session token.\n" +
  "   pCloud's OAuth access tokens do not grant access to trash_list / trash_restore.\n" +
  "   This is a pCloud API limitation — no workaround exists via OAuth.\n"

program
  .command("list-trash")
  .description(
    "List files in trash (⚠ requires session auth — limited with OAuth)",
  )
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listTrash()
      if (response.result === 1000) {
        console.error(TRASH_OAUTH_WARNING)
        process.exit(1)
      }
      assertSuccess(response.result, response.error)

      const items = (response.contents ?? []) as any[]
      emit(options, items, () => {
        if (items.length === 0) {
          console.log("Trash is empty")
          return
        }

        // Printing fileid alone left every folder showing "-", and trash is
        // mostly folders — so the id needed to restore something was exactly the
        // one the listing would not show. TrashList picks whichever exists.
        renderTrash(items)

        console.log(`\n${items.length} items. Restore with:\n`)
        console.log("  pcloud restore-trash <ID> [--to /somewhere]\n")
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("restore-trash")
  .description("Restore a file or folder from trash by ID")
  .argument("<id>", "File ID, or folder ID with --folder")
  .option(
    "--folder",
    "Force folder handling (detected automatically for trash-root items)",
  )
  .option(
    "--to <path>",
    "Restore into this folder instead of the original location",
  )
  .action(async (id: string, options) => {
    try {
      const api = await getAuthenticatedAPI()

      // Naming a destination means resolving it first: pCloud wants a folderid,
      // and a path that does not exist should fail here rather than halfway
      // through restoring a tree.
      let restoreTo: number | undefined
      if (options.to) {
        const target = await api.stat(options.to)
        const folderid = (target.metadata as { folderid?: number } | undefined)
          ?.folderid
        if (target.result !== 0 || folderid === undefined) {
          console.error(`Error: no such destination folder: ${options.to}`)
          process.exit(1)
        }
        restoreTo = folderid
      }

      const numeric = parseInt(id, 10)

      // Trash knows whether an id is a folder, so the user should not have to.
      // --folder stays as an override for an id that is not at the trash root.
      let isFolder = Boolean(options.folder)
      if (!options.folder) {
        const trash = await api.listTrash()
        const entry = (trash.contents ?? []).find(
          (item: any) => item.folderid === numeric || item.fileid === numeric,
        ) as { folderid?: number } | undefined
        isFolder = entry?.folderid === numeric
      }

      const response = isFolder
        ? await api.restoreFolderFromTrash(numeric, { restoreTo })
        : await api.restoreFromTrash(numeric, { restoreTo })

      if (response.result === 1000) {
        console.error(TRASH_OAUTH_WARNING)
        process.exit(1)
      }
      assertSuccess(response.result, response.error)

      const where = (response.metadata as { path?: string } | undefined)?.path
      console.log(
        `✓ Restored ${options.folder ? "folder" : "file"} ${id}${where ? ` to ${where}` : ""}.`,
      )
    } catch (error) {
      handleError(error)
    }
  })

// Rewind is a pCloud web-app feature with no public API behind it: the
// endpoints these commands were written against (listrewindevents, file_restore)
// 404 at the router, as do listrewind, rewind, rewindlist and listrewindfiles.
// Kept as signposts so the command name leads somewhere useful instead of
// failing with a bare HTTP 404.
const rewindUnavailable = (): never => {
  console.error("pCloud's Rewind feature has no public API.\n")
  console.error("Use `pcloud rewind` instead — it reconstructs the same thing")
  console.error("from change history, file revisions and trash:\n")
  console.error('  pcloud rewind --to "2026-07-30 20:30" --path /Projects\n')
  console.error("Related:")
  console.error("  pcloud changes         what changed, and when")
  console.error("  pcloud list-revisions  previous versions of a single file")
  console.error("  pcloud list-trash      recoverable deleted files\n")
  process.exit(1)
}

program
  .command("list-rewind")
  .description("Unavailable — Rewind has no public API (see `pcloud changes`)")
  .argument("[path]", "Path to check (e.g., /myfile.txt)")
  .action(rewindUnavailable)

program
  .command("restore-rewind")
  .description("Unavailable — Rewind has no public API (see `pcloud changes`)")
  .argument("[fileid]", "File ID to restore")
  .argument("[topath]", "Destination path (e.g., /restored-file.txt)")
  .action(rewindUnavailable)

program
  .command("changes")
  .description(
    "Show account change history — what was created, modified or deleted, and when",
  )
  .option("-n, --last <n>", "Number of most recent events to fetch", "200")
  .option("--after <datetime>", "Only events after this datetime")
  .option("--deleted", "Only deletions")
  .option("--event <type...>", "Filter by event type (e.g. deletefile)")
  .option("--summary", "Group counts by minute and by event type")
  .option("--paths", "Resolve full paths (one lookup per distinct folder)")
  .option("--json", "Output raw JSON")
  .action(async (options) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.diff(
        options.after
          ? { after: options.after }
          : { last: parseInt(options.last, 10) },
      )
      assertSuccess(response.result, response.error)

      const wanted = new Set<string>(options.event ?? [])
      const entries = (response.entries ?? []).filter(
        (entry) =>
          (!options.deleted || entry.event.startsWith("delete")) &&
          (wanted.size === 0 || wanted.has(entry.event)),
      )

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }

      if (entries.length === 0) {
        console.log("No matching events")
        return
      }

      // Paths are resolved only for the table, and only when asked: it costs a
      // listfolder per distinct parent, which a summary of counts does not need.
      if (!options.summary && options.paths) {
        const toPath = pathResolver(api, entries)
        for (const entry of entries) {
          const path = await toPath(entry)
          if (path) entry.metadata = { ...entry.metadata, path }
        }
      }

      if (options.summary) {
        printChangeSummary(entries)
        return
      }

      renderChanges(entries)
      console.log(`\n${entries.length} events`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("rewind")
  .description(
    "Undo changes made since a point in time — restores deletions, reverts edits",
  )
  .requiredOption(
    "--to <datetime>",
    'Point to rewind to (e.g. "2026-07-30 20:30")',
  )
  .option("--path <prefix>", "Only act on paths under this prefix")
  .option("--apply", "Actually perform the plan (default is a dry run)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (options) => {
    try {
      const since = new Date(options.to)
      if (Number.isNaN(since.getTime())) {
        console.error(`Error: could not read "${options.to}" as a date`)
        process.exit(1)
      }

      const api = await getAuthenticatedAPI()
      const plan = await planRewind(api, since, options.path)

      const restores = plan.actions.filter((a) => a.kind === "restore")
      const reverts = plan.actions.filter((a) => a.kind === "revert")
      const created = plan.actions.filter((a) => a.kind === "created")

      console.log(
        `\nRewinding to ${since.toLocaleString()}${options.path ? ` under ${options.path}` : ""}`,
      )
      console.log(`Scanned ${plan.scanned} events.\n`)

      const show = (label: string, actions: typeof plan.actions) => {
        if (!actions.length) return
        console.log(`${label} (${actions.length}):`)
        actions
          .slice(0, 20)
          .forEach((a) => console.log(`  ${a.path || a.name}`))
        if (actions.length > 20)
          console.log(`  … and ${actions.length - 20} more`)
        console.log()
      }

      show("Restore from trash", restores)
      show("Revert to earlier revision", reverts)

      // Undoing a creation means deleting a real file, which is the same
      // action as the accident this command exists to repair. Reported, never
      // performed — the user can delete them deliberately if that is the intent.
      if (created.length) {
        console.log(
          `Created since then (${created.length}) — left alone, delete manually if unwanted:`,
        )
        created
          .slice(0, 10)
          .forEach((a) => console.log(`  ${a.path || a.name}`))
        if (created.length > 10)
          console.log(`  … and ${created.length - 10} more`)
        console.log()
      }

      if (!restores.length && !reverts.length) {
        console.log("Nothing to undo.\n")
        return
      }

      if (!options.apply) {
        console.log("This was a dry run. Re-run with --apply to perform it.\n")
        return
      }

      if (!options.yes) {
        const answer = await ask(
          `Apply ${restores.length + reverts.length} changes? (yes/no) `,
        )
        if (answer.toLowerCase() !== "yes") {
          console.log("Cancelled.\n")
          return
        }
      }

      const outcomes = await applyRewind(api, plan)
      const failed = outcomes.filter((o) => !o.ok)

      outcomes
        .filter((o) => o.ok)
        .forEach((o) => ok(`${o.action.path} — ${o.detail}`))
      failed.forEach((o) => console.error(`✗ ${o.action.path} — ${o.detail}`))

      console.log(
        `\n${outcomes.length - failed.length} succeeded, ${failed.length} failed.\n`,
      )
      if (failed.length) process.exit(1)
    } catch (error) {
      handleError(error)
    }
  })

const HEALTH_GLYPH: Record<string, string> = {
  ok: "✓",
  "needs-session": "🌶️",
  "no-permission": "🌶️",
  missing: "🔥",
}

const shortenHome = (path: string): string =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path

const CRITICAL = new Set(["orphaned", "remote-missing", "stuck"])

const pairGlyph = (pair: SyncPair): string =>
  pair.issues.length === 0
    ? "✓"
    : pair.issues.some((issue) => CRITICAL.has(issue.kind))
      ? "🔥"
      : "🌶️"

// A tick occupies one terminal cell where the emoji glyphs occupy two, so it is
// padded to match. Without this every healthy row's columns sit one cell to the
// left of the unhealthy ones, which is worst exactly when a table is being
// scanned for the odd row out.
const glyphCell = (glyph: string): string =>
  glyph === "✓" ? `${glyph} ` : glyph

const REMOTE_NONE = "— orphaned"

const renderPairs = (pairs: SyncPair[]): void => {
  const localCol =
    Math.max(5, ...pairs.map((p) => shortenHome(p.localpath).length)) + 2
  const remoteCol =
    Math.max(6, ...pairs.map((p) => (p.remotepath ?? REMOTE_NONE).length)) + 2

  console.log(
    `   ${padEnd("Local", localCol)}${padEnd("Remote", remoteCol)}${padEnd("Files", 8)}Queue`,
  )

  pairs.forEach((pair) =>
    console.log(
      `${glyphCell(pairGlyph(pair))} ${padEnd(shortenHome(pair.localpath), localCol)}${padEnd(pair.remotepath ?? REMOTE_NONE, remoteCol)}${padEnd(String(pair.files || "–"), 8)}${pair.queued || "–"}`,
    ),
  )

  const unhealthy = pairs.filter((pair) => pair.issues.length > 0)
  if (unhealthy.length === 0) {
    console.log("\nAll sync pairs healthy.\n")
    return
  }

  console.log()
  unhealthy.forEach((pair) => {
    console.log(
      `${pairGlyph(pair)} #${pair.id}  ${shortenHome(pair.localpath)}`,
    )
    pair.issues.forEach((issue) => console.log(`   ${issue.detail}`))
    if (pair.issues.some((issue) => issue.kind === "orphaned"))
      console.log(`   → pcloud sync prune ${pair.id}`)
    console.log()
  })
}

const renderPairDetail = (
  db: ReturnType<typeof snapshot>["db"],
  pair: SyncPair,
): void => {
  console.log(`\nSync pair #${pair.id}\n`)
  console.log(`  Local     ${shortenHome(pair.localpath)}`)
  console.log(`  Remote    ${pair.remotepath ?? REMOTE_NONE}`)
  console.log(`  Folder id ${pair.folderid ?? "— none"}`)
  console.log(`  Indexed   ${pair.folders} folders, ${pair.files} files`)
  console.log(`  Queue     ${pair.queued} task(s)`)

  const stranded = strandedTasks(db, pair.id)
  if (stranded.length) {
    console.log("\n  Queued with no destination:")
    stranded.forEach((task) =>
      console.log(`    ${task.name ?? "?"}  (type ${task.type})`),
    )
  }

  if (pair.issues.length === 0) {
    console.log("\n  Healthy.\n")
    return
  }

  console.log()
  pair.issues.forEach((issue) =>
    console.log(`  ${issue.kind.padEnd(16)}${issue.detail}`),
  )
  console.log()
}

const renderDebug = (snap: ReturnType<typeof snapshot>): void => {
  console.log(
    "\npCloud Drive   " + (daemonRunning() ? "running" : "not running"),
  )
  console.log(`Database       ${shortenHome(snap.source)}`)
  console.log(
    `               ${formatBytes(snap.bytes)} · WAL ${snap.hadWal ? "present (snapshot replayed it)" : "checkpointed"}`,
  )

  const counts = tableCounts(snap.db)
  const width = Math.max(...counts.map((row) => row.table.length)) + 2
  console.log(
    "\nTable counts (allowlisted — credential and crypto tables are never read):\n",
  )
  counts.forEach((row) =>
    console.log(`  ${padEnd(row.table, width)}${row.rows}`),
  )

  const unlisted = unlistedTables(snap.db)
  if (unlisted.length)
    console.log(`\nNot shown (${unlisted.length}): ${unlisted.join(", ")}`)
  console.log()
}

// The verdict needs the faults before the detail section prints them, and the
// remedy differs by kind — prune unpairs a folder outright, which is right for
// a pair pointed at a deleted remote and catastrophic for a healthy one with a
// stuck queue. Naming the wrong command here would be worse than naming none.
// Erroring with "quit pCloud Drive and retry" makes you do by hand what the
// command could do for you — and it is a fiddly dance: quit, confirm it really
// exited, run, restart. Offering it is strictly better, provided the restart
// happens even when the write fails.
const withDaemonStopped = async <T>(
  dbPath: string,
  assumeYes: boolean,
  work: () => T,
): Promise<T | undefined> => {
  const daemonWasRunning = dbPath === PCLOUD_DB && daemonRunning()

  if (daemonWasRunning) {
    if (!assumeYes) {
      warn("pCloud Drive is running and holds this database.")
      note("It must be quit for the write to stick — it rewrites its own state")
      note("from memory when it exits, and would undo the change silently.")
      const answer = await ask(
        "\nQuit pCloud Drive, apply, and restart it? [y/N] ",
      )
      if (!/^y(es)?$/i.test(answer)) {
        fail("Cancelled — nothing was changed.")
        return undefined
      }
    }

    note("Quitting pCloud Drive…")
    if (!quitDaemon()) {
      fail("pCloud Drive did not quit — nothing was changed.")
      return undefined
    }
  }

  // The database can still be held by something that is not the daemon, and
  // that is not ours to close.
  if (databaseLocked(dbPath)) {
    fail(`Something still holds ${shortenHome(dbPath)} — nothing was changed.`)
    if (daemonWasRunning) startDaemon()
    return undefined
  }

  try {
    return work()
  } finally {
    // In a finally, so a failed write still leaves your sync running. Leaving
    // pCloud Drive quit because a command threw would be a worse outcome than
    // the thing that threw.
    if (daemonWasRunning) {
      note("Restarting pCloud Drive…")
      startDaemon()
    }
  }
}

const localProblems = (dbPath: string): { detail: string; fix?: string }[] => {
  if (!existsSync(dbPath)) return []
  const snap = snapshot(dbPath)
  try {
    return readPairs(snap.db)
      .filter((pair) => pair.issues.length > 0)
      .map((pair) => ({
        // Terse on purpose: the Sync section below prints the path, the remote
        // and every issue in full. A verdict that repeats all of it truncates,
        // and a truncated verdict is worse than a short one.
        detail: `pair #${pair.id} · ${pair.issues.map((issue) => issue.kind).join(", ")}`,
        fix: pair.issues.some((issue) => issue.kind === "orphaned")
          ? `pcloud sync prune ${pair.id}`
          : pair.issues.some((issue) => issue.kind === "stuck")
            ? `pcloud sync clear-tasks ${pair.id}`
            : undefined,
      }))
  } catch {
    return []
  } finally {
    snap.close()
  }
}

// The detail section, printed under a verdict that has already named the fault
// and its remedy. Repeating either here would make you read the same sentence
// twice to learn nothing new — so this is only the evidence: which pair, which
// files, and what distinguishes them from each other.
// Returns data rather than printing it, so the renderer owns every colour and
// column in one place. The section carries only evidence: the verdict above it
// has already named the fault and its remedy, and repeating either would make
// you read the same sentence twice to learn nothing new.
const describeDaemon = (
  dbPath: string,
): { summary: string; section: DoctorSection } => {
  const empty = { title: "Sync", lines: [] as DoctorLine[] }
  if (!existsSync(dbPath))
    return {
      summary: "no database — pCloud Drive is not installed here",
      section: empty,
    }

  const snap = snapshot(dbPath)
  try {
    const pairs = readPairs(snap.db)
    const broken = pairs.filter((pair) => pair.issues.length > 0)
    const summary = `${pairs.length} pair${pairs.length === 1 ? "" : "s"} · daemon ${daemonRunning() ? "running" : "not running"}`

    const lines: DoctorLine[] = broken.flatMap((pair) => {
      const stranded = strandedTasks(snap.db, pair.id)
      const critical = pair.issues.some((issue) => CRITICAL.has(issue.kind))
      return [
        {
          glyph: critical ? ("bad" as const) : ("warn" as const),
          label: `#${pair.id}  ${shortenHome(pair.localpath)} → ${pair.remotepath ?? REMOTE_NONE}`,
        },
        // The issue gets its own line rather than trailing the path as muted
        // detail. It is the finding — the single most important sentence in
        // the report — and painting it dimmer than the path it belongs to had
        // the hierarchy exactly backwards.
        ...pair.issues.map((issue) => ({
          glyph: critical ? ("bad" as const) : ("warn" as const),
          label: `    ${issue.detail}`,
        })),
        // Two rows reading the same filename say nothing about each other. The
        // local id distinguishes them, and tells you they are two different
        // files rather than one listed twice.
        ...stranded.slice(0, 5).map((task) => ({
          glyph: "note" as const,
          label: `      ${task.name ?? "?"}`,
          detail: `local id ${task.localitemid}`,
        })),
        ...(stranded.length > 5
          ? [
              {
                glyph: "note" as const,
                label: `      … and ${stranded.length - 5} more`,
              },
            ]
          : []),
      ]
    })

    const title =
      broken.length === 0
        ? "Sync"
        : `Sync — ${broken.length} pair${broken.length === 1 ? "" : "s"} need attention`
    return { summary, section: { title, lines } }
  } finally {
    snap.close()
  }
}

const sync = program
  .command("sync")
  .description("Inspect the local pCloud Drive sync daemon")

sync
  .command("status", { isDefault: true })
  .description("Show local sync pairs and their health")
  .argument("[id]", "Show detail for a single sync pair")
  .option("--json", "Output raw JSON")
  .option("--debug", "Show daemon state, table counts and schema anomalies")
  .option("--db <path>", "Read a different database file", PCLOUD_DB)
  .action((id: string | undefined, options) => {
    try {
      const snap = snapshot(options.db)
      try {
        if (options.debug && !id) {
          renderDebug(snap)
          return
        }

        const pairs = readPairs(snap.db)

        if (options.json) {
          console.log(
            JSON.stringify(
              id
                ? (pairs.find((pair) => pair.id === parseInt(id, 10)) ?? null)
                : pairs,
              null,
              2,
            ),
          )
          return
        }

        if (id) {
          const pair = pairs.find((p) => p.id === parseInt(id, 10))
          if (!pair) {
            console.error(`Error: no sync pair with id ${id}`)
            process.exit(1)
          }
          renderPairDetail(snap.db, pair)
          return
        }

        console.log(
          `\npCloud Drive   ${daemonRunning() ? "running" : "not running"}`,
        )
        console.log(
          `Database       ${shortenHome(snap.source)} · ${formatBytes(snap.bytes)}\n`,
        )
        renderPairs(pairs)
      } finally {
        snap.close()
      }
    } catch (error) {
      handleError(error)
    }
  })

sync
  .command("prune")
  .description("Remove an orphaned sync pair and its local index")
  .argument("<id>", "Sync pair id (from `pcloud sync`)")
  .option("--apply", "Perform the deletion (default is a dry run)")
  .option("--yes", "Do not ask before quitting pCloud Drive")
  .option("--db <path>", "Operate on a different database file", PCLOUD_DB)
  .action(async (id: string, options) => {
    try {
      const syncid = parseInt(id, 10)
      const snap = snapshot(options.db)
      const plan = (() => {
        try {
          return planPrune(snap.db, syncid)
        } finally {
          snap.close()
        }
      })()

      console.log(`\nSync pair #${syncid}`)
      console.log(`  Local     ${shortenHome(plan.pair.localpath)}`)
      console.log(`  Remote    ${plan.pair.remotepath ?? REMOTE_NONE}\n`)

      if (plan.pair.issues.length === 0) {
        console.log(
          "This pair is healthy — pruning it would unlink a working sync.",
        )
        console.log("Remove it from pCloud Drive's preferences instead.\n")
        process.exit(1)
      }

      console.log("Rows to delete:")
      Object.entries(plan.counts).forEach(([table, n]) =>
        console.log(`  ${padEnd(table, 16)}${n}`),
      )
      console.log(`  ${padEnd("total", 16)}${plan.total}\n`)

      if (!options.apply) {
        console.log("This was a dry run. Re-run with --apply to perform it.\n")
        return
      }

      // The daemon keeps its own picture of the sync set in memory and writes it
      // back, so deleting underneath a running pCloud Drive either loses the edit
      // or corrupts the WAL. Both checks are kept: the process may have exited
      // while still holding the file, and the file may be held by something else.
      // The daemon guard applies to the database the daemon actually holds.
      // --db exists so this can be rehearsed against a copy, and refusing
      // there made the flag useless — a running pCloud Drive has no opinion
      // about a file in /tmp. The lock check still runs either way.
      const pruned = await withDaemonStopped(options.db, options.yes, () =>
        applyPrune(options.db, syncid),
      )
      if (!pruned) process.exit(1)

      ok(`Removed ${pruned.removed} rows for sync pair #${syncid}`)
      note(`Backup: ${shortenHome(pruned.backup)}`)
    } catch (error) {
      handleError(error)
    }
  })

sync
  .command("add")
  .description("Create a folder on both sides, ready to pair in pCloud Drive")
  .argument("<name>", "Folder name, created under the sync root on both sides")
  .option(
    "--root <path>",
    "Local sync root (else $PCLOUD_SYNC_ROOT, else inferred from existing pairs)",
  )
  .option("--apply", "Perform the change (default is a dry run)")
  .option("--db <path>", "Operate on a different database file", PCLOUD_DB)
  .action(async (name: string, options) => {
    try {
      const snap = snapshot(options.db)
      const { inferred, pairs } = (() => {
        try {
          return { inferred: syncRoot(snap.db), pairs: readPairs(snap.db) }
        } finally {
          snap.close()
        }
      })()

      // Four rungs, most specific first. Inference covers the Dropbox-shaped
      // setup where every pair sits under one folder; it abstains rather than
      // guesses when they disagree, because a scattered layout is a legitimate
      // way to use pCloud rather than a fault. --root and PCLOUD_SYNC_ROOT are
      // how that user says where theirs is, and ~/pCloud is the client's own
      // conventional name — a better default than refusing to act.
      const root =
        options.root ??
        process.env.PCLOUD_SYNC_ROOT ??
        inferred ??
        join(homedir(), "pCloud")

      if (!existsSync(root))
        throw new Error(
          `Sync root does not exist: ${shortenHome(root)}\n` +
            "  Pass --root <path>, or set PCLOUD_SYNC_ROOT.",
        )

      const localpath = join(root, name)
      const remotepath = `/${name}`

      // Cheap guards run before anything is created, so a dry run reports the
      // conflict rather than leaving two folders behind on the way to failing.
      if (pairs.some((pair) => pair.localpath === localpath))
        throw new Error(`Already a sync pair: ${shortenHome(localpath)}`)
      const nested = pairs.find(
        (pair) =>
          localpath.startsWith(`${pair.localpath}/`) ||
          pair.localpath.startsWith(`${localpath}/`),
      )
      if (nested)
        throw new Error(
          `Nested inside an existing pair (${shortenHome(nested.localpath)}) — pCloud syncs pairs independently and the overlap would upload twice`,
        )

      console.log(`\nNew synced folder`)
      console.log(`  Local     ${shortenHome(localpath)}`)
      console.log(`  Remote    ${remotepath}\n`)

      if (!options.apply) {
        console.log("Would create:")
        if (!existsSync(localpath))
          console.log(
            `  ${padEnd("local folder", 16)}${shortenHome(localpath)}`,
          )
        console.log(`  ${padEnd("remote folder", 16)}${remotepath}\n`)
        console.log("This was a dry run. Re-run with --apply to perform it.\n")
        return
      }

      const api = await getAuthenticatedAPI()
      const created = await api.createFolder(remotepath)
      assertSuccess(created.result, created.error)

      if (!existsSync(localpath)) mkdirSync(localpath, { recursive: true })

      ok(`${remotepath} and ${shortenHome(localpath)} are ready`)
      heading("Pair them in pCloud Drive")
      fields([
        { label: "Open", value: "pCloud Drive → Sync → Add new sync" },
        { label: "Local", value: shortenHome(localpath) },
        { label: "Remote", value: remotepath },
      ])
      note("Then `pcloud sync` will report the pair like any other.")
    } catch (error) {
      handleError(error)
    }
  })

sync
  .command("clear-tasks")
  .description("Clear queued operations that can never complete")
  .argument("<id>", "Sync pair id (from `pcloud sync`)")
  .option("--apply", "Perform the deletion (default is a dry run)")
  .option("--yes", "Do not ask before quitting pCloud Drive")
  .option("--db <path>", "Operate on a different database file", PCLOUD_DB)
  .action(async (id: string, options) => {
    try {
      const syncid = parseInt(id, 10)
      const snap = snapshot(options.db)
      const plan = (() => {
        try {
          return planClearTasks(snap.db, syncid)
        } finally {
          snap.close()
        }
      })()

      heading(`Sync pair #${syncid}`)
      fields([
        { label: "Local", value: shortenHome(plan.pair.localpath) },
        { label: "Remote", value: plan.pair.remotepath ?? REMOTE_NONE },
      ])

      if (plan.tasks.length === 0) {
        ok("Nothing queued without a destination — nothing to clear.")
        return
      }

      // Named individually rather than counted: these are real files, and
      // seeing which ones is what tells you whether the queue is stale or
      // whether pCloud is still genuinely trying to move something.
      heading(
        `${plan.tasks.length} queued operation${plan.tasks.length === 1 ? "" : "s"} with no destination`,
      )
      fields(
        plan.tasks.map((task) => ({
          label: String(task.name ?? "?"),
          value: `local id ${task.localitemid}`,
        })),
      )
      note("")
      note("Only these rows go — the sync pair, its index and your files stay.")
      note("`pcloud sync prune` is the one that unpairs the folder entirely.")

      if (!options.apply) {
        note("")
        warn("Dry run. Re-run with --apply to perform it.")
        return
      }

      // Same reasoning as prune: the daemon holds its queue in memory and
      // writes it back, so deleting underneath a running pCloud Drive either
      // loses the edit or corrupts the WAL.
      // The daemon guard applies to the database the daemon actually holds.
      // --db exists so this can be rehearsed against a copy, and refusing
      // there made the flag useless — a running pCloud Drive has no opinion
      // about a file in /tmp. The lock check still runs either way.
      const cleared = await withDaemonStopped(options.db, options.yes, () =>
        applyClearTasks(options.db, syncid),
      )
      if (!cleared) process.exit(1)

      ok(
        `Cleared ${cleared.removed} queued operation${cleared.removed === 1 ? "" : "s"}`,
      )
      note(`Backup: ${shortenHome(cleared.backup)}`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("download")
  .description("Download a file to the local filesystem")
  .argument("<path>", "Remote file path (e.g. /notes.md)")
  .argument("[dest]", "Local destination (defaults to the file's own name)")
  .action(async (path: string, dest: string | undefined) => {
    try {
      const api = await getAuthenticatedAPI()
      const stat = await api.stat(path)
      assertSuccess(stat.result, stat.error)

      const meta = stat.metadata as
        { fileid?: number; name?: string; isfolder?: boolean } | undefined
      if (!meta?.fileid || meta.isfolder) {
        console.error(`Error: not a file: ${path}`)
        process.exit(1)
      }

      const target = dest ?? meta.name ?? "download"
      // Refusing rather than overwriting: a download that silently replaced a
      // local file would be a poor trade for saving one flag.
      if (existsSync(target)) {
        console.error(`Error: ${target} already exists`)
        process.exit(1)
      }

      const data = await api.downloadFile(meta.fileid)
      writeFileSync(target, Buffer.from(data))
      ok(`${path} → ${target} (${formatBytes(data.byteLength)})`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("upload")
  .description("Upload a local file to a pCloud folder")
  .argument("<local>", "Local file to upload")
  .argument("<folder>", "Remote folder path (e.g. /Documents)")
  .action(async (local: string, folder: string) => {
    try {
      if (!existsSync(local)) {
        console.error(`Error: no such file: ${local}`)
        process.exit(1)
      }

      const api = await getAuthenticatedAPI()
      const stat = await api.stat(folder)
      const folderid = (stat.metadata as { folderid?: number } | undefined)
        ?.folderid
      if (stat.result !== 0 || folderid === undefined) {
        console.error(`Error: no such folder: ${folder}`)
        process.exit(1)
      }

      const contents = readFileSync(local)
      const name = basename(local)
      const response = await api.uploadFile(folderid, name, contents)
      assertSuccess(response.result, response.error)

      console.log(
        `✓ ${local} → ${folder}/${name} (${formatBytes(contents.byteLength)})`,
      )
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("doctor")
  .description(
    "Check which commands your credential can reach, and the local sync daemon",
  )
  .option("--db <path>", "Read a different local database", PCLOUD_DB)
  .option("--verbose", "List every endpoint, not just the ones with a problem")
  .action(async (options) => {
    try {
      const stored = tokenStore.load()
      const envAuth = process.env.PCLOUD_AUTH
      const envToken = process.env.PCLOUD_ACCESS_TOKEN
      const sessionToken = envAuth ?? stored?.auth
      const accessToken = envToken ?? stored?.access_token
      const auth: Record<string, string> | null = sessionToken
        ? { auth: sessionToken }
        : accessToken
          ? { access_token: accessToken }
          : null

      // The local half of doctor needs no credential, and a broken sync pair is
      // exactly the kind of fault someone hits before getting round to logging
      // in — so it still runs, and only the remote half is given up on.
      if (!auth) {
        const daemon = describeDaemon(options.db)
        renderDoctor({
          faults: [
            {
              area: "Credential",
              detail: "not authenticated",
              fix: "pcloud login",
            },
            ...localProblems(options.db).map((fault) => ({
              area: "Sync",
              detail: fault.detail,
              fix: fault.fix,
            })),
          ],
          summary: [{ label: "Sync", value: daemon.summary }],
          sections: [daemon.section],
        })
        process.exit(1)
      }

      const tier = "auth" in auth ? "session token" : "OAuth access token"
      const api = await getAuthenticatedAPI()
      const results = await checkAll(api, auth)

      const blocked = results.filter((r) => r.health === "needs-session")
      const denied = results.filter((r) => r.health === "no-permission")
      // Rewind's absence is permanent, documented and already worked around,
      // so it is reported without being counted as a fault.
      const missing = results.filter(
        (r) => r.health === "missing" && !r.expected,
      )
      const absent = results.filter((r) => r.health === "missing" && r.expected)
      const reachable = results.filter((r) => r.health === "ok")

      const localFaults = localProblems(options.db)

      // The verdict leads. Reading thirty green ticks to discover one stuck
      // sync pair at the bottom is the wrong way round: what is wrong should be
      // the first thing on screen, and everything below it is evidence.
      const faults = [
        ...localFaults.map((fault) => ({
          area: "Sync",
          detail: fault.detail,
          fix: fault.fix,
        })),
        ...(blocked.length
          ? [
              {
                area: "Credential",
                detail: `${blocked.length} endpoint(s) need a session token`,
                fix: "pcloud login --session",
              },
            ]
          : []),
        ...(denied.length
          ? [
              {
                area: "Account",
                detail: `${denied.length} endpoint(s) your plan does not allow`,
                fix: undefined,
              },
            ]
          : []),
        ...(missing.length
          ? [
              {
                area: "API",
                detail: `${missing.length} endpoint(s) unexpectedly absent`,
                fix: undefined,
              },
            ]
          : []),
      ]

      const daemon = describeDaemon(options.db)

      // Detail below the verdict, and only what is worth reading — the passing
      // endpoints are a count unless you ask for them by name.
      const shown = options.verbose
        ? results
        : [...blocked, ...denied, ...missing]

      renderDoctor({
        faults,
        summary: [
          {
            label: "Credential",
            value: `${tier}${
              stored?.expiresAt
                ? ` · ${Math.round((stored.expiresAt - Date.now()) / 86_400_000)} days left`
                : ""
            }`,
          },
          {
            label: "API",
            value: `${reachable.length} of ${results.length} endpoints reachable`,
          },
          { label: "Sync", value: daemon.summary },
        ],
        sections: [
          daemon.section,
          {
            title: "API",
            lines: shown.map((r) => ({
              glyph:
                r.health === "ok"
                  ? ("ok" as const)
                  : r.health === "missing"
                    ? ("bad" as const)
                    : ("warn" as const),
              label: r.command,
              detail: r.detail,
            })),
          },
          {
            title: "Not offered by pCloud",
            lines: absent.map((r) => ({
              glyph: "note" as const,
              label: r.command,
            })),
            footnote: "Expected — `pcloud rewind` reconstructs it instead.",
          },
        ],
      })

      if (!options.verbose && !faults.length)
        console.log("  --verbose lists every endpoint checked.\n")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("browse")
  .description("Interactive file browser")
  .option(
    "--screen <name>",
    devMode ? `${screenHelp}, or "list" to print them` : screenHelp,
  )
  .option("--mock", "Explore sample data, without an account")
  .action(async () => {
    // Checked here rather than left to the browser component: that check runs
    // inside the render, by which point the alternate screen is up, so its error
    // is written to a buffer torn down microseconds later and the command appears
    // to exit silently. The message only survives if it precedes the switch.
    requireStoredAuth()
    const { startBrowse } = await import("./browse.js")
    await startBrowse(false, screen)
  })

// pCloud's client settings live in this machine's own database rather than in
// the account, so they are the one part of a pCloud setup that config
// management has to reach into. Owning that here — beside `pcloud sync`, which
// already reads the same file — keeps the format in one place rather than
// reimplemented in whatever shell script needs it.
const settings = program
  .command("settings")
  .description("Show pCloud Drive's local client settings")
  .action(() => {
    try {
      const values = readSettings()
      // A raw dump reads as noise: "minlocalfreespace 2147000000" and
      // "enableddrive 1" are the same shape on screen and nothing alike in
      // meaning. Each key gets the rendering its unit deserves.
      const humanise = (key: string): string => {
        const raw = values[key]
        if (raw === undefined) return "-"
        if (key === "ignorepatterns" || key === "ignorepaths") {
          const entries = parseList(raw)
          return `${entries.length} · ${entries.slice(0, 3).join(", ")}${entries.length > 3 ? " …" : ""}`
        }
        if (key === "minlocalfreespace") return formatBytes(Number(raw))
        if (key === "autostartfs" || key === "enableddrive")
          return raw === "1" ? "on" : "off"
        return raw
      }
      const LABELS: Record<string, string> = {
        ignorepatterns: "Ignored names",
        ignorepaths: "Ignored paths",
        language: "Language",
        minlocalfreespace: "Min free space",
        autostartfs: "Start at login",
        enableddrive: "Drive mounted",
      }
      const rows = READABLE_SETTINGS.map((key) => ({
        setting: LABELS[key] ?? key,
        value: humanise(key),
      }))
      renderTable(rows, [
        { key: "setting", header: "Setting", width: 18 },
        { key: "value", header: "Value", width: 52 },
      ])
      console.log("\n  pcloud settings ignore            list the ignore rules")
      console.log("  pcloud settings ignore add <p...> add patterns\n")
    } catch (error) {
      handleError(error)
    }
  })

const ignoreKey = (paths: boolean): "ignorepaths" | "ignorepatterns" =>
  paths ? "ignorepaths" : "ignorepatterns"

const showIgnore = (paths: boolean): void => {
  const key = ignoreKey(paths)
  const entries = parseList(readSettings()[key])
  if (entries.length === 0) {
    console.log(`No ${key} configured`)
    return
  }
  renderTable(
    entries.map((pattern) => ({ pattern })),
    [
      {
        key: "pattern",
        header: key === "ignorepaths" ? "Path" : "Pattern",
        width: 40,
      },
    ],
  )
  console.log(`\n${entries.length} entries\n`)
}

// add / remove / set rather than a single --edit: config management wants `set`
// to be declarative and idempotent, while a person at a terminal wants to nudge
// one entry without restating the list.
const applyIgnore = (
  next: string[],
  paths: boolean,
  options: { force?: boolean; apply?: boolean; db?: string },
): void => {
  const key = ignoreKey(paths)
  const dbPath = options.db ?? PCLOUD_DB
  const current = parseList(readSettings(dbPath)[key])

  if (sameSet(current, next)) {
    ok(`${key} already matches — nothing to do`)
    return
  }

  const added = next.filter(
    (entry) => !current.some((c) => c.toLowerCase() === entry.toLowerCase()),
  )
  const removed = current.filter(
    (entry) => !next.some((n) => n.toLowerCase() === entry.toLowerCase()),
  )
  console.log(`${key}:`)
  added.forEach((entry) => console.log(`  + ${entry}`))
  removed.forEach((entry) => console.log(`  - ${entry}`))

  if (!options.apply) {
    console.log(`\nDry run. Re-run with --apply to write.\n`)
    return
  }

  // Refuse before writing rather than after: announcing a change and then
  // failing reads as a partial write.
  assertWritable({ force: options.force })

  const { backup } = writeSettings(
    { [key]: formatList(next) },
    dbPath,
    new Date(),
    {
      force: options.force,
    },
  )
  console.log(`\n✓ ${key} updated. Previous database: ${backup}\n`)
}

const ignore = settings
  .command("ignore")
  .description("Show the names and paths pCloud Drive refuses to sync")
  .option("--paths", "Operate on ignorepaths rather than ignorepatterns")
  .action((options) => {
    try {
      showIgnore(options.paths === true)
    } catch (error) {
      handleError(error)
    }
  })

// --apply, matching `pcloud sync prune`: this rewrites what pCloud will and
// will not synchronise, and the first version shipped without it overwrote a
// live ignore list within minutes. Destructive commands in this CLI are dry by
// default. --db exists for the same reason prune has it — so the write path is
// testable against a copy rather than only against the real thing.
ignore.enablePositionalOptions()

const ignoreWriteOptions = <T extends Command>(command: T): T =>
  command
    .option("--paths", "Operate on ignorepaths rather than ignorepatterns")
    .option("--apply", "Perform the write (default is a dry run)")
    .option("--db <path>", "Operate on a different database file", PCLOUD_DB)
    .option(
      "--force",
      "Write even though pCloud Drive is running (it will overwrite this on quit)",
    ) as T

ignoreWriteOptions(
  ignore
    .command("add")
    .description("Add patterns, leaving the rest of the list alone")
    .argument("<patterns...>", "Patterns to add"),
).action((patterns: string[], options) => {
  try {
    const paths = options.paths === true
    const current = parseList(readSettings(options.db)[ignoreKey(paths)])
    const next = [
      ...current,
      ...patterns.filter(
        (p) => !current.some((c) => c.toLowerCase() === p.toLowerCase()),
      ),
    ]
    applyIgnore(next, paths, options)
  } catch (error) {
    handleError(error)
  }
})

ignoreWriteOptions(
  ignore
    .command("remove")
    .description("Remove patterns, leaving the rest of the list alone")
    .argument("<patterns...>", "Patterns to remove"),
).action((patterns: string[], options) => {
  try {
    const paths = options.paths === true
    const drop = new Set(patterns.map((p) => p.toLowerCase()))
    const next = parseList(readSettings(options.db)[ignoreKey(paths)]).filter(
      (entry) => !drop.has(entry.toLowerCase()),
    )
    applyIgnore(next, paths, options)
  } catch (error) {
    handleError(error)
  }
})

ignoreWriteOptions(
  ignore
    .command("set")
    .description("Replace the whole list — declarative, for config management")
    .argument("<patterns...>", "The complete list of patterns"),
).action((patterns: string[], options) => {
  try {
    applyIgnore(patterns, options.paths === true, options)
  } catch (error) {
    handleError(error)
  }
})

// Bare `pcloud` opens the browser, the way k9s, lazygit and btop do: once a
// tool has a full interface, that interface is the tool and needs no verb.
// `--help` and every subcommand are untouched, so nothing scripted changes —
// only the case that previously printed usage and did nothing useful.
// --mock drives the whole interface from fixtures: an invented account, with
// invented sync pairs and settings. It exists so a screenshot never has to show
// a real drive — a folder listing says more about someone than they usually
// intend, and every screenshot of this tool so far has been of somebody's
// actual files.
//
// Checked here rather than declared as a commander option because it applies
// to the bare invocation, which commander never sees.
const mock = process.argv.includes("--mock")

// Read from argv rather than declared as a commander option, for the same
// reason --mock is: an option declared on `browse` is invisible to the bare
// invocation, which is the form both of these are most used in.
const screenIndex = process.argv.indexOf("--screen")
const screen = resolveScreen(
  screenIndex === -1 ? undefined : process.argv[screenIndex + 1],
)

// --screen takes a value, so both the flag and the name that follows it have to
// be discounted before what is left can be called bare. Counting only the flag
// would send `pcloud --screen sync` down the subcommand path, where commander
// would reject "sync" as an unknown command.
const invokedBare =
  process.argv.filter(
    (arg, i) =>
      arg !== "--mock" &&
      arg !== "--screen" &&
      process.argv[i - 1] !== "--screen",
  ).length <= 2

if (invokedBare) {
  // No credential needed in mock mode — that is most of the point.
  if (!mock) requireStoredAuth()
  const { startBrowse } = await import("./browse.js")
  await startBrowse(mock, screen)
} else {
  program.parse()
}
