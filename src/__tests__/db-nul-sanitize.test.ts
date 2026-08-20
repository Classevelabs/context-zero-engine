/**
 * PostgreSQL `text` cannot hold 0x00. A source file containing one used to
 * abort the entire multi-row INSERT it landed in — one poison pill cost 686
 * files on this workspace and left the snapshot `partial`, which the
 * read guard then correctly refuses to answer from. The strip happens at the
 * driver because that is the single boundary every write crosses, so no future
 * extractor can reintroduce the failure.
 */
const NUL = String.fromCharCode(0)

const mockPoolQuery = jest.fn()
const mockClientQuery = jest.fn()

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: (...a: unknown[]) => mockPoolQuery(...a),
    on: jest.fn(),
    end: jest.fn(),
    waitingCount: 0,
    totalCount: 1,
    idleCount: 1,
  })),
}))

jest.mock("../db-driver/config", () => ({
  getConnectionConfig: () => ({
    host: "localhost",
    port: 5432,
    database: "t",
    user: "u",
    password: "p",
  }),
}))

import { db } from "../db-driver"

describe("db driver strips NUL bytes before binding", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it("removes NUL from a plain string parameter", async () => {
    await db.query("INSERT INTO t (a) VALUES ($1)", ["ab" + NUL + "cd"])
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe("abcd")
    expect(String(params[0]).includes(NUL)).toBe(false)
  })

  it("removes NUL from inside array parameters (text[] columns)", async () => {
    await db.query("INSERT INTO t (a) VALUES ($1)", [["x" + NUL + "y", "clean"]])
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toEqual(["xy", "clean"])
  })

  it("leaves clean parameters byte-identical and non-strings untouched", async () => {
    const arr = ["a", "b"]
    await db.query("SELECT $1, $2, $3", ["plain", 42, arr])
    const [, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe("plain")
    expect(params[1]).toBe(42)
    expect(params[2]).toEqual(arr)
  })

  it("passes undefined params through without throwing", async () => {
    await db.query("SELECT 1")
    expect(mockPoolQuery).toHaveBeenCalled()
  })

  it("covers the client path too, so transactional writes are protected", async () => {
    const client = { query: (...a: unknown[]) => mockClientQuery(...a) } as never
    await db.queryWithClient(client, "INSERT INTO t (a) VALUES ($1)", ["p" + NUL + "q"])
    const [, params] = mockClientQuery.mock.calls[0] as [string, unknown[]]
    expect(params[0]).toBe("pq")
  })
})
