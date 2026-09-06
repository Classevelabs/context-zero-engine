const mockQuery = jest.fn()

jest.mock("../db-driver", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}))
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    startTimer: jest.fn(() => jest.fn()),
  })),
}))

import { explainRelation, reviewHomolog } from "../services/graph-service"

// Both tools had been broken since they were written and no test could see
// it: the driver is mocked, so a column that does not exist is only found by
// PostgreSQL. sql-schema-contract.test.ts now checks every column against the
// schema; these pin the two repaired statements themselves.
describe("explainRelation", () => {
  test("joins evidence bundles on the id the relation row carries", async () => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })

    await explainRelation({ src_symbol_version_id: "sv-a", dst_symbol_version_id: "sv-b", snapshot_id: "snap-1" })

    const inferred = mockQuery.mock.calls.map((c) => c[0] as string).find((sql) => sql.includes("FROM inferred_relations"))
    expect(inferred).toContain("LEFT JOIN evidence_bundles eb ON eb.evidence_bundle_id = ir.evidence_bundle_id")
    expect(inferred).not.toContain("eb.inferred_relation_id")
  })
})

describe("reviewHomolog", () => {
  test("records the state, the time and the reviewer", async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ review_state: "pending" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const result = await reviewHomolog({ inferred_relation_id: "ir-1", review_state: "confirmed", reviewer: "rb" })

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toContain("SET review_state = $2, reviewed_at = NOW(), reviewed_by = $3")
    expect(sql).not.toContain("updated_at")
    expect(params).toEqual(["ir-1", "confirmed", "rb"])
    expect(result).toEqual({ inferred_relation_id: "ir-1", previous_state: "pending", new_state: "confirmed", updated: true })
  })

  test("a review with no reviewer stores null, not a placeholder", async () => {
    mockQuery
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ review_state: "pending" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })

    await reviewHomolog({ inferred_relation_id: "ir-1", review_state: "rejected" })

    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(params[2]).toBeNull()
  })
})
