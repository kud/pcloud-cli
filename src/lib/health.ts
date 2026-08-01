import type { PCloudAPI } from "@kud/pcloud"

// Probing without required arguments is what makes reachability decidable
// without performing anything: a method that exists gets far enough to complain
// about a missing argument, one that does not 404s at the router first. So the
// error distinguishes "wrong call" from "no such thing", and nothing mutates.

export type Health = "ok" | "needs-session" | "no-permission" | "missing"

export type CommandHealth = {
  command: string
  method: string
  health: Health
  detail: string
  /**
   * True when pCloud is known never to have exposed this endpoint. Rewind is
   * the only one: it is a web-app feature with no public API, `pcloud rewind`
   * already reconstructs it from diff and revisions, and flagging it as a
   * fault on every run is crying wolf — which teaches you to ignore the glyph
   * that matters.
   */
  expected?: boolean
}

const KNOWN_ABSENT = new Set(["listrewindevents"])

const SURFACE: [command: string, method: string][] = [
  ["whoami", "userinfo"],
  ["ls / browse", "listfolder"],
  ["stat", "stat"],
  ["changes / rewind", "diff"],
  ["mkdir", "createfolderifnotexists"],
  ["rmdir", "deletefolderrecursive"],
  ["copy-file", "copyfile"],
  ["move-file / rename-file", "renamefile"],
  ["delete-file", "deletefile"],
  ["get-link", "getfilelink"],
  ["checksum", "checksumfile"],
  ["list-revisions", "listrevisions"],
  ["revert-revision", "revertrevision"],
  ["list-trash / restore-trash", "trash_list"],
  ["zip", "getziplink"],
  ["list-shares", "listshares"],
  ["share-folder", "sharefolder"],
  ["publink-file", "getfilepublink"],
  ["publink-folder", "getfolderpublink"],
  ["list-publinks", "listpublinks"],
  ["delete-publink", "deletepublink"],
  ["list-rewind / restore-rewind", "listrewindevents"],
]

const classify = (result: number): Health => {
  if (result === 0) return "ok"
  if (result === 1000) return "needs-session"
  if (result === 2076) return "no-permission"
  return "ok"
}

export const checkCommand = async (
  api: PCloudAPI,
  auth: Record<string, string>,
  command: string,
  method: string,
): Promise<CommandHealth> => {
  try {
    const res = await api.request<{ result: number; error?: string }>(
      method,
      auth,
    )
    const health = classify(res.result)
    return {
      command,
      method,
      health,
      detail:
        health === "ok" ? "reachable" : (res.error ?? `result ${res.result}`),
    }
  } catch (error) {
    // request() rejects on a non-JSON body, which is what a 404 page is.
    const message = error instanceof Error ? error.message : String(error)
    return message.includes("404")
      ? {
          command,
          method,
          health: "missing",
          detail: "endpoint does not exist",
          expected: KNOWN_ABSENT.has(method),
        }
      : { command, method, health: "ok", detail: "reachable" }
  }
}

export const checkAll = (
  api: PCloudAPI,
  auth: Record<string, string>,
): Promise<CommandHealth[]> =>
  Promise.all(
    SURFACE.map(([command, method]) =>
      checkCommand(api, auth, command, method),
    ),
  )
