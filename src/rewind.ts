import type { PCloudAPI, PCloudDiffEntry } from "@kud/pcloud"
import { pathResolver } from "./lib/paths.js"

// pCloud has no Rewind endpoint — the web app's feature is not in the public
// API under any spelling. What it does have are the three pieces Rewind is
// built from: diff says what changed and when, revisions hold prior versions of
// modified files, and trash holds deletions that have not been purged. Replaying
// diff backwards over those two recovery paths reconstructs the same outcome.

export type RewindAction =
  | { kind: "restore"; fileid: number; name: string; path: string; at: string }
  | { kind: "revert"; fileid: number; name: string; path: string; at: string }
  | { kind: "created"; name: string; path: string; at: string }

export type RewindPlan = {
  actions: RewindAction[]
  since: string
  scanned: number
}

// A deletion is undone by restoring, a modification by reverting. A creation
// cannot be undone without deleting real data, so it is reported and never
// acted on — the asymmetry is deliberate, since a rewind that quietly removed
// files would be indistinguishable from the accident it is meant to repair.
const classify = (event: string): RewindAction["kind"] | null => {
  if (event.startsWith("delete")) return "restore"
  if (event === "modifyfile") return "revert"
  if (event.startsWith("create")) return "created"
  return null
}

// diff's `after` parameter does not parse ISO-8601 — handed one, pCloud returns
// a window that is not the one requested, with no error. Fetching a block of
// recent events and filtering here keeps the cutoff exact and the timezone
// handling ours, at the cost of pulling more than strictly needed.
const SCAN_LIMIT = 5000

export const planRewind = async (
  api: PCloudAPI,
  since: Date,
  pathPrefix?: string,
): Promise<RewindPlan> => {
  const response = await api.diff({ last: SCAN_LIMIT })
  if (response.result !== 0) {
    throw new Error(response.error ?? "could not read change history")
  }

  const fetched = response.entries ?? []
  const entries = fetched.filter(
    (entry) => new Date(entry.time ?? 0).getTime() >= since.getTime(),
  )

  // A full block means older events were cut off, and a rewind that silently
  // ignored part of its own window would be worse than one that refuses.
  if (fetched.length >= SCAN_LIMIT && entries.length === fetched.length) {
    throw new Error(
      `That reaches past the ${SCAN_LIMIT} most recent events — history before ` +
        `${new Date(fetched[0]?.time ?? "").toLocaleString()} was not scanned. ` +
        `Choose a later time.`,
    )
  }
  const toPath = pathResolver(api, entries)
  const actions: RewindAction[] = []

  for (const entry of entries) {
    const kind = classify(entry.event)
    if (!kind) continue

    const meta = entry.metadata ?? {}
    const path = await toPath(entry)
    if (pathPrefix && !path.startsWith(pathPrefix)) continue

    const base = {
      name: meta.name ?? "?",
      path,
      at: entry.time ?? "-",
    }

    if (kind === "created") {
      actions.push({ kind, ...base })
      continue
    }

    // Both recovery paths key off a fileid; a folder deletion has none, and its
    // children appear as their own events, so nothing is lost by skipping it.
    if (meta.fileid === undefined) continue
    actions.push({ kind, fileid: meta.fileid, ...base })
  }

  return { actions, since: since.toISOString(), scanned: entries.length }
}

export type RewindOutcome = {
  action: RewindAction
  ok: boolean
  detail: string
}

export const applyRewind = async (
  api: PCloudAPI,
  plan: RewindPlan,
): Promise<RewindOutcome[]> => {
  const outcomes: RewindOutcome[] = []

  for (const action of plan.actions) {
    if (action.kind === "created") continue

    if (action.kind === "restore") {
      const res = await api.restoreFromTrash(action.fileid)
      outcomes.push({
        action,
        ok: res.result === 0,
        detail:
          res.result === 0
            ? "restored from trash"
            : (res.error ?? `failed (result ${res.result})`),
      })
      continue
    }

    const revisions = await api.listRevisions(action.fileid)
    if (revisions.result !== 0) {
      outcomes.push({
        action,
        ok: false,
        detail: revisions.error ?? "could not list revisions",
      })
      continue
    }

    // The newest revision that predates the target time is the state to return
    // to; anything newer is part of what we are undoing.
    const cutoff = new Date(plan.since).getTime()
    const target = (revisions.revisions ?? [])
      .filter((r: any) => new Date(r.created).getTime() <= cutoff)
      .sort((a: any, b: any) => b.revisionid - a.revisionid)[0]

    if (!target) {
      outcomes.push({
        action,
        ok: false,
        detail: "no revision from before that time",
      })
      continue
    }

    const res = await api.revertRevision(action.fileid, target.revisionid)
    outcomes.push({
      action,
      ok: res.result === 0,
      detail:
        res.result === 0
          ? `reverted to revision ${target.revisionid}`
          : (res.error ?? `failed (result ${res.result})`),
    })
  }

  return outcomes
}
