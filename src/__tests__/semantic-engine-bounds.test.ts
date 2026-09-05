const mockQuery = jest.fn()
const mockBatchInsert = jest.fn()
const mockLoadPage = jest.fn()
const mockLoadBehavioral = jest.fn()
const mockLoadContracts = jest.fn()
const mockLoadByIds = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    batchInsert: (...args: unknown[]) => mockBatchInsert(...args),
  },
}))

jest.mock("../db-driver/batch-loader", () => ({
  BatchLoader: jest.fn().mockImplementation(() => ({
    loadSymbolVersionsBySnapshotPaginated: (...args: unknown[]) => mockLoadPage(...args),
    loadSymbolVersionsByIds: (...args: unknown[]) => mockLoadByIds(...args),
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
    mockLoadByIds.mockReset().mockResolvedValue([])
  })

  describe("IDF corpus is a precondition, not an optional lookup", () => {
    const symbolRows = [
      { symbol_version_id: "sv-1", snapshot_id: "snap-1", canonical_name: "readFile", body_source: "read", signature: "" },
      { symbol_version_id: "sv-2", snapshot_id: "snap-1", canonical_name: "writeFile", body_source: "write", signature: "" },
      { symbol_version_id: "sv-3", snapshot_id: "snap-1", canonical_name: "closeFile", body_source: "close", signature: "" },
    ]

    const corpusRow = (viewType: string) => ({
      view_type: viewType,
      document_count: 3,
      token_document_counts: JSON.stringify({ file: 3, read: 1 }),
    })

    test("loads the corpus once for the batch instead of once per symbol", async () => {
      mockLoadByIds.mockResolvedValue(symbolRows)
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes("FROM idf_corpus")) {
          return Promise.resolve({ rows: ["name", "body", "signature", "behavior", "contract"].map(corpusRow) })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })

      await semanticEngine.embedSymbolVersions(["sv-1", "sv-2", "sv-3"])

      // Re-reading and re-parsing the corpus per symbol is what made the
      // watcher's post-edit pass scale with symbol count rather than corpus size.
      const corpusReads = mockQuery.mock.calls.filter((call) => String(call[0]).includes("FROM idf_corpus"))
      expect(corpusReads).toHaveLength(1)

      // And the per-symbol snapshot lookup goes with it.
      const snapshotLookups = mockQuery.mock.calls.filter((call) =>
        String(call[0]).includes("SELECT snapshot_id FROM symbol_versions"),
      )
      expect(snapshotLookups).toHaveLength(0)
    })

    test("rebuilds the corpus rather than embedding against default weights", async () => {
      mockLoadByIds.mockResolvedValue(symbolRows)
      // No corpus rows for the snapshot.
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      mockLoadPage.mockResolvedValue({ rows: [], nextCursor: null })

      await semanticEngine.embedSymbolVersions(["sv-1"])

      // Writing plain-TF vectors into a table of TF-IDF vectors is not a
      // degraded result, it is an inconsistent one — so the full pass runs and
      // builds the corpus instead.
      expect(mockLoadPage).toHaveBeenCalled()
      expect(mockBatchInsert).not.toHaveBeenCalled()
    })

    test("embeds directly when the corpus is present", async () => {
      mockLoadByIds.mockResolvedValue(symbolRows)
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes("FROM idf_corpus")) {
          return Promise.resolve({ rows: ["name", "body", "signature", "behavior", "contract"].map(corpusRow) })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })

      const embedded = await semanticEngine.embedSymbolVersions(["sv-1", "sv-2", "sv-3"])

      expect(embedded).toBe(3)
      // The whole point of the fast path: it must not fall back to a full pass.
      expect(mockLoadPage).not.toHaveBeenCalled()
    })
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

  test("IDF vocabulary stays bounded when a snapshot floods it with distinct tokens", async () => {
    // The cap exists so attacker-controlled identifiers cannot make pass 1 hold
    // an unbounded map. Two symbols, each carrying more distinct body tokens
    // than the 50,000-entry cap allows, must still produce a stored corpus that
    // respects it — tokens past the cap fall back to computeTFIDF's default IDF.
    const flood = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`)

    mockLoadPage
      .mockResolvedValueOnce({
        rows: [
          { symbol_version_id: "sv-1", canonical_name: "a", body_source: flood("alpha_", 30_000).join(" "), signature: "" },
          { symbol_version_id: "sv-2", canonical_name: "b", body_source: flood("beta_", 30_000).join(" "), signature: "" },
        ],
        nextCursor: null,
      })
      .mockResolvedValue({ rows: [], nextCursor: null })

    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    await semanticEngine.batchEmbedSnapshot("snap-flood")

    const corpusWrites = mockQuery.mock.calls.filter((call) => String(call[0]).includes("INSERT INTO idf_corpus"))
    expect(corpusWrites.length).toBeGreaterThan(0)
    for (const call of corpusWrites) {
      const counts = JSON.parse(String(call[1]?.[4] ?? "{}")) as Record<string, number>
      expect(Object.keys(counts).length).toBeLessThanOrEqual(50_000)
    }
  })
})
