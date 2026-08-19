/**
 * ContextZero — Retention Service Tests
 *
 * Mock-based unit tests for all retention lifecycle functions.
 * Tests verify SQL correctness, advisory lock behavior, cascade logic,
 * error isolation between phases, and audit logging.
 */

const mockQuery = jest.fn()
const mockTryAdvisoryLock = jest.fn()
const mockAdvisoryRelease = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    tryAdvisoryLock: (...args: unknown[]) => mockTryAdvisoryLock(...args),
  },
}))

jest.mock("../config", () => ({
  retention: {
    snapshotMaxAgeDays: 90,
    maxSnapshotsPerRepo: 50,
    staleTransactionTimeoutMinutes: 60,
    stuckIndexingTimeoutMinutes: 180,
    orphanCleanupEnabled: true,
    retentionIntervalMinutes: 360,
    retentionEnabled: true,
  },
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

import {
  cleanupStuckIndexingSnapshots,
  cleanupExpiredSnapshots,
  enforceSnapshotCap,
  cleanupStaleTransactions,
  cleanupOrphanedData,
  runRetentionPolicy,
  getRetentionStats,
  listStaleTransactions,
} from "../services/retention-service"

beforeEach(() => {
  mockQuery.mockReset()
})

// ────────── cleanupExpiredSnapshots ──────────

describe("cleanupExpiredSnapshots", () => {
  it("stamps retained_until on unstamped snapshots then deletes expired", async () => {
    // First call: UPDATE retained_until
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 5 })
    // Second call: DELETE expired snapshots
    mockQuery.mockResolvedValueOnce({
      rows: [
        { snapshot_id: "s1", repo_id: "r1" },
        { snapshot_id: "s2", repo_id: "r1" },
      ],
      rowCount: 2,
    })
    // Third call: audit log INSERT
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const count = await cleanupExpiredSnapshots()

    expect(count).toBe(2)
    expect(mockQuery).toHaveBeenCalledTimes(3)
    // Verify first query stamps retained_until with age param
    expect(mockQuery.mock.calls[0][1]).toEqual([90])
    // Verify audit log was written
    expect(mockQuery.mock.calls[2][0]).toContain("INSERT INTO cleanup_log")
    expect(mockQuery.mock.calls[2][1]?.[0]).toBe("snapshot_expiry")
  })

  it("returns 0 and skips audit log when no snapshots expired", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const count = await cleanupExpiredSnapshots()

    expect(count).toBe(0)
    // No audit log INSERT (only 2 calls: stamp + delete)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})

// ────────── enforceSnapshotCap ──────────

describe("enforceSnapshotCap", () => {
  it("deletes snapshots beyond cap using ROW_NUMBER", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ snapshot_id: "s3", repo_id: "r1" }],
      rowCount: 1,
    })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const count = await enforceSnapshotCap()

    expect(count).toBe(1)
    // Should pass maxSnapshotsPerRepo as param
    expect(mockQuery.mock.calls[0][1]).toEqual([50])
  })
})

// ────────── cleanupStaleTransactions ──────────

describe("cleanupStaleTransactions", () => {
  it("marks stuck transactions as failed", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { txn_id: "t1", state: "prepared" },
        { txn_id: "t2", state: "patched" },
      ],
      rowCount: 2,
    })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const count = await cleanupStaleTransactions()

    expect(count).toBe(2)
    // Verify timeout param and terminal states passed
    const params = mockQuery.mock.calls[0][1] as unknown[]
    expect(params[0]).toBe(60) // timeout minutes
    expect(params).toContain("committed")
    expect(params).toContain("rolled_back")
    expect(params).toContain("failed")
  })
})

// ────────── cleanupOrphanedData ──────────

describe("cleanupOrphanedData", () => {
  it("cleans orphaned evidence bundles and terminal backups", async () => {
    // Evidence bundles DELETE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 })
    // Transaction file backups DELETE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 })
    // Audit log INSERT
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 })

    const count = await cleanupOrphanedData()

    expect(count).toBe(10)
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  it("returns 0 when no orphans found", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const count = await cleanupOrphanedData()

    expect(count).toBe(0)
    // No audit log (only 2 DELETE queries)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })
})

// ────────── runRetentionPolicy ──────────

describe("runRetentionPolicy", () => {
  // The advisory lock is taken through db.tryAdvisoryLock, which pins one pooled
  // connection for the whole run. Taking it through db.query() let the unlock
  // land on a different session, which left the lock held and silently disabled
  // retention for the life of that connection.
  beforeEach(() => {
    mockTryAdvisoryLock.mockReset()
    mockAdvisoryRelease.mockReset()
    mockAdvisoryRelease.mockResolvedValue(undefined)
    mockTryAdvisoryLock.mockResolvedValue({ release: mockAdvisoryRelease })
  })

  it("acquires advisory lock, runs all phases, releases lock", async () => {
    // Phase 0: cleanupStuckIndexingSnapshots
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 1: cleanupStaleTransactions
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 2: cleanupExpiredSnapshots (stamp + delete)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 3: enforceSnapshotCap
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 4: cleanupOrphanedData (2 queries)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const result = await runRetentionPolicy()

    expect(result.errors).toHaveLength(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // Lock taken on a pinned connection, and released exactly once.
    expect(mockTryAdvisoryLock).toHaveBeenCalledTimes(1)
    expect(mockAdvisoryRelease).toHaveBeenCalledTimes(1)
    // It must not be routed through the shared pool query path.
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).not.toContain("advisory")
    }
  })

  it("returns early if lock not acquired", async () => {
    mockTryAdvisoryLock.mockResolvedValue(null)

    const result = await runRetentionPolicy()

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("Lock not acquired")
    // No phase ran, and there is no lock to release.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockAdvisoryRelease).not.toHaveBeenCalled()
  })

  it("isolates phase errors — failure in one does not abort others", async () => {
    // Phase 0: stuck-indexing reap succeeds
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 1: stale cleanup FAILS
    mockQuery.mockRejectedValueOnce(new Error("DB timeout"))

    // Phase 2: snapshot expiry succeeds (stamp + delete)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 3: snapshot cap succeeds
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    // Phase 4: orphan cleanup succeeds
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const result = await runRetentionPolicy()

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("stale_transactions")
    // A failing phase must still release the lock — otherwise one bad run
    // disables retention permanently.
    expect(mockAdvisoryRelease).toHaveBeenCalledTimes(1)
  })
})

// ────────── getRetentionStats ──────────

describe("getRetentionStats", () => {
  it("aggregates stats from parallel queries", async () => {
    // Snapshot stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: 42, expired: 3, oldest: "2025-01-01T00:00:00Z" }],
      rowCount: 1,
    })
    // Stale transaction count
    mockQuery.mockResolvedValueOnce({
      rows: [{ stale: 2 }],
      rowCount: 1,
    })
    // Last cleanup
    mockQuery.mockResolvedValueOnce({
      rows: [{ last_run: "2026-03-30T10:00:00Z", details: { foo: 1 } }],
      rowCount: 1,
    })

    const stats = await getRetentionStats()

    expect(stats.totalSnapshots).toBe(42)
    expect(stats.expiredSnapshots).toBe(3)
    expect(stats.staleTransactions).toBe(2)
    expect(stats.oldestSnapshotAge).toBe("2025-01-01T00:00:00Z")
    expect(stats.lastCleanupAt).toBe("2026-03-30T10:00:00Z")
  })

  it("handles empty results gracefully", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const stats = await getRetentionStats()

    expect(stats.totalSnapshots).toBe(0)
    expect(stats.lastCleanupAt).toBeNull()
  })
})

// ────────── listStaleTransactions ──────────

describe("listStaleTransactions", () => {
  it("returns stale transactions ordered by age", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { txn_id: "t1", state: "prepared", updated_at: "2026-03-30T08:00:00Z", age_minutes: 120 },
        { txn_id: "t2", state: "patched", updated_at: "2026-03-30T09:00:00Z", age_minutes: 60 },
      ],
      rowCount: 2,
    })

    const stale = await listStaleTransactions()

    expect(stale).toHaveLength(2)
    expect(stale[0].txn_id).toBe("t1")
    expect(stale[0].age_minutes).toBe(120)
  })

  it("respects limit parameter", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ txn_id: "t1", state: "planned", updated_at: "2026-03-30", age_minutes: 90 }],
      rowCount: 1,
    })

    await listStaleTransactions(5)

    expect(mockQuery.mock.calls[0][1]?.[1]).toBe(5)
  })
})

/**
 * A snapshot abandoned mid-ingest must not stay unreadable forever.
 *
 * An ingest killed by sleep, OOM or Ctrl-C leaves its snapshot at 'indexing'
 * with no process left to advance it. Nothing reaped that state, and the read
 * guard correctly refuses to answer from a snapshot that claims to still be
 * building — so the repository became permanently unreadable, with the only
 * signal being a status nobody inspects.
 */
describe("cleanupStuckIndexingSnapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("marks snapshots stuck in 'indexing' past the timeout as failed", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ snapshot_id: "s1" }, { snapshot_id: "s2" }], rowCount: 2 })

    const reaped = await cleanupStuckIndexingSnapshots()

    expect(reaped).toBe(2)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("UPDATE snapshots")
    // 'failed', not deleted: the row is evidence an ingest was attempted, and
    // the read guard turns 'failed' into an actionable error. Deleting would
    // return the caller to a silent "no data".
    expect(sql).toContain("index_status = 'failed'")
    expect(sql).toContain("index_status = 'indexing'")
    // Age-bounded, so a long-running but live ingest is never reaped.
    expect(sql).toContain("created_at <")
    expect(params).toEqual([180])
  })

  it("never touches complete, partial or failed snapshots", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await cleanupStuckIndexingSnapshots()
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain("WHERE index_status = 'indexing'")
    expect(sql).not.toContain("'complete'")
    expect(sql).not.toContain("'partial'")
  })

  it("is disabled by a non-positive timeout and issues no query", async () => {
    const { retention } = jest.requireMock("../config") as { retention: Record<string, number> }
    const original = retention["stuckIndexingTimeoutMinutes"]
    retention["stuckIndexingTimeoutMinutes"] = 0
    try {
      expect(await cleanupStuckIndexingSnapshots()).toBe(0)
      expect(mockQuery).not.toHaveBeenCalled()
    } finally {
      retention["stuckIndexingTimeoutMinutes"] = original
    }
  })
})
