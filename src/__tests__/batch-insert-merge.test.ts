/**
 * batchInsert folds runs of identical single-row inserts into multi-row
 * statements. The shape detection is checked on its own, and the execution
 * path against a mocked client: one statement per chunk, placeholders
 * renumbered, non-foldable statements untouched, and a cardinality
 * violation rolled back to the savepoint and replayed row by row.
 */

const mockConnect = jest.fn()
const mockPool = { connect: (...args: unknown[]) => mockConnect(...args), on: jest.fn(), end: jest.fn(), waitingCount: 0, totalCount: 0, idleCount: 0 }
jest.mock("pg", () => ({ Pool: jest.fn().mockImplementation(() => mockPool) }))
jest.mock("../db-driver/config", () => ({
  getConnectionConfig: jest.fn(() => ({ host: "localhost", port: 5432, database: "test", user: "test", password: "test", ssl: false })),
}))
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), startTimer: () => () => {} })),
}))

import { db, groupMergeableStatements, mergeShapeOf } from "../db-driver"

const INSERT = `INSERT INTO temporal_risk_scores (risk_id, repo_id, score)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (repo_id) DO UPDATE SET score = EXCLUDED.score`
const UPDATE = `UPDATE symbol_lineage SET is_alive = FALSE WHERE lineage_id = $1`

describe("mergeShapeOf", () => {
  test("recognises a single-row insert with an ON CONFLICT clause", () => {
    expect(mergeShapeOf(INSERT)).toEqual({
      prefix: "INSERT INTO temporal_risk_scores (risk_id, repo_id, score)\n                    VALUES",
      suffix: "\n                    ON CONFLICT (repo_id) DO UPDATE SET score = EXCLUDED.score",
      width: 3,
    })
  })

  test("recognises a plain insert", () => {
    expect(mergeShapeOf("INSERT INTO t (a, b) VALUES ($1, $2)")).toEqual({ prefix: "INSERT INTO t (a, b) VALUES", suffix: "", width: 2 })
  })

  test("refuses anything that is not one ordered row of placeholders", () => {
    expect(mergeShapeOf(UPDATE)).toBeNull()
    expect(mergeShapeOf("INSERT INTO t (a, b) VALUES ($2, $1)")).toBeNull()
    expect(mergeShapeOf("INSERT INTO t (a, b) VALUES ($1, NOW())")).toBeNull()
    expect(mergeShapeOf("INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET b = $2")).toBeNull()
    expect(mergeShapeOf("WITH x AS (INSERT INTO t (a) VALUES ($1) RETURNING a) UPDATE u SET v = 1")).toBeNull()
  })
})

describe("groupMergeableStatements", () => {
  test("groups consecutive identical inserts and leaves the rest alone", () => {
    const groups = groupMergeableStatements([
      { text: INSERT, params: [1, 2, 3] },
      { text: INSERT, params: [4, 5, 6] },
      { text: UPDATE, params: ["l1"] },
      { text: INSERT, params: [7, 8, 9] },
    ])
    expect(groups.map((g) => [g.statements.length, g.merge !== null])).toEqual([
      [2, true],
      [1, false],
      [1, true],
    ])
  })

  test("a row whose parameter count does not match its shape runs as written", () => {
    const groups = groupMergeableStatements([{ text: INSERT, params: [1, 2] }])
    expect(groups[0]!.merge).toBeNull()
  })
})

describe("batchInsert", () => {
  let client: { query: jest.Mock; release: jest.Mock }
  beforeEach(() => {
    client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }), release: jest.fn() }
    mockConnect.mockResolvedValue(client)
  })

  const sqlCalls = (): string[] => client.query.mock.calls.map((c) => String(c[0]))

  test("folds a run of identical inserts into one statement with renumbered placeholders", async () => {
    await db.batchInsert([
      { text: INSERT, params: ["r1", "repo", 0.1] },
      { text: INSERT, params: ["r2", "repo", 0.2] },
      { text: UPDATE, params: ["l1"] },
    ])
    const merged = client.query.mock.calls.find((c) => String(c[0]).includes("VALUES ($1, $2, $3), ($4, $5, $6)"))
    expect(merged).toBeDefined()
    expect(merged![0]).toContain("ON CONFLICT (repo_id) DO UPDATE SET score = EXCLUDED.score")
    expect(merged![1]).toEqual(["r1", "repo", 0.1, "r2", "repo", 0.2])
    expect(client.query).toHaveBeenCalledWith(UPDATE, ["l1"])
    expect(sqlCalls().filter((q) => q.startsWith("SAVEPOINT")).length).toBe(1)
    expect(sqlCalls()).toContain("COMMIT")
  })

  test("a chunk that hits the same conflict row twice is replayed row by row under a savepoint", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("VALUES ($1, $2, $3), ($4, $5, $6)")) {
        const err = new Error("ON CONFLICT DO UPDATE command cannot affect row a second time") as Error & { code?: string }
        err.code = "21000"
        throw err
      }
      return { rows: [], rowCount: 1 }
    })
    await db.batchInsert([
      { text: INSERT, params: ["r1", "repo", 0.1] },
      { text: INSERT, params: ["r2", "repo", 0.2] },
    ])
    const calls = sqlCalls()
    expect(calls).toContain("ROLLBACK TO SAVEPOINT batch_merge")
    expect(calls.filter((q) => q === INSERT).length).toBe(2)
    expect(calls).toContain("COMMIT")
  })

  test("any other failure aborts the transaction", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("VALUES ($1, $2, $3), ($4, $5, $6)")) throw Object.assign(new Error("boom"), { code: "23505" })
      return { rows: [], rowCount: 1 }
    })
    await expect(db.batchInsert([{ text: INSERT, params: [1, 2, 3] }, { text: INSERT, params: [4, 5, 6] }])).rejects.toThrow("boom")
    expect(sqlCalls()).toContain("ROLLBACK")
  })
})
