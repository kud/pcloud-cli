#!/usr/bin/env node
import { readFileSync } from "fs"
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
} from "@kud/pcloud"
import { renderAccount, renderChanges, renderFileList } from "./render.js"
import { planRewind, applyRewind } from "./rewind.js"

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

const getAuthenticatedAPI = async (): Promise<PCloudAPI> => {
  try {
    return await resolveAuth({ defaultApiServer })
  } catch {
    console.error("\n❌ Not authenticated!\n")
    console.error("It looks like you haven't set up pCloud CLI yet.\n")
    console.error("Please run this command first:\n")
    console.error("  pcloud login\n")
    console.error("This is a one-time setup that takes less than a minute.\n")
    process.exit(1)
  }
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
    "--session",
    "Log in with email and password for a session token (unlocks revisions, trash, zip, downloads)",
  )
  .action(async (options) => {
    if (options.session) {
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
      console.log("\n🔐 Welcome to pCloud CLI Setup!\n")
      console.log("You will be redirected to pCloud in your browser to log in.")
      console.log(
        "After logging in, you'll be redirected back automatically.\n",
      )

      const clientId = process.env.PCLOUD_CLIENT_ID
      const clientSecret = process.env.PCLOUD_CLIENT_SECRET

      if (!clientId || !clientSecret) {
        console.error(
          "\n❌ Missing credentials. Export PCLOUD_CLIENT_ID and PCLOUD_CLIENT_SECRET in your shell or .env file.\n",
        )
        process.exit(1)
      }

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

      const idCol = 12
      const nameCol = 40
      const sizeCol = 12

      console.log(
        `${padEnd("File ID", idCol)}${padEnd("Name", nameCol)}${padEnd("Size", sizeCol)}Deleted`,
      )
      console.log("-".repeat(idCol + nameCol + sizeCol + 20))

      items.forEach((item: any) => {
        const deleted = item.deletetime
          ? new Date(item.deletetime * 1000)
              .toISOString()
              .slice(0, 16)
              .replace("T", " ")
          : "-"
        console.log(
          `${padEnd(String(item.fileid ?? "-"), idCol)}${padEnd(item.name ?? "-", nameCol)}${padEnd(formatBytes(item.size ?? 0), sizeCol)}${deleted}`,
        )
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("restore-trash")
  .description(
    "Restore a file from trash by file ID (⚠ requires session auth — limited with OAuth)",
  )
  .argument("<fileid>", "File ID to restore")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.restoreFromTrash(parseInt(fileid, 10))
      if (response.result === 1000) {
        console.error(TRASH_OAUTH_WARNING)
        process.exit(1)
      }
      assertSuccess(response.result, response.error)
      console.log(`✓ File ${fileid} restored successfully.`)
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

program
  .command("browse")
  .description("Interactive file browser")
  .action(async () => {
    const { startBrowse } = await import("./browse.js")
    await startBrowse()
  })

program.parse()
