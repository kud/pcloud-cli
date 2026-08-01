import type { PCloudAPI } from "@kud/pcloud"

// pCloud's API is keyed by numeric id, and the CLI passed that straight
// through for thirteen commands — so `pcloud download /notes.md` worked while
// `pcloud delete-file /notes.md` did not, and deleting a folder meant running
// `pcloud stat` first to copy a number out of its JSON. Which commands took
// which was an artefact of the API, not a distinction anyone asked for.
//
// A bare number is still accepted, so ids copied from `pcloud ls` keep working
// and nothing scripted breaks. Anything else costs one stat call.

export const looksLikeId = (ref: string): boolean => /^\d+$/.test(ref.trim())

type Meta = { fileid?: number; folderid?: number; isfolder?: boolean }

export type StatFn = (
  path: string,
) => Promise<{ result: number; error?: string; metadata?: unknown }>

const statOrThrow = async (stat: StatFn, ref: string): Promise<Meta> => {
  const res = await stat(ref)
  if (res.result !== 0) throw new Error(res.error ?? `Cannot resolve ${ref}`)
  return (res.metadata ?? {}) as Meta
}

// Refusing the wrong kind is the point, not a nicety: rmdir is recursive, and
// silently resolving a file's parent folder because the id happened to be
// there would delete a directory nobody named.
export const resolveFileId = async (
  api: Pick<PCloudAPI, "stat">,
  ref: string,
): Promise<number> => {
  if (looksLikeId(ref)) return Number(ref)
  const meta = await statOrThrow((p) => api.stat(p), ref)
  if (meta.isfolder)
    throw new Error(`${ref} is a folder, and this command takes a file`)
  if (meta.fileid === undefined) throw new Error(`No such file: ${ref}`)
  return meta.fileid
}

export const resolveFolderId = async (
  api: Pick<PCloudAPI, "stat">,
  ref: string,
): Promise<number> => {
  if (looksLikeId(ref)) return Number(ref)
  const meta = await statOrThrow((p) => api.stat(p), ref)
  if (meta.isfolder === false)
    throw new Error(`${ref} is a file, and this command takes a folder`)
  if (meta.folderid === undefined) throw new Error(`No such folder: ${ref}`)
  return meta.folderid
}
