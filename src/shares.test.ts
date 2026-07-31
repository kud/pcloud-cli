import { describe, expect, it, vi, afterEach } from "vitest"
import { PCloudAPI } from "@kud/pcloud"

// Two bugs lived here, and only one of them was loud.
//
// `listshares` answers with objects split by direction — {outgoing, incoming} —
// while the type declared a flat array, so `response.shares.forEach` typechecked
// and then threw. That one announced itself.
//
// The quiet one: removeshare ends an *accepted* share and wants `shareid`,
// while accept and decline act on a pending request and want `sharerequestid`.
// removeShare sent the latter, so pCloud answered "Please provide 'shareid'."
// and nothing was ever removed. Nothing in the types could catch that — both
// are numbers — so it is pinned here instead.

const captureParams = () => {
  const seen: URLSearchParams[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      seen.push(new URL(url).searchParams)
      // The client reads the body as text and parses it itself, so a json()
      // stub alone is not enough to get past the request.
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ result: 0 }),
        json: async () => ({ result: 0 }),
      } as Response
    }),
  )
  return seen
}

const api = () => {
  const client = new PCloudAPI("https://eapi.pcloud.com")
  client.setAuth("test-token")
  return client
}

afterEach(() => vi.unstubAllGlobals())

describe("share endpoints send the id each one actually takes", () => {
  it("removeShare sends shareid, not sharerequestid", async () => {
    const seen = captureParams()
    await api().removeShare(225308)

    expect(seen[0]?.get("shareid")).toBe("225308")
    expect(seen[0]?.get("sharerequestid")).toBeNull()
  })

  it("acceptShare sends sharerequestid, which is a different id entirely", async () => {
    const seen = captureParams()
    await api().acceptShare(4242)

    expect(seen[0]?.get("sharerequestid")).toBe("4242")
    expect(seen[0]?.get("shareid")).toBeNull()
  })

  it("declineShare sends sharerequestid", async () => {
    const seen = captureParams()
    await api().declineShare(4242)

    expect(seen[0]?.get("sharerequestid")).toBe("4242")
  })
})
