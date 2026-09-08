/**
 * A symbol search over an unchanged tree parses nothing: the second search
 * reuses every file's parse while size and mtime hold, and a modified file
 * is parsed again.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { searchWorkspaceSymbols, parseCacheSize } from "../workspace-native"

jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), startTimer: () => () => {} })),
}))

describe("native symbol search parse cache", () => {
  let repo: string
  let savedAllowed: string | undefined
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cz-parse-cache-"))
    // The search refuses paths outside the configured base paths; another
    // suite in the same worker may have left that list set.
    savedAllowed = process.env["SCG_ALLOWED_BASE_PATHS"]
    process.env["SCG_ALLOWED_BASE_PATHS"] = repo
    writeFileSync(join(repo, "a.go"), "package a\n\nfunc LoadUser() {}\n\nfunc SaveUser() {}\n")
    writeFileSync(join(repo, "b.go"), "package a\n\nfunc RenderChart() {}\n")
  })
  afterAll(() => {
    if (savedAllowed === undefined) delete process.env["SCG_ALLOWED_BASE_PATHS"]
    else process.env["SCG_ALLOWED_BASE_PATHS"] = savedAllowed
    rmSync(repo, { recursive: true, force: true })
  })

  test("parses each file once, then answers from the cache until the file changes", async () => {
    const first = await searchWorkspaceSymbols(repo, "LoadUser", { language: "go" })
    expect(first.matches.map((m) => m.canonical_name)).toContain("LoadUser")
    // Size is measured AFTER the first pass, not as a delta from an empty cache:
    // the cache is module-global with LRU eviction, so under the full suite it
    // may already hold (and evict) other files. What this test pins is the
    // BEHAVIOUR — a re-search over unchanged files adds no new parse, and a
    // changed file is re-parsed — not an absolute entry count.
    const primed = parseCacheSize()
    expect(primed).toBeGreaterThanOrEqual(2)

    const second = await searchWorkspaceSymbols(repo, "SaveUser", { language: "go" })
    expect(second.matches.map((m) => m.canonical_name)).toContain("SaveUser")
    expect(parseCacheSize()).toBe(primed) // unchanged files → cache hit, no growth

    // Change a file: same size, newer mtime, new content.
    writeFileSync(join(repo, "b.go"), "package a\n\nfunc RenderGraph() {}\n")
    const later = new Date(Date.now() + 5000)
    utimesSync(join(repo, "b.go"), later, later)
    const third = await searchWorkspaceSymbols(repo, "Render", { language: "go" })
    expect(third.matches.map((m) => m.canonical_name)).toContain("RenderGraph")
    expect(third.matches.map((m) => m.canonical_name)).not.toContain("RenderChart")
    expect(parseCacheSize()).toBe(primed) // b.go re-parsed in place, a.go still cached
  })
})
