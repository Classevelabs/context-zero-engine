const mockQuery = jest.fn()
const mockResolveSymbol = jest.fn()
const mockSearchByQuery = jest.fn()

jest.mock("../db-driver", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}))
jest.mock("../services/symbol-service", () => ({
  resolveSymbol: (...args: unknown[]) => mockResolveSymbol(...args),
}))
jest.mock("../semantic-engine", () => ({
  semanticEngine: { searchByQuery: (...args: unknown[]) => mockSearchByQuery(...args) },
}))
jest.mock("../analysis-engine/blast-radius", () => ({
  blastRadiusEngine: {
    computeBlastRadius: jest.fn(async () => ({ total_impact_count: 0, recommended_validation_scope: "quick" })),
  },
}))
jest.mock("../analysis-engine/behavioral", () => ({ behavioralEngine: { getProfile: jest.fn(async () => null) } }))
jest.mock("../analysis-engine/contracts", () => ({ contractEngine: { getProfile: jest.fn(async () => null) } }))
jest.mock("../transactional-editor", () => ({ transactionalChangeEngine: {} }))
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    startTimer: jest.fn(() => jest.fn()),
  })),
}))

import { planChange, symbolMentionsInTask } from "../services/planning-service"

const symbol = (name: string, sim: number, version = `sv-${name}`) => ({
  symbol_id: `sym-${name}`,
  canonical_name: name,
  kind: "function",
  stable_key: `src/x.ts#${name}`,
  symbol_version_id: version,
  signature: "()",
  visibility: "public",
  file_path: "src/x.ts",
  name_sim: sim,
})

// planChange handed the whole task sentence to name similarity, so forty
// characters of English were compared against every symbol name and the
// candidates were whichever names shared the most trigrams with the prose.
describe("symbolMentionsInTask", () => {
  test("a quoted or backticked span comes first", () => {
    expect(symbolMentionsInTask("make `resolveSymbol` use the latest snapshot")[0]).toBe("resolveSymbol")
    expect(symbolMentionsInTask('fix the "retry helper" so it waits')[0]).toBe("retry helper")
  })

  test("code-shaped words are mentions whatever their length", () => {
    const mentions = symbolMentionsInTask("wire db.query into loadUser and set_flag")
    expect(mentions).toEqual(expect.arrayContaining(["db.query", "loadUser", "set_flag"]))
  })

  test("ordinary prose is not a mention", () => {
    const mentions = symbolMentionsInTask("please add a check before the return value and remove the old error")
    for (const word of ["please", "check", "before", "return", "value", "remove", "error"]) {
      expect(mentions).not.toContain(word)
    }
  })

  test("mentions are deduplicated, ordered by appearance, and bounded", () => {
    const task = "getUser getUser setUser " + Array.from({ length: 20 }, (_, i) => `helperFn${i}`).join(" ")
    const mentions = symbolMentionsInTask(task, 5)
    expect(mentions.slice(0, 2)).toEqual(["getUser", "setUser"])
    expect(mentions).toHaveLength(5)
  })
})

describe("planChange candidate resolution", () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
    mockResolveSymbol.mockReset()
    mockSearchByQuery.mockReset().mockResolvedValue([])
  })

  test("resolves each mentioned name on its own, never the whole sentence", async () => {
    mockResolveSymbol.mockImplementation(async (query: string) => ({
      symbols: query === "getUserById" ? [symbol("getUserById", 0.95)] : [],
      count: query === "getUserById" ? 1 : 0,
    }))

    const plan = await planChange({
      repo_id: "repo-1",
      snapshot_id: "snap-1",
      task_description: "add a retry to getUserById when the token expires",
    })

    const queries = mockResolveSymbol.mock.calls.map((call) => call[0] as string)
    expect(queries).toContain("getUserById")
    expect(queries).not.toContain("add a retry to getUserById when the token expires")
    expect(plan.target_candidates.map((c) => c.canonical_name)).toEqual(["getUserById"])
    expect(plan.assumptions[0]).toContain("names in the task")
  })

  test("keeps the best match per symbol version when several mentions hit it", async () => {
    mockResolveSymbol.mockImplementation(async (query: string) => ({
      symbols: [symbol("fetchToken", query === "fetchToken" ? 0.99 : 0.4, "sv-token")],
      count: 1,
    }))

    const plan = await planChange({
      repo_id: "repo-1",
      snapshot_id: "snap-1",
      task_description: "fetchToken should refresh the token",
    })

    expect(plan.target_candidates).toHaveLength(1)
    expect(plan.target_candidates[0]!.confidence).toBe(0.99)
  })

  test("falls back to semantic search over the task when no name resolves", async () => {
    mockResolveSymbol.mockResolvedValue({ symbols: [], count: 0 })
    mockSearchByQuery.mockResolvedValue([{ svId: "sv-retry", similarity: 0.42 }])
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("ANY($1::uuid[])")) {
        const { name_sim: _unused, ...row } = symbol("retryWithBackoff", 0, "sv-retry")
        return { rows: [row], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const plan = await planChange({
      repo_id: "repo-1",
      snapshot_id: "snap-1",
      task_description: "retry failed requests with backoff",
    })

    expect(mockSearchByQuery).toHaveBeenCalledWith("retry failed requests with backoff", "snap-1", expect.any(Number))
    expect(plan.target_candidates[0]!.canonical_name).toBe("retryWithBackoff")
    expect(plan.target_candidates[0]!.confidence).toBe(0.42)
    expect(plan.assumptions[0]).toContain("semantic search")
  })

  test("says so when neither names nor search find anything", async () => {
    mockResolveSymbol.mockResolvedValue({ symbols: [], count: 0 })

    await expect(
      planChange({ repo_id: "repo-1", snapshot_id: "snap-1", task_description: "tidy things up" }),
    ).rejects.toThrow("No symbol candidates found")
  })
})
