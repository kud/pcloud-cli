import type { PCloudAPI, PCloudDiffEntry } from "@kud/pcloud"

type FolderNode = { name: string; parentfolderid?: number }

// diff metadata carries parentfolderid but never a path, so a folder's name is
// all an event gives us. Walking parents up to the root turns that into
// something a person can recognise — and the cache matters because a bulk
// deletion produces hundreds of events sharing a handful of parents.
//
// Seeding from the events themselves is what makes this work on the case that
// matters: once a folder is deleted, listfolder can no longer resolve it, and
// its children are exactly the files someone is trying to recover. Their
// ancestry survives only in the diff stream, where every folder event still
// carries its own folderid, name and parent.
export const pathResolver = (
  api: PCloudAPI,
  entries: PCloudDiffEntry[] = [],
) => {
  const known = new Map<number, FolderNode>()
  for (const entry of entries) {
    const meta = entry.metadata ?? {}
    if (meta.folderid !== undefined && meta.name) {
      known.set(meta.folderid, {
        name: meta.name,
        parentfolderid: meta.parentfolderid,
      })
    }
  }

  const cache = new Map<number, string>([[0, ""]])

  const folderPath = async (
    folderid?: number,
    seen = new Set<number>(),
  ): Promise<string> => {
    if (folderid === undefined) return ""
    const hit = cache.get(folderid)
    if (hit !== undefined) return hit
    // pCloud should never produce a cycle, but a malformed parent chain would
    // otherwise recurse until the stack gives out.
    if (seen.has(folderid)) return ""
    seen.add(folderid)

    const local = known.get(folderid)
    if (local) {
      const parent = await folderPath(local.parentfolderid, seen)
      const full = `${parent}/${local.name}`
      cache.set(folderid, full)
      return full
    }

    try {
      const res = await api.listFolderById(folderid, { nofiles: true })
      const meta = res.metadata as FolderNode | undefined
      if (!meta?.name) return ""
      const parent = await folderPath(meta.parentfolderid, seen)
      const full = `${parent}/${meta.name}`
      cache.set(folderid, full)
      return full
    } catch {
      return ""
    }
  }

  return async (entry: PCloudDiffEntry): Promise<string> => {
    const meta = entry.metadata ?? {}
    if (meta.path) return meta.path
    const parent = await folderPath(meta.parentfolderid)
    return `${parent}/${meta.name ?? "?"}`
  }
}
