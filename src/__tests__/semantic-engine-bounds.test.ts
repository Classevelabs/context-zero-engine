const mockQuery = jest.fn()
const mockBatchInsert = jest.fn()
const mockLoadPage = jest.fn()
const mockLoadBehavioral = jest.fn()
const mockLoadContracts = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    batchInsert: (...args: unknown[]) => mockBatchInsert(...args),
  },
}))

jest.mock("../db-driver/batch-loader", () => ({
  BatchLoader: jest.fn().mockImplementation(() => ({
    loadSymbolVersionsBySnapshotPaginated: (...args: unknown[]) => mockLoadPage(...args),
    loadBehavioralProfiles: (...args: unknown[]) => mockLoadBehavioral(...args),
    loadContractProfiles: (...args: unknown[]) => mockLoadContracts(...args),
  })),
}))

jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    startTimer: jest.fn().mockReturnValue(jest.fn()),
  })),
}))

import { semanticEngine } from "../semantic-engine"

describe("SemanticEngine resource boundaries", () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockBatchInsert.mockReset().mockResolvedValue(undefined)
    mockLoadPage.mockReset()
    mockLoadBehavioral.mockReset().mockResolvedValue(new Map())
    mockLoadContracts.mockReset().mockResolvedValue(new Map())
  })

  test("an all-sentinel target returns before LSH or legacy linear scans", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ view_type: "body", minhash_signature: new Array(128).fill(0xffffffff) }],
      rowCount: 1,
    })

    const result = await semanticEngine.findSemanticCandidates("sv-empty", "snap-1", Number.NaN)

    expect(result).toEqual([])
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const issuedSql = mockQuery.mock.calls.map((call) => String(call[0])).join("\n")
    expect(issuedSql).not.toContain("band_keys &&")
    expect(issuedSql).not.toContain("LIMIT 50000")
  })

  test("batch embedding makes two bounded page passes instead of loading the snapshot", async () => {
    const row = {
      symbol_version_id: "sv-1",
      symbol_id: "sym-1",
      snapshot_id: "snap-1",
      file_id: "file-1",
      range_start_line: 1,
      range_start_col: 1,
      range_end_line: 1,
      range_end_col: 10,
      signature: "target(): void",
      ast_hash: "ast",
      body_hash: "body",
      summary: "target",
      body_source: "function target() {}",
      visibility: "public",
      language: "typescript",
      uncertainty_flags: [],
      canonical_name: "target",
      kind: "function",
      stable_key: "src/a.ts::target",
      repo_id: "repo-1",
      file_path: "src/a.ts",
    }
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockLoadPage.mockResolvedValue({ rows: [row], nextCursor: null })

    const embedded = await semanticEngine.batchEmbedSnapshot("snap-1")

    expect(embedded).toBe(1)
    expect(mockLoadPage).toHaveBeenCalledTimes(2)
    expect(mockLoadPage).toHaveBeenNthCalledWith(1, "snap-1", { pageSize: 250, afterId: undefined })
    expect(mockLoadPage).toHaveBeenNthCalledWith(2, "snap-1", { pageSize: 250, afterId: undefined })
    expect(mockBatchInsert).toHaveBeenCalledTimes(1)
    const issuedSql = mockQuery.mock.calls.map((call) => String(call[0])).join("\n")
    expect(issuedSql).not.toContain("FROM symbol_versions symv\n")
  })

  test("an empty snapshot clears stale IDF state and skips the second pass", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockLoadPage.mockResolvedValue({ rows: [], nextCursor: null })

    await expect(semanticEngine.batchEmbedSnapshot("snap-empty")).resolves.toBe(0)

    expect(mockLoadPage).toHaveBeenCalledTimes(1)
    expect(mockQuery).toHaveBeenCalledWith("DELETE FROM idf_corpus WHERE snapshot_id = $1", ["snap-empty"])
    expect(mockBatchInsert).not.toHaveBeenCalled()
  })

  test("snapshot IDF aggregates in PostgreSQL without the old 100k truncation", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("COUNT(*)::int AS document_count")) {
        return Promise.resolve({ rows: [{ document_count: 2 }], rowCount: 1 })
      }
      if (sql.includes("jsonb_object_keys")) {
        return Promise.resolve({ rows: [{ token: "shared", document_count: 2 }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    await semanticEngine.computeSnapshotIDF("snap-1")

    const calls = mockQuery.mock.calls
    expect(calls.some((call) => String(call[0]).includes("LIMIT 100000"))).toBe(false)
    const frequencyCalls = calls.filter((call) => String(call[0]).includes("jsonb_object_keys"))
    expect(frequencyCalls).toHaveLength(5)
    expect(frequencyCalls.every((call) => call[1]?.[2] === 50_000)).toBe(true)
  })
})
