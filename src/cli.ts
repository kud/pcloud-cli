#!/usr/bin/env node
import { Command } from "commander"
import dotenv from "dotenv"
import { PCloudAPI } from "./api.js"
import {
  PCloudFolderItem,
  PCloudPublink,
  PCloudRevision,
  PCloudShareItem,
  PCloudTrashItem,
} from "./types.js"
import { TokenStore } from "./token-store.js"
import { OAuthFlow } from "./oauth.js"

dotenv.config({ quiet: true })

const program = new Command()
const tokenStore = new TokenStore()

const region = (process.env.PCLOUD_REGION ?? "eu").toLowerCase()
const authBaseUrl = "https://my.pcloud.com"
const defaultApiServer =
  region === "us" ? "https://api.pcloud.com" : "https://eapi.pcloud.com"

program
  .name("pcloud-cli")
  .description("CLI tool for pCloud file operations")
  .version("1.0.0")

const getAuthenticatedAPI = async (): Promise<PCloudAPI> => {
  const accessToken = process.env.PCLOUD_ACCESS_TOKEN
  if (accessToken) {
    const api = new PCloudAPI()
    api.setAccessToken(accessToken)
    return api
  }

  const tokens = tokenStore.load()
  if (tokens) {
    const apiServer = tokens.hostname
      ? `https://${tokens.hostname}`
      : defaultApiServer
    const api = new PCloudAPI(apiServer)
    api.setAccessToken(tokens.access_token, apiServer)
    return api
  }

  console.error("\n❌ Not authenticated!\n")
  console.error("It looks like you haven't set up pCloud CLI yet.\n")
  console.error("Please run this command first:\n")
  console.error("  pcloud login\n")
  console.error("This is a one-time setup that takes less than a minute.\n")
  process.exit(1)
}

const handleError = (error: unknown): never => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

const assertSuccess = (result: number, error?: string): void => {
  if (result !== 0) {
    console.error(`Error: ${error || "Unknown error"}`)
    process.exit(1)
  }
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

program
  .command("login")
  .description("Set up authentication with pCloud")
  .action(async () => {
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
      console.log("Try: npm start list-trash\n")
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
  .description("Remove stored credentials")
  .action(() => {
    if (tokenStore.exists()) {
      tokenStore.delete()
      console.log("✓ Logged out successfully")
    } else {
      console.log("No stored credentials found")
    }
  })

program
  .command("whoami")
  .description("Show account information")
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.userInfo()
      assertSuccess(response.result, response.error)
      const usedPct = ((response.usedquota / response.quota) * 100).toFixed(1)
      console.log(`Email:  ${response.email}`)
      console.log(`Plan:   ${response.plan}`)
      console.log(
        `Quota:  ${formatBytes(response.usedquota)} / ${formatBytes(response.quota)} (${usedPct}% used)`,
      )
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

      const items = response.metadata?.contents ?? []

      if (items.length === 0) {
        console.log("Empty folder")
        return
      }

      const typeCol = 6
      const nameCol = 40
      const sizeCol = 12

      console.log(
        `${padEnd("Type", typeCol)}${padEnd("Name", nameCol)}${padEnd("Size", sizeCol)}Modified`,
      )
      console.log("-".repeat(typeCol + nameCol + sizeCol + 20))

      items.forEach((item: PCloudFolderItem) => {
        const type = item.isfolder ? "dir" : "file"
        const size = item.isfolder ? "-" : formatBytes(item.size ?? 0)
        const modified = item.modified ?? "-"
        console.log(
          `${padEnd(type, typeCol)}${padEnd(item.name, nameCol)}${padEnd(size, sizeCol)}${modified}`,
        )
      })
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

program
  .command("list-trash")
  .description("List files in trash")
  .action(async () => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listTrash()
      assertSuccess(response.result, response.error)

      if (!response.contents || response.contents.length === 0) {
        console.log("Trash is empty")
        return
      }

      console.log("\nFiles in trash:")
      console.log("================")
      response.contents.forEach((item: PCloudTrashItem) => {
        const date = new Date(item.deletetime * 1000).toLocaleString()
        console.log(`\nFile ID: ${item.fileid}`)
        console.log(`Name: ${item.name}`)
        console.log(`Path: ${item.path}`)
        console.log(`Deleted: ${date}`)
        if (item.size) console.log(`Size: ${formatBytes(item.size)}`)
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("restore-trash")
  .description("Restore a file from trash")
  .argument("<fileid>", "File ID to restore")
  .action(async (fileid: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.restoreFromTrash(parseInt(fileid, 10))
      assertSuccess(response.result, response.error)
      console.log(`✓ Successfully restored file ${fileid}`)
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("list-rewind")
  .description("List rewind events for a path")
  .argument("<path>", "Path to check (e.g., /myfile.txt)")
  .action(async (path: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.listRewindFiles(path)
      assertSuccess(response.result, response.error)

      if (!response.contents || response.contents.length === 0) {
        console.log("No rewind events found")
        return
      }

      console.log(`\nRewind events for ${path}:`)
      console.log("================")
      response.contents.forEach((item: any) => {
        const date = new Date(item.time * 1000).toLocaleString()
        console.log(`\nFile ID: ${item.fileid}`)
        console.log(`Name: ${item.name}`)
        console.log(`Time: ${date}`)
      })
    } catch (error) {
      handleError(error)
    }
  })

program
  .command("restore-rewind")
  .description("Restore a file from rewind")
  .argument("<fileid>", "File ID to restore")
  .argument("<topath>", "Destination path (e.g., /restored-file.txt)")
  .action(async (fileid: string, topath: string) => {
    try {
      const api = await getAuthenticatedAPI()
      const response = await api.restoreFromRewind(parseInt(fileid, 10), topath)
      assertSuccess(response.result, response.error)
      console.log(`✓ Successfully restored file ${fileid} to ${topath}`)
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
