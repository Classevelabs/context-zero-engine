/**
 * Regression tests for session-scoped advisory locks.
 *
 * PostgreSQL advisory locks taken with pg_try_advisory_lock belong to the
 * session that took them. The engine previously took and released them through
 * db.query(), which runs on an arbitrary pooled client — so the unlock could
 * land on a different backend, return false, and leave the lock held for the
 * life of the original connection. Ingest and retention then silently no-op'd
 * forever ("already in progress").
 *
 * These tests pin the contract: one connection for the whole critical section.
 */

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
}

const mockPool = {
  connect: jest.fn(async () => mockClient),
  query: jest.fn(),
  waitingCount: 0,
  totalCount: 1,
  idleCount: 1,
  on: jest.fn(),
  end: jest.fn(),
}

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}))

jest.mock("../db-driver/config", () => ({
  getConnectionConfig: () => ({ host: "localhost", port: 5432, database: "test" }),
  getMigrationTimeoutConfig: () => ({ statementTimeoutMs: 1000 }),
}))

import { db } from "../db-driver"

describe("db.tryAdvisoryLock", () => {
  beforeEach(() => {
    mockClient.query.mockReset()
    mockClient.release.mockReset()
    mockPool.connect.mockClear()
  })

  test("acquires and releases on the SAME pooled connection", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] })
    mockClient.query.mockResolvedValueOnce({ rows: [{ released: true }] })

    const lock = await db.tryAdvisoryLock(4242)
    expect(lock).not.toBeNull()

    // Exactly one connection checked out, and it is still held mid-section.
    expect(mockPool.connect).toHaveBeenCalledTimes(1)
    expect(mockClient.release).not.toHaveBeenCalled()

    await lock!.release()

    // Both statements ran on the checked-out client, never on the pool.
    expect(mockClient.query).toHaveBeenCalledTimes(2)
    expect(mockClient.query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock")
    expect(mockClient.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock")
    expect(mockClient.query.mock.calls[0]?.[1]).toEqual([4242])
    expect(mockClient.query.mock.calls[1]?.[1]).toEqual([4242])
    expect(mockPool.query).not.toHaveBeenCalled()
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  test("returns null and frees the connection when the lock is already held", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: false }] })

    const lock = await db.tryAdvisoryLock(4242)

    expect(lock).toBeNull()
    // The connection must go back to the pool — otherwise a contended lock
    // would leak a connection on every attempt.
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  test("releases the connection even when acquisition throws", async () => {
    mockClient.query.mockRejectedValueOnce(new Error("connection reset"))

    await expect(db.tryAdvisoryLock(4242)).rejects.toThrow("connection reset")
    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })

  test("release() is idempotent and never double-releases the connection", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] })
    mockClient.query.mockResolvedValueOnce({ rows: [{ released: true }] })

    const lock = await db.tryAdvisoryLock(4242)
    await lock!.release()
    await lock!.release()

    expect(mockClient.release).toHaveBeenCalledTimes(1)
    expect(mockClient.query).toHaveBeenCalledTimes(2)
  })

  test("returns the connection to the pool even if the unlock statement fails", async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ acquired: true }] })
    mockClient.query.mockRejectedValueOnce(new Error("server went away"))

    const lock = await db.tryAdvisoryLock(4242)
    await expect(lock!.release()).resolves.toBeUndefined()

    expect(mockClient.release).toHaveBeenCalledTimes(1)
  })
})
