/**
 * Unit tests for contract comparison logic, test-invariant scoping, and
 * invariant lookup ordering.
 */

const mockQuery = jest.fn()
const mockBatchInsert = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    batchInsert: (...args: unknown[]) => mockBatchInsert(...args),
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

import { ContractEngine } from "../analysis-engine/contracts"
import type { ContractProfile, SymbolVersionRow } from "../types"

const engine = new ContractEngine()

// A test asserts the behaviour of the symbols it exercises. The invariant was
// scoped to the test symbol itself, so the target never saw it and blast
// radius marked the test — not its target — critical.
describe("ContractEngine — test invariants are scoped to what the test exercises", () => {
  const row = (overrides: Partial<SymbolVersionRow>): SymbolVersionRow =>
    ({
      symbol_version_id: "sv-x",
      symbol_id: "sym-x",
      canonical_name: "x",
      kind: "function",
      file_path: "src/x.ts",
      body_source: "",
      signature: "",
      ...overrides,
    }) as unknown as SymbolVersionRow

  const testSv = row({ symbol_version_id: "sv-test", symbol_id: "sym-test", canonical_name: "returns the user", kind: "test_case", file_path: "src/user.test.ts" })
  const target = row({ symbol_version_id: "sv-fn", symbol_id: "sym-fn", canonical_name: "getUserById", file_path: "src/user.ts" })

  beforeEach(() => {
    mockQuery.mockReset()
    mockBatchInsert.mockReset().mockResolvedValue(undefined)
  })

  const invariantParams = (): unknown[][] => {
    const statements = (mockBatchInsert.mock.calls[0]?.[0] ?? []) as { text: string; params: unknown[] }[]
    return statements.filter((s) => s.text.includes("INSERT INTO invariants")).map((s) => s.params)
  }

  test("the invariant lands on the symbol the test reaches, named after both", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM structural_relations")) {
        return {
          rows: [{ test_sv: "sv-test", symbol_version_id: "sv-fn", symbol_id: "sym-fn", canonical_name: "getUserById" }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    await engine.mineInvariantsFromTests("repo-1", "snap-1", [testSv, target])

    const params = invariantParams().filter((p) => p[5] === "explicit_test")
    expect(params).toHaveLength(1)
    expect(params[0]![2]).toBe("sym-fn")
    expect(params[0]![4]).toBe("test:returns the user asserts behavior of getUserById")
    // Never on the test itself.
    expect(invariantParams().some((p) => p[2] === "sym-test")).toBe(false)
  })

  test("a test that reaches nothing in the graph asserts nothing the graph can attach", async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

    await engine.mineInvariantsFromTests("repo-1", "snap-1", [testSv, target])

    expect(invariantParams().filter((p) => p[5] === "explicit_test")).toHaveLength(0)
  })

  test("a test reaching another test does not stamp the other test", async () => {
    const otherTest = row({ symbol_version_id: "sv-test2", symbol_id: "sym-test2", canonical_name: "helper test", kind: "test_case", file_path: "src/user.test.ts" })
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM structural_relations")) {
        return {
          rows: [{ test_sv: "sv-test", symbol_version_id: "sv-test2", symbol_id: "sym-test2", canonical_name: "helper test" }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    await engine.mineInvariantsFromTests("repo-1", "snap-1", [testSv, otherTest])

    expect(invariantParams().filter((p) => p[5] === "explicit_test")).toHaveLength(0)
  })
})

describe("ContractEngine — getInvariantsForSymbol picks the newest snapshot by time", () => {
  test("orders candidate snapshots by created_at, not by their random ids", async () => {
    mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })

    await engine.getInvariantsForSymbol("sym-1")

    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain("JOIN snapshots snap ON snap.snapshot_id = i2.last_verified_snapshot_id")
    expect(sql).toContain("ORDER BY snap.created_at DESC")
    expect(sql).not.toContain("ORDER BY i2.last_verified_snapshot_id")
  })
})

describe("ContractEngine — compareContracts", () => {
  const makeProfile = (overrides: Partial<ContractProfile>): ContractProfile => ({
    contract_profile_id: "test",
    symbol_version_id: "test",
    input_contract: "(id: string)",
    output_contract: "User",
    error_contract: "NotFoundError",
    schema_refs: [],
    api_contract_refs: [],
    serialization_contract: "none",
    security_contract: "none",
    derived_invariants_count: 0,
    ...overrides,
  })

  test("identical contracts show no changes", () => {
    const a = makeProfile({})
    const b = makeProfile({})
    const result = engine.compareContracts(a, b)

    expect(result.inputChanged).toBe(false)
    expect(result.outputChanged).toBe(false)
    expect(result.errorChanged).toBe(false)
    expect(result.securityChanged).toBe(false)
    expect(result.serializationChanged).toBe(false)
  })

  test("detects input contract change", () => {
    const a = makeProfile({ input_contract: "(id: string)" })
    const b = makeProfile({ input_contract: "(id: string, name: string)" })
    const result = engine.compareContracts(a, b)

    expect(result.inputChanged).toBe(true)
    expect(result.outputChanged).toBe(false)
  })

  test("detects output contract change", () => {
    const a = makeProfile({ output_contract: "User" })
    const b = makeProfile({ output_contract: "User | null" })
    const result = engine.compareContracts(a, b)

    expect(result.outputChanged).toBe(true)
  })

  test("detects error contract change", () => {
    const a = makeProfile({ error_contract: "NotFoundError" })
    const b = makeProfile({ error_contract: "NotFoundError | TimeoutError" })
    const result = engine.compareContracts(a, b)

    expect(result.errorChanged).toBe(true)
  })

  test("detects security contract change", () => {
    const a = makeProfile({ security_contract: "@RequireAuth" })
    const b = makeProfile({ security_contract: "none" })
    const result = engine.compareContracts(a, b)

    expect(result.securityChanged).toBe(true)
  })

  test("detects serialization contract change", () => {
    const a = makeProfile({ serialization_contract: "@JsonSerialize" })
    const b = makeProfile({ serialization_contract: "@ProtobufSerialize" })
    const result = engine.compareContracts(a, b)

    expect(result.serializationChanged).toBe(true)
  })
})
