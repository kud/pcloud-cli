import { describe, expect, it, vi } from "vitest"
import { looksLikeId, resolveFileId, resolveFolderId } from "./refs.js"

const api = (metadata: unknown, result = 0, error?: string) => ({
  stat: vi.fn(async () => ({ result, error, metadata })),
})

describe("looksLikeId", () => {
  it("accepts a bare number, so ids from `pcloud ls` keep working", () => {
    expect(looksLikeId("102307928831")).toBe(true)
    expect(looksLikeId("  42  ")).toBe(true)
  })

  it("treats anything path-shaped as a path", () => {
    expect(looksLikeId("/Appdata")).toBe(false)
    expect(looksLikeId("/1234")).toBe(false)
    expect(looksLikeId("notes.md")).toBe(false)
  })
})

describe("resolveFileId", () => {
  it("passes a numeric id through without a network call", async () => {
    const client = api({})
    expect(await resolveFileId(client, "7")).toBe(7)
    expect(client.stat).not.toHaveBeenCalled()
  })

  it("resolves a path with one stat", async () => {
    const client = api({ fileid: 99, isfolder: false })
    expect(await resolveFileId(client, "/notes.md")).toBe(99)
    expect(client.stat).toHaveBeenCalledOnce()
  })

  // The point of refusing, rather than a nicety: silently accepting the wrong
  // kind is how a command acts on something nobody named.
  it("refuses a folder", async () => {
    await expect(
      resolveFileId(api({ folderid: 5, isfolder: true }), "/Appdata"),
    ).rejects.toThrow(/is a folder/)
  })

  it("refuses a path that resolves to nothing usable", async () => {
    await expect(resolveFileId(api({}), "/odd")).rejects.toThrow(/No such file/)
  })

  it("surfaces pCloud's own error rather than inventing one", async () => {
    await expect(
      resolveFileId(api(undefined, 2005, "Directory does not exist."), "/nope"),
    ).rejects.toThrow("Directory does not exist.")
  })
})

describe("resolveFolderId", () => {
  it("resolves a path with one stat", async () => {
    const client = api({ folderid: 4155189645, isfolder: true })
    expect(await resolveFolderId(client, "/Appdata")).toBe(4155189645)
  })

  // rmdir is recursive. Accepting a file and resolving its parent would delete
  // a directory nobody asked about.
  it("refuses a file", async () => {
    await expect(
      resolveFolderId(api({ fileid: 7, isfolder: false }), "/notes.md"),
    ).rejects.toThrow(/is a file/)
  })

  it("passes a numeric id through", async () => {
    const client = api({})
    expect(await resolveFolderId(client, "25673131371")).toBe(25673131371)
    expect(client.stat).not.toHaveBeenCalled()
  })
})
