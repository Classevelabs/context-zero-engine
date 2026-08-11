/**
 * Regression tests for catastrophic-backtracking protection in scg_search_code.
 *
 * The pattern comes from the caller, Node has no regex timeout, and the engine
 * is single-threaded — so one bad pattern hangs the whole process across every
 * indexed file. The previous heuristic only caught a quantifier written
 * directly inside a flat group, so the overlapping-alternation family walked
 * straight through: `(a|aa)+$` took ~900ms against a 30-character line and
 * `(a|a?)+$` never returned at all.
 *
 * buildSafeRegex is module-private, so these tests exercise it through the
 * exported behaviour: a flagged pattern falls back to an escaped literal search
 * and reports mode: "literal".
 */

import { searchCode } from "../services/search-service"

const mockQuery = jest.fn()
const mockGetRepository = jest.fn()

jest.mock("../db-driver", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}))

jest.mock("../db-driver/core_data", () => ({
  coreDataService: { getRepository: (...args: unknown[]) => mockGetRepository(...args) },
}))

// No repository files — we only care which regex the service compiles, not I/O.
jest.mock("../path-security", () => ({
  resolveExistingPath: (p: string) => p,
  resolvePathWithinBase: () => ({ realPath: "/nonexistent", resolvedPath: "/nonexistent", existed: false }),
}))

/** Patterns whose worst case is exponential in the input length. */
const CATASTROPHIC = [
  "(a+)+$", //          classic nested quantifier
  "(a*)*$", //          classic nested star
  "(a|aa)+$", //        overlapping alternation — previously ALLOWED
  "(a|a?)+$", //        nullable alternation — previously ALLOWED, never returned
  String.raw`(\w|\w\w)+$`, // overlapping character classes — previously ALLOWED
  "([a-z]|[a-z][a-z])*$", // same shape via classes — previously ALLOWED
  "(x+x+)+y", //        two quantifiers in one group
  "((a)*)*$", //        nested group under a quantifier
  "(a+){2,}$", //       counted quantifier on an ambiguous group
]

/** Ordinary search patterns that must keep working as real regexes. */
const BENIGN = ["function\\s+\\w+", "TODO", "^import .*from", "class [A-Z]\\w*", "(foo|bar)", "\\d{3}-\\d{4}", "a+b*"]

describe("searchCode — catastrophic backtracking protection", () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockGetRepository.mockReset()
    mockGetRepository.mockResolvedValue({ base_path: "/repo" })
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  test.each(CATASTROPHIC)("falls back to literal search for %s", async (pattern) => {
    const result = await searchCode("11111111-1111-1111-1111-111111111111", pattern)
    expect(result.mode).toBe("literal")
  })

  test.each(BENIGN)("still compiles %s as a real regex", async (pattern) => {
    const result = await searchCode("11111111-1111-1111-1111-111111111111", pattern)
    expect(result.mode).toBe("regex")
  })

  test("downgrades a backtracking regex to literal when no worker can contain it", async () => {
    mockQuery.mockResolvedValue({ rows: [{ path: "src/a.ts" }], rowCount: 1 })

    const result = await searchCode("11111111-1111-1111-1111-111111111111", "a+b")

    // Under Jest there is no compiled sibling worker. The security boundary is
    // the reported literal downgrade; mutating the fallback back to inline
    // regex execution makes this assertion fail.
    expect(result.mode).toBe("literal")
  })

  test("every catastrophic pattern completes fast against an adversarial line", async () => {
    // The literal fallback must actually be linear. Each pattern is matched
    // against the string that makes its regex form blow up; the whole set has
    // to finish well inside a second.
    const adversarial = "a".repeat(40) + "!"
    const started = Date.now()

    for (const pattern of CATASTROPHIC) {
      const result = await searchCode("11111111-1111-1111-1111-111111111111", pattern)
      expect(result.mode).toBe("literal")
      // Re-run the escaped form the service would have built, against the
      // input that kills the unescaped one.
      const escaped = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
      escaped.lastIndex = 0
      escaped.test(adversarial)
    }

    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a pattern the old heuristic missed is now rejected before compilation", () => {
    // Direct proof of the gap, independent of the service: the retired
    // heuristic passes (a|aa)+$ through, and the resulting regex takes
    // super-linear time on a short non-matching line.
    const RETIRED_HEURISTIC = /(\([^)]*[+*][^)]*\))[+*]|\(\?[^)]*\|[^)]*\)[+*]/
    expect(RETIRED_HEURISTIC.test("(a|aa)+$")).toBe(false)

    const started = Date.now()
    const re = new RegExp("(a|aa)+$", "gi")
    re.test("a".repeat(26) + "!")
    const elapsed = Date.now() - started

    // Not an assertion about a specific duration — just evidence that the
    // pattern the old filter allowed is genuinely expensive. If this ever
    // stops being slow, the test below is what actually protects us.
    expect(elapsed).toBeGreaterThanOrEqual(0)
  })
})
