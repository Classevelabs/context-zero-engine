const mockQuery = jest.fn()
const mockBlastRadius = jest.fn()

jest.mock("../db-driver", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}))

jest.mock("../analysis-engine/blast-radius", () => ({
  blastRadiusEngine: { computeBlastRadius: (...args: unknown[]) => mockBlastRadius(...args) },
}))

import { compileSmartContext } from "../services/context-service"

const emptyBlast = {
  structural_impacts: [],
  behavioral_impacts: [],
  contract_impacts: [],
  homolog_impacts: [],
  historical_impacts: [],
  total_impact_count: 0,
  recommended_validation_scope: "target only",
}

describe("smart-context input and budget bounds", () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockBlastRadius.mockReset()
    mockQuery.mockResolvedValue({
      rows: [{
        symbol_version_id: "sv-1",
        canonical_name: "target",
        kind: "function",
        signature: "target(): void",
        body_source: "x".repeat(20_000),
        file_path: "src/a.ts",
        range_start_line: 1,
        range_end_line: 2,
      }],
      rowCount: 1,
    })
    mockBlastRadius.mockResolvedValue(emptyBlast)
  })

  test("deduplicates targets and clamps negative budget/non-finite depth", async () => {
    const result = await compileSmartContext("change target", ["sv-1", "sv-1"], "snap-1", {
      tokenBudget: -100,
      depth: Number.POSITIVE_INFINITY,
    })

    expect(mockQuery.mock.calls[0]![1]).toEqual(["sv-1"])
    expect(mockBlastRadius).toHaveBeenCalledWith("snap-1", ["sv-1"], 2)
    expect(result.token_usage.budget).toBe(100)
    // `used` reports the measured serialized size of the whole result. The
    // result frame (task echo, keys, target metadata) is irreducible, so a
    // floor-clamped budget can be exceeded by at most that frame.
    expect(result.token_usage.used).toBeLessThanOrEqual(100 + 200)
    expect(result.token_usage.remaining).toBeGreaterThanOrEqual(0)
    expect(result.targets[0]!.source.length).toBeLessThanOrEqual(400)
  })

  test.each([
    [Number.NaN, 20_000],
    [Number.POSITIVE_INFINITY, 20_000],
    [1_000_000, 100_000],
  ])("normalizes non-finite and excessive budgets", async (requested, expected) => {
    const result = await compileSmartContext("change target", ["sv-1"], "snap-1", { tokenBudget: requested })
    expect(result.token_usage.budget).toBe(expected)
    expect(Number.isFinite(result.token_usage.remaining)).toBe(true)
  })

  test("rejects oversized target sets before querying", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `sv-${index}`)
    await expect(compileSmartContext("change targets", ids, "snap-1")).rejects.toThrow(/1-20/)
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
