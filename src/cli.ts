#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { basename } from "path"
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
  TokenStore,
  OAuthFlow,
  sessionLogin,
  resolveAuth,
  resolveStoredAuth,
} from "@kud/pcloud"
import { renderAccount, renderChanges, renderFileList } from "./render.js"
import { planRewind, applyRewind } from "./rewind.js"
import { pathResolver } from "./lib/paths.js"
import { checkAll } from "./lib/health.js"
import {
  PCLOUD_DB,
  applyPrune,
  daemonRunning,
  databaseLocked,
  planPrune,
  readPairs,
  snapshot,
  strandedTasks,
  tableCounts,
  unlistedTables,
  verdicts,
  type SyncPair,
} from "./lib/sync.js"

dotenv.config({ quiet: true })

const program = new Command()
const tokenStore = new TokenStore()

const region = (process.env.PCLOUD_REGION ?? "eu").toLowerCase()
const authBaseUrl = "https://my.pcloud.com"
const defaultApiServer =
  region === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com"

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }

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
    console.log("✓ Local credentials removed")
  })

program
  .command("whoami")
  .description("Show account information")
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.userInfo()
      assertSuccess(response.result, response.error)
      renderAccount(response)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("ls")
  .description("List folder contents")
  .argument("[path]", "Folder path", "/")
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listFolder(path)
      assertSuccess(response.result, response.error)

      renderFileList(response.metadata?.contents ?? [])
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("stat")
  .description("Show file or folder metadata")
  .argument("<path>", "File or folder path")
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.stat(path)
      assertSuccess(response.result, response.error)
      console.log(JSON.stringify(response.metadata, null, 2))
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("mkdir")
  .description("Create a folder (no-op if it already exists)")
  .argument("<path>", "Folder path to create")
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.createFolder(path)
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("rmdir")
  .description("Recursively delete a folder and all its contents")
  .argument("<folderid>", "Folder ID to delete")
  .action(async (folderid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deleteFolder(parseInt(folderid, 10))
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("copy-file")
  .description("Copy a file to a new path")
  .argument("<fileid>", "File ID to copy")
  .argument("<topath>", "Destination path")
  .action(async (fileid: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.copyFile(parseInt(fileid, 10), topath)
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("move-file")
  .description("Move a file to a new path")
  .argument("<fileid>", "File ID to move")
  .argument("<topath>", "Destination path")
  .action(async (fileid: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.moveFile(parseInt(fileid, 10), topath)
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("rename-file")
  .description("Rename a file")
  .argument("<fileid>", "File ID to rename")
  .argument("<toname>", "New file name")
  .action(async (fileid: string, toname: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.renameFile(parseInt(fileid, 10), toname)
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("delete-file")
  .description("Permanently delete a file")
  .argument("<fileid>", "File ID to delete")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deleteFile(parseInt(fileid, 10))
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("get-link")
  .description("Get a download URL for a file")
  .argument("<fileid>", "File ID")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.getFileLink(parseInt(fileid, 10))
      assertSuccess(response.result, response.error)
      console.log(`https://${response.hosts[0]}${response.path}`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("checksum")
  .description("Print SHA256, SHA1 and MD5 checksums for a file")
  .argument("<fileid>", "File ID")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.checksumFile(parseInt(fileid, 10))
      assertSuccess(response.result, response.error)
      console.log(`SHA256  ${response.sha256}`)
      console.log(`SHA1    ${response.sha1}`)
      console.log(`MD5     ${response.md5}`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("list-revisions")
  .description("List revisions for a file")
  .argument("<fileid>", "File ID")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listRevisions(parseInt(fileid, 10))
      assertSuccess(response.result, response.error)

      if (!response.revisions || response.revisions.length === 0) {
        console.log("No revisions found")
        return
      }

      const idCol = 14
      const sizeCol = 14

      console.log(
        `${padEnd("Revision ID", idCol)}${padEnd("Size", sizeCol)}Modified`,
      )
      console.log("-".repeat(idCol + sizeCol + 20))

      response.revisions.forEach((rev: PCloudRevision) => {
        console.log(
          `${padEnd(String(rev.revisionid), idCol)}${padEnd(formatBytes(rev.size), sizeCol)}${rev.modified ?? "-"}`,
        )
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("revert-revision")
  .description("Revert a file to a previous revision")
  .argument("<fileid>", "File ID")
  .argument("<revisionid>", "Revision ID to revert to")
  .action(async (fileid: string, revisionid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.revertRevision(
        parseInt(fileid, 10),
        parseInt(revisionid, 10),
      )
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("list-shares")
  .description("List all active folder shares")
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listShares()
      assertSuccess(response.result, response.error)

      if (!response.shares || response.shares.length === 0) {
        console.log("No shares found")
        return
      }

      const idCol = 16
      const folderCol = 30
      const mailCol = 30

      console.log(
        `${padEnd("Request ID", idCol)}${padEnd("Folder", folderCol)}${padEnd("Recipient", mailCol)}Permissions`,
      )
      console.log("-".repeat(idCol + folderCol + mailCol + 12))

      response.shares.forEach((share: PCloudShareItem) => {
        console.log(
          `${padEnd(String(share.sharerequestid ?? "-"), idCol)}${padEnd(share.foldername ?? String(share.folderid), folderCol)}${padEnd(share.mail ?? "-", mailCol)}${share.permissions ?? "-"}`,
        )
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("share-folder")
  .description(
    "Share a folder with another pCloud user (permissions: 1=Create, 2=Modify, 4=Delete)",
  )
  .argument("<folderid>", "Folder ID to share")
  .argument("<email>", "Recipient email address")
  .argument(
    "<permissions>",
    "Permission bitmask (1=Create, 2=Modify, 4=Delete)",
  )
  .action(async (folderid: string, email: string, permissions: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.shareFolder(
        parseInt(folderid, 10),
        email,
        parseInt(permissions, 10),
      )
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
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
      console.log("✓ Done")
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
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("remove-share")
  .description("Remove an active share")
  .argument("<sharerequestid>", "Share request ID")
  .action(async (sharerequestid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.removeShare(parseInt(sharerequestid, 10))
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("publink-file")
  .description("Create a public download link for a file")
  .argument("<fileid>", "File ID")
  .option("--expire <date>", "Expiry datetime (YYYY-MM-DD HH:MM:SS)")
  .option("--max-downloads <n>", "Maximum number of downloads")
  .action(
    async (
      fileid: string,
      options: { expire?: string; maxDownloads?: string },
    ) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getFilePublink(
          parseInt(fileid, 10),
          options.expire,
          options.maxDownloads !== undefined
            ? parseInt(options.maxDownloads, 10)
            : undefined,
        )
        assertSuccess(response.result, response.error)
        console.log(response.link)
      } catch (error) {
        handleError(error)
      }
    },
  )

program
  .command("publink-folder")
  .description("Create a public link for a folder")
  .argument("<folderid>", "Folder ID")
  .option("--expire <date>", "Expiry datetime (YYYY-MM-DD HH:MM:SS)")
  .action(async (folderid: string, options: { expire?: string }) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.getFolderPublink(
        parseInt(folderid, 10),
        options.expire,
      )
      assertSuccess(response.result, response.error)
      console.log(response.link)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("list-publinks")
  .description("List all active public links")
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listPublinks()
      assertSuccess(response.result, response.error)

      if (!response.publinks || response.publinks.length === 0) {
        console.log("No public links found")
        return
      }

      const codeCol = 20
      const nameCol = 36
      const dlCol = 12

      console.log(
        `${padEnd("Code", codeCol)}${padEnd("Name", nameCol)}${padEnd("Downloads", dlCol)}Expires`,
      )
      console.log("-".repeat(codeCol + nameCol + dlCol + 20))

      response.publinks.forEach((link: PCloudPublink) => {
        const downloads =
          link.maxdownloads !== undefined
            ? `${link.downloads ?? 0}/${link.maxdownloads}`
            : String(link.downloads ?? 0)
        console.log(
          `${padEnd(link.code, codeCol)}${padEnd(link.name ?? "-", nameCol)}${padEnd(downloads, dlCol)}${link.expire ?? "-"}`,
        )
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("delete-publink")
  .description("Delete a public link by its code")
  .argument("<code>", "Public link code")
  .action(async (code: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.deletePublink(code)
      assertSuccess(response.result, response.error)
      console.log("✓ Done")
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("zip")
  .description("Get a download URL for a ZIP archive of files and/or folders")
  .argument("<fileid...>", "File IDs to include in the ZIP")
  .option("--folderid <id...>", "Folder IDs to include in the ZIP")
  .option("--filename <name>", "Name for the ZIP file")
  .action(
    async (
      fileids: string[],
      options: { folderid?: string[]; filename?: string },
    ) => {
      try {
        const api = await getAuthenticatedAPI()
        const response = await api.getZipLink(
          fileids.map((id) => parseInt(id, 10)),
          options.folderid?.map((id) => parseInt(id, 10)),
          options.filename,
        )
        assertSuccess(response.result, response.error)
        console.log(`https://${response.hosts[0]}${response.path}`)
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
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listTrash()
      if (response.result === 1000) {
        console.error(TRASH_OAUTH_WARNING)
        process.exit(1)
      }
      assertSuccess(response.result, response.error)

      const items = (response.contents ?? []) as any[]
      if (items.length === 0) {
        console.log("Trash is empty")
        return
      }

      const idCol = 14
      const nameCol = 44

      // Printing fileid alone left every folder showing "-", and trash is
      // mostly folders — so the id needed to restore something was exactly the
      // one the listing would not show.
      console.log(
        `${padEnd("Kind", 6)}${padEnd("ID", idCol)}${padEnd("Name", nameCol)}${padEnd("Size", 12)}Deleted`,
      )
      console.log("-".repeat(6 + idCol + nameCol + 12 + 20))

      items.forEach((item: any) => {
        const isFolder = item.folderid !== undefined
        const deleted = item.deletetime
          ? new Date(item.deletetime * 1000)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")
          : "-"
        console.log(
          [
            padEnd(isFolder ? "dir" : "file", 6),
            padEnd(String(item.folderid ?? item.fileid ?? "-"), idCol),
            padEnd(item.name ?? "-", nameCol),
            padEnd(isFolder ? "-" : formatBytes(item.size ?? 0), 12),
            deleted,
          ].join(""),
        )
      })

      console.log(`\n${items.length} items. Restore with:\n`)
      console.log("  pcloud restore-trash <ID> [--to /somewhere]\n")
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
        .forEach((o) => console.log(`✓ ${o.action.path} — ${o.detail}`))
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

const reportLocalDaemon = (dbPath: string): void => {
  console.log("\nLocal daemon")

  if (!existsSync(dbPath)) {
    console.log("  no database found — pCloud Drive is not installed here\n")
    return
  }

  const snap = snapshot(dbPath)
  try {
    const pairs = readPairs(snap.db)
    const problems = verdicts(pairs)

    console.log(
      `  ${pairs.length} sync pair(s) · pCloud Drive ${daemonRunning() ? "running" : "not running"}`,
    )
    if (problems.length === 0) {
      console.log("✓ no local sync faults\n")
      return
    }

    problems.forEach((verdict) =>
      console.log(
        `${CRITICAL.has(verdict.kind) ? "🔥" : "🌶️"} ${verdict.count} ${verdict.detail}`,
      ),
    )
    console.log("\n  Detail: pcloud sync\n")
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
  .option("--db <path>", "Operate on a different database file", PCLOUD_DB)
  .action((id: string, options) => {
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
      if (daemonRunning() || databaseLocked(options.db)) {
        console.error("Error: pCloud Drive is running and holds this database.")
        console.error("Quit pCloud Drive, then run this again.\n")
        process.exit(1)
      }

      const { backup, removed } = applyPrune(options.db, syncid)
      console.log(`✓ Removed ${removed} rows for sync pair #${syncid}`)
      console.log(`  Backup: ${shortenHome(backup)}`)
      console.log("  Start pCloud Drive again to confirm the error is gone.\n")
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
      console.log(`✓ ${path} → ${target} (${formatBytes(data.byteLength)})`)
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
        console.error("Not authenticated. Run `pcloud login` first.")
        reportLocalDaemon(options.db)
        process.exit(1)
      }

      const tier = "auth" in auth ? "session token" : "OAuth access token"
      console.log(`\nCredential: ${tier}`)
      if (stored?.expiresAt) {
        const left = Math.round(
          (stored.expiresAt - Date.now()) / (24 * 60 * 60 * 1000),
        )
        console.log(
          `Expires:    ${new Date(stored.expiresAt).toLocaleString()} (${left} days)`,
        )
      }
      console.log()

      const api = await getAuthenticatedAPI()
      const results = await checkAll(api, auth)

      const width = Math.max(...results.map((r) => r.command.length))
      results.forEach((r) =>
        console.log(
          `${HEALTH_GLYPH[r.health]} ${padEnd(r.command, width + 2)}${r.detail}`,
        ),
      )

      const blocked = results.filter((r) => r.health === "needs-session")
      const missing = results.filter((r) => r.health === "missing")

      if (blocked.length) {
        console.log(
          `\n${blocked.length} command(s) need a session token — run:\n\n  pcloud login --session\n`,
        )
      }
      if (missing.length) {
        console.log(
          `${missing.length} command(s) call endpoints pCloud does not expose.\nFor Rewind, use \`pcloud rewind\` instead.\n`,
        )
      }
      if (!blocked.length && !missing.length)
        console.log("\nAll endpoints reachable.")

      reportLocalDaemon(options.db)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("browse")
  .description("Interactive file browser")
  .action(async () => {
    // Checked here rather than left to the browser component: that check runs
    // inside the render, by which point the alternate screen is up, so its error
    // is written to a buffer torn down microseconds later and the command appears
    // to exit silently. The message only survives if it precedes the switch.
    requireStoredAuth()
    const { startBrowse } = await import("./browse.js")
    await startBrowse()
  })

program.parse()
