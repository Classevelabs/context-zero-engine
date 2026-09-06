/**
 * Symbol-level history from git blame.
 *
 * The parser and the attribution are checked against hand-built porcelain,
 * and then against a real repository built in a temporary directory, so the
 * test fails if git's porcelain format or the way we invoke it changes.
 */

import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  parseBlamePorcelain,
  blameFile,
  commitsPerSymbol,
  withinBudget,
  MAX_BLAME_LINES,
} from "../analysis-engine/blame-co-change"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

describe("parseBlamePorcelain", () => {
  test("maps every final line to the commit of its group", () => {
    const raw = [
      `${SHA_A} 1 1 2`,
      "author Someone",
      "\tline one",
      `${SHA_A} 2 2`,
      "\tline two",
      `${SHA_B} 1 3 1`,
      "author Other",
      "\tline three",
      "",
    ].join("\n")
    expect(parseBlamePorcelain(raw)).toEqual([SHA_A, SHA_A, SHA_B])
  })

  test("ignores header lines that do not open a group", () => {
    const raw = [`${SHA_A} 1 1 1`, "summary 1 2 3", "filename x.ts", "\tcontent"].join("\n")
    expect(parseBlamePorcelain(raw)).toEqual([SHA_A])
  })

  test("returns an empty array for empty output", () => {
    expect(parseBlamePorcelain("")).toEqual([])
  })
})

describe("commitsPerSymbol", () => {
  const shas = [SHA_A, SHA_A, SHA_B, SHA_B, SHA_A]

  test("collects the commits that touched each symbol's lines", () => {
    const result = commitsPerSymbol(shas, [
      { symbol_id: "s1", range_start_line: 1, range_end_line: 2 },
      { symbol_id: "s2", range_start_line: 2, range_end_line: 4 },
    ])
    expect([...result.get("s1")!]).toEqual([SHA_A])
    expect([...result.get("s2")!].sort()).toEqual([SHA_A, SHA_B])
  })

  test("lines not yet committed belong to no commit", () => {
    const zero = "0".repeat(40)
    const result = commitsPerSymbol([zero, zero, SHA_A], [
      { symbol_id: "edited", range_start_line: 1, range_end_line: 2 },
      { symbol_id: "mixed", range_start_line: 2, range_end_line: 3 },
    ])
    expect(result.has("edited")).toBe(false)
    expect([...result.get("mixed")!]).toEqual([SHA_A])
  })

  test("clamps ranges to the file and drops symbols with no lines", () => {
    const result = commitsPerSymbol(shas, [
      { symbol_id: "past-end", range_start_line: 9, range_end_line: 12 },
      { symbol_id: "overlaps-end", range_start_line: 4, range_end_line: 12 },
    ])
    expect(result.has("past-end")).toBe(false)
    expect([...result.get("overlaps-end")!].sort()).toEqual([SHA_A, SHA_B])
  })
})

describe("withinBudget", () => {
  test("runs everything when the budget allows", async () => {
    const seen: number[] = []
    const result = await withinBudget([1, 2, 3, 4, 5], 2, 10_000, async (n) => {
      seen.push(n)
    })
    expect(result).toEqual({ completed: 5, skipped: 0 })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  test("stops starting work once the budget has elapsed and reports the rest as skipped", async () => {
    let started = 0
    const result = await withinBudget([1, 2, 3, 4, 5, 6], 1, 0, async () => {
      started++
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    // A zero budget is already elapsed before the first item.
    expect(started).toBe(0)
    expect(result).toEqual({ completed: 0, skipped: 6 })
  })
})

describe("blameFile against a real repository", () => {
  let repo: string

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cz-blame-"))
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("config", "commit.gpgsign", "false")
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src", "a.ts"), "function one() {\n  return 1\n}\nfunction two() {\n  return 2\n}\n")
    git("add", ".")
    git("commit", "-q", "-m", "first")
    writeFileSync(join(repo, "src", "a.ts"), "function one() {\n  return 1\n}\nfunction two() {\n  return 22\n}\n")
    git("commit", "-q", "-am", "second: change two")
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("attributes each symbol to the commits that last touched its lines", async () => {
    const shas = await blameFile(repo, "src/a.ts", 10_000)
    expect(shas).not.toBeNull()
    expect(shas!.length).toBe(6)
    const [first, second] = git("log", "--reverse", "--format=%H").trim().split("\n")
    const result = commitsPerSymbol(shas!, [
      { symbol_id: "one", range_start_line: 1, range_end_line: 3 },
      { symbol_id: "two", range_start_line: 4, range_end_line: 6 },
    ])
    expect([...result.get("one")!]).toEqual([first])
    expect([...result.get("two")!].sort()).toEqual([first, second].sort())
  })

  test("returns null for a file git does not track", async () => {
    writeFileSync(join(repo, "src", "untracked.ts"), "export const x = 1\n")
    expect(await blameFile(repo, "src/untracked.ts", 10_000)).toBeNull()
  })

  test("returns null past the size bound", async () => {
    const lines = Array.from({ length: MAX_BLAME_LINES + 1 }, (_, i) => `// ${i}`).join("\n") + "\n"
    writeFileSync(join(repo, "src", "big.ts"), lines)
    git("add", "src/big.ts")
    git("commit", "-q", "-m", "big")
    expect(await blameFile(repo, "src/big.ts", 30_000)).toBeNull()
  })
})
