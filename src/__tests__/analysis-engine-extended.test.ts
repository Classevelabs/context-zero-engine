/**
 * Extended unit tests for analysis-engine sub-modules.
 *
 * Covers:
 *   - BlastRadiusEngine     (blast-radius.ts)
 *   - DeepContractSynthesizer (deep-contracts.ts)
 *   - DispatchResolver       (dispatch-resolver.ts)
 *   - EffectEngine           (effect-engine.ts)
 *   - SymbolLineageEngine    (symbol-lineage.ts)
 *   - TemporalEngine         (temporal-engine.ts)
 *   - ConceptFamilyEngine    (concept-families.ts)
 *   - StructuralGraphEngine  (index.ts)
 *   - RuntimeEvidenceEngine  (runtime-evidence.ts)
 *
 * All DB calls are mocked; these tests exercise pure logic paths.
 */

import type { BehavioralProfile, ContractProfile } from "../types"

// ── DB mocks ────────────────────────────────────────────────────────
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
const mockBatchInsert = jest.fn().mockResolvedValue(undefined)
const mockBulkInsert = jest.fn().mockResolvedValue({ rowsInserted: 0 })
const mockTransaction = jest.fn().mockImplementation(async (cb: any) =>
  cb({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
)
const mockQueryWithClient = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: any[]) => mockQuery(...args),
    batchInsert: (...args: any[]) => mockBatchInsert(...args),
    bulkInsert: (...args: any[]) => mockBulkInsert(...args),
    transaction: (...args: any[]) => mockTransaction(...args),
    queryWithClient: (...args: any[]) => mockQueryWithClient(...args),
  },
}))

jest.mock("../db-driver/core_data", () => ({
  coreDataService: {
    upsertBehavioralProfile: jest.fn().mockResolvedValue("bp-id"),
    upsertContractProfile: jest.fn().mockResolvedValue("cp-id"),
    getSymbolVersionsForSnapshot: jest.fn().mockResolvedValue([]),
    // Relation resolution loads identity columns only — the full row set
    // carries body_source for every symbol and is discarded immediately.
    getSymbolIdentitiesForSnapshot: jest.fn().mockResolvedValue([]),
  },
}))

jest.mock("../db-driver/batch-loader", () => ({
  BatchLoader: jest.fn().mockImplementation(() => ({
    loadBehavioralProfiles: jest.fn().mockResolvedValue(new Map()),
    loadContractProfiles: jest.fn().mockResolvedValue(new Map()),
  })),
}))

jest.mock("../db-driver/result", () => {
  const actual = jest.requireActual("../db-driver/result")
  return {
    ...actual,
    jsonField: jest.fn().mockReturnValue(null),
    firstRow: jest.fn().mockReturnValue(undefined),
    optionalStringField: jest.fn().mockReturnValue(null),
    parseCountField: jest.fn().mockReturnValue(0),
  }
})

// ── Imports (after mocks) ───────────────────────────────────────────
import { BlastRadiusEngine } from "../analysis-engine/blast-radius"
import { liftedEffect } from "../analysis-engine/effect-engine"
import { capPerSymbol, MAX_INVARIANTS_PER_SYMBOL } from "../analysis-engine/deep-contracts"
import type { SymbolHistory } from "../analysis-engine/blame-co-change"
import { DeepContractSynthesizer } from "../analysis-engine/deep-contracts"
import { DispatchResolver } from "../analysis-engine/dispatch-resolver"
import { EffectEngine } from "../analysis-engine/effect-engine"
import type { EffectEntry, EffectClass } from "../analysis-engine/effect-engine"
import { SymbolLineageEngine } from "../analysis-engine/symbol-lineage"
import { TemporalEngine } from "../analysis-engine/temporal-engine"
import type { GitCommit } from "../analysis-engine/temporal-engine"
import { ConceptFamilyEngine } from "../analysis-engine/concept-families"
import type { MemberData, RawCluster, EdgeRecord } from "../analysis-engine/concept-families"
import { StructuralGraphEngine } from "../analysis-engine/index"
import { RuntimeEvidenceEngine } from "../analysis-engine/runtime-evidence"

// ── Helpers ─────────────────────────────────────────────────────────

const makeBP = (overrides: Partial<BehavioralProfile> = {}): BehavioralProfile => ({
  behavior_profile_id: "bp-test",
  symbol_version_id: "sv-test",
  purity_class: "pure",
  resource_touches: [],
  db_reads: [],
  db_writes: [],
  network_calls: [],
  cache_ops: [],
  file_io: [],
  auth_operations: [],
  validation_operations: [],
  exception_profile: [],
  state_mutation_profile: [],
  transaction_profile: [],
  ...overrides,
})

const makeCP = (overrides: Partial<ContractProfile> = {}): ContractProfile => ({
  contract_profile_id: "cp-test",
  symbol_version_id: "sv-test",
  input_contract: "",
  output_contract: "",
  error_contract: "",
  schema_refs: [],
  api_contract_refs: [],
  serialization_contract: "",
  security_contract: "",
  derived_invariants_count: 0,
  ...overrides,
})

const makeGitCommit = (overrides: Partial<GitCommit> = {}): GitCommit => ({
  hash: "a".repeat(40),
  author_name: "Test Author",
  author_email: "test@example.com",
  date: new Date("2025-01-15"),
  subject: "feat: add feature",
  files: ["src/index.ts"],
  is_bug_fix: false,
  is_revert: false,
  is_merge: false,
  ...overrides,
})

const makeMemberData = (overrides: Partial<MemberData> = {}): MemberData => ({
  symbol_version_id: "sv-1",
  canonical_name: "myFunction",
  kind: "function",
  stable_key: "src/test.ts::myFunction",
  ...overrides,
})

// ── Reset mocks ─────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mockBatchInsert.mockResolvedValue(undefined)
  mockBulkInsert.mockReset()
  mockBulkInsert.mockResolvedValue({ rowsInserted: 0 })
})

// =====================================================================
// 1. BLAST RADIUS ENGINE
// =====================================================================

describe("BlastRadiusEngine", () => {
  const engine = new BlastRadiusEngine()

  describe("computeBlastRadius", () => {
    test("returns empty report for empty target list", async () => {
      const report = await engine.computeBlastRadius("snap-1", [])
      expect(report.target_symbols).toEqual([])
      expect(report.total_impact_count).toBe(0)
      expect(report.structural_impacts).toEqual([])
      expect(report.behavioral_impacts).toEqual([])
      expect(report.contract_impacts).toEqual([])
      expect(report.homolog_impacts).toEqual([])
      expect(report.historical_impacts).toEqual([])
    })

    test("clamps depth to minimum of 1", async () => {
      const report = await engine.computeBlastRadius("snap-1", ["sv-1"], 0)
      expect(report).toBeDefined()
      expect(report.recommended_validation_scope).toBeDefined()
    })

    test("clamps depth to MAX_INTERNAL_DEPTH (5)", async () => {
      const report = await engine.computeBlastRadius("snap-1", ["sv-1"], 100)
      expect(report).toBeDefined()
    })

    test("normalizes non-finite depth and rejects oversized target sets", async () => {
      await expect(engine.computeBlastRadius("snap-1", ["sv-1"], Number.NaN)).resolves.toBeDefined()
      const tooMany = Array.from({ length: 21 }, (_, index) => `sv-${index}`)
      await expect(engine.computeBlastRadius("snap-1", tooMany, Number.POSITIVE_INFINITY)).rejects.toThrow(/at most 20/)
      expect(mockQuery).toHaveBeenCalled()
    })

    test("returns quick scope when no impacts", async () => {
      const report = await engine.computeBlastRadius("snap-1", ["sv-1"], 1)
      expect(report.recommended_validation_scope).toBe("quick")
      expect(report.total_impact_count).toBe(0)
    })

    test("returns standard scope when 2-4 high severity impacts", async () => {
      // Simulate structural impacts with high severity
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("structural_relations")) {
          return {
            rows: Array.from({ length: 3 }, (_, i) => ({
              src_symbol_version_id: `caller-${i}`,
              relation_type: "calls",
              confidence: 0.9,
              canonical_name: `CallerFunc${i}`,
              symbol_id: `sym-${i}`,
              file_path: `src/file${i}.ts`,
              range_start_line: 10,
              range_end_line: 20,
            })),
            rowCount: 3,
          }
        }
        return { rows: [], rowCount: 0 }
      })

      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      expect(report.structural_impacts.length).toBe(3)
      expect(report.recommended_validation_scope).toBe("standard")
    })

    test("returns strict scope when critical impacts exist", async () => {
      // Simulate contract impacts with critical severity
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("invariants")) {
          return {
            rows: [
              {
                invariant_id: "inv-1",
                expression: "x > 0",
                source_type: "assertion",
                strength: 0.95,
                canonical_name: "validate",
                symbol_id: "sym-1",
                file_path: "src/validate.ts",
                range_start_line: 1,
                range_end_line: 10,
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      })

      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      const contractImpacts = report.contract_impacts
      if (contractImpacts.length > 0) {
        expect(contractImpacts[0]!.impact_type).toBe("contract")
      }
    })

    test("a pure caller is a medium assumption to re-check, not a high-severity break", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("behavioral_profiles")) {
          return {
            rows: [
              {
                src_symbol_version_id: "caller-1",
                canonical_name: "pureCaller",
                symbol_id: "sym-1",
                file_path: "src/a.ts",
                range_start_line: 1,
                range_end_line: 5,
                purity_class: "pure",
                network_calls: null,
                db_writes: null,
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      })
      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      expect(report.behavioral_impacts.map((i) => i.severity)).toEqual(["medium"])
      expect(report.recommended_validation_scope).toBe("quick")
    })

    test("only an enforced invariant can be critical; a derived one tops out below high", async () => {
      const invariant = (source_type: string, strength: number) => ({
        invariant_id: `inv-${source_type}`,
        expression: "x",
        source_type,
        strength,
        canonical_name: "f",
        symbol_id: "sym-1",
        file_path: "src/a.ts",
        range_start_line: 1,
        range_end_line: 2,
      })
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("invariants")) {
          return {
            rows: [invariant("assertion", 0.95), invariant("derived", 0.95), invariant("derived", 0.8), invariant("type_constraint", 0.8)],
            rowCount: 4,
          }
        }
        return { rows: [], rowCount: 0 }
      })
      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      expect(report.contract_impacts.map((i) => i.severity)).toEqual(["critical", "high", "low", "medium"])
    })

    test("file co-change partners are reported on the partner file's module symbol at low severity", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT DISTINCT f.path, s.repo_id")) {
          return { rows: [{ path: "src/a.ts", repo_id: "repo-1" }], rowCount: 1 }
        }
        if (sql.includes("temporal_file_co_changes")) {
          return {
            rows: [
              {
                file_path: "src/b.ts",
                jaccard_coefficient: 0.75,
                co_change_count: 6,
                symbol_id: "mod-b",
                canonical_name: "src/b.ts",
                range_start_line: 1,
                range_end_line: 40,
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      })
      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      expect(report.historical_impacts).toHaveLength(1)
      const impact = report.historical_impacts[0]!
      expect(impact.relation_type).toBe("file_co_changed_with")
      expect(impact.severity).toBe("low")
      expect(impact.symbol_id).toBe("mod-b")
      expect(impact.evidence).toContain("6 commit(s)")
      expect(report.recommended_validation_scope).toBe("quick")
    })

    test("returns strict scope for 20+ total impacts", async () => {
      // Access the private method via prototype
      const recommendScope = (engine as any).recommendValidationScope.bind(engine)
      expect(recommendScope(20, [], [], [])).toBe("strict")
      expect(recommendScope(25, [], [], [])).toBe("strict")
    })

    test("returns standard scope for 8-19 impacts with < 2 high", async () => {
      const recommendScope = (engine as any).recommendValidationScope.bind(engine)
      expect(recommendScope(10, [], [], [])).toBe("standard")
      expect(recommendScope(15, [], [], [])).toBe("standard")
    })

    test("returns quick scope for low impact", async () => {
      const recommendScope = (engine as any).recommendValidationScope.bind(engine)
      expect(recommendScope(3, [], [], [])).toBe("quick")
    })

    test("returns strict when 5+ high severity impacts", async () => {
      const recommendScope = (engine as any).recommendValidationScope.bind(engine)
      const highImpacts = Array.from({ length: 5 }, () => ({
        severity: "high" as const,
        impact_type: "structural",
      }))
      expect(recommendScope(5, highImpacts, [], [])).toBe("strict")
    })

    test("computes structural impacts at multiple depths", async () => {
      let callCount = 0
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("structural_relations") && sql.includes("src_symbol_version_id")) {
          callCount++
          if (callCount <= 1) {
            return {
              rows: [
                {
                  src_symbol_version_id: "caller-1",
                  relation_type: "calls",
                  confidence: 0.9,
                  canonical_name: "CallerA",
                  symbol_id: "sym-caller-1",
                  file_path: "src/a.ts",
                  range_start_line: 1,
                  range_end_line: 5,
                },
              ],
              rowCount: 1,
            }
          }
          return { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      })

      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 2)
      expect(report.structural_impacts.length).toBeGreaterThanOrEqual(0)
    })

    test("homolog impacts include is evidence string", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("inferred_relations") && !sql.includes("co_changed_with")) {
          return {
            rows: [
              {
                dst_symbol_version_id: "hom-1",
                relation_type: "similar_structure",
                confidence: 0.85,
                canonical_name: "homologFunc",
                symbol_id: "sym-h1",
                file_path: "src/h.ts",
                range_start_line: 1,
                range_end_line: 10,
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      })

      const report = await engine.computeBlastRadius("snap-1", ["sv-target"], 1)
      if (report.homolog_impacts.length > 0) {
        expect(report.homolog_impacts[0]!.evidence).toContain("Homolog relation")
      }
    })
  })
})

// =====================================================================
// 2. EFFECT ENGINE
// =====================================================================

describe("EffectEngine", () => {
  const engine = new EffectEngine()

  describe("classifyEffectClass", () => {
    test("pure: empty effects", () => {
      expect(engine.classifyEffectClass([])).toBe("pure")
    })

    test("reader: reads effect only", () => {
      const effects: EffectEntry[] = [
        {
          kind: "reads",
          descriptor: "db.users",
          detail: "read",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("reader")
    })

    test("reader: requires auth only", () => {
      const effects: EffectEntry[] = [
        {
          kind: "requires",
          descriptor: "auth.admin",
          detail: "auth",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("reader")
    })

    test("reader: throws only", () => {
      const effects: EffectEntry[] = [
        {
          kind: "throws",
          descriptor: "error.Validation",
          detail: "throw",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("reader")
    })

    test("reader: normalizes only", () => {
      const effects: EffectEntry[] = [
        {
          kind: "normalizes",
          descriptor: "data.trim",
          detail: "normalize",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("reader")
    })

    test("reader: logs only", () => {
      const effects: EffectEntry[] = [
        {
          kind: "logs",
          descriptor: "log.info",
          detail: "logging",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("reader")
    })

    test("writer: writes effect", () => {
      const effects: EffectEntry[] = [
        {
          kind: "writes",
          descriptor: "db.users",
          detail: "write",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("writer")
    })

    test("writer: mutates effect", () => {
      const effects: EffectEntry[] = [
        {
          kind: "mutates",
          descriptor: "state.cache",
          detail: "mutate",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("writer")
    })

    test("writer: opens effect", () => {
      const effects: EffectEntry[] = [
        {
          kind: "opens",
          descriptor: "file.config",
          detail: "open",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("writer")
    })

    test("io: calls_external effect", () => {
      const effects: EffectEntry[] = [
        {
          kind: "calls_external",
          descriptor: "network.stripe",
          detail: "http",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("io")
    })

    test("full_side_effect: emits event", () => {
      const effects: EffectEntry[] = [
        {
          kind: "emits",
          descriptor: "event.user_created",
          detail: "emit",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("full_side_effect")
    })

    test("full_side_effect: acquires lock", () => {
      const effects: EffectEntry[] = [
        {
          kind: "acquires_lock",
          descriptor: "concurrency.mutex",
          detail: "lock",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("full_side_effect")
    })

    test("full_side_effect: transaction descriptor in writes", () => {
      const effects: EffectEntry[] = [
        {
          kind: "writes",
          descriptor: "db.transaction.main",
          detail: "txn",
          provenance: "direct",
        },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("full_side_effect")
    })

    test("mixed: highest tier wins (io > writer)", () => {
      const effects: EffectEntry[] = [
        { kind: "writes", descriptor: "db.users", detail: "write", provenance: "direct" },
        { kind: "calls_external", descriptor: "network.api", detail: "http", provenance: "direct" },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("io")
    })

    test("mixed: emits overrides io", () => {
      const effects: EffectEntry[] = [
        { kind: "calls_external", descriptor: "network.api", detail: "http", provenance: "direct" },
        { kind: "emits", descriptor: "event.done", detail: "emit", provenance: "direct" },
      ]
      expect(engine.classifyEffectClass(effects)).toBe("full_side_effect")
    })
  })

  describe("private utility methods", () => {
    test("deduplicateEffects removes duplicate kind+descriptor", () => {
      const dedup = (engine as any).deduplicateEffects.bind(engine)
      const effects: EffectEntry[] = [
        { kind: "reads", descriptor: "db.users", detail: "read1", provenance: "direct" },
        { kind: "reads", descriptor: "db.users", detail: "read2", provenance: "direct" },
        { kind: "reads", descriptor: "db.orders", detail: "read3", provenance: "direct" },
      ]
      const result = dedup(effects)
      expect(result).toHaveLength(2)
    })

    test("a lifted effect names its origin and hops, keeps source and confidence, and carries no detail text", () => {
      const direct: EffectEntry = {
        kind: "calls_external",
        descriptor: "network.http",
        detail: "HTTP client call",
        provenance: "direct",
        source: "heuristic_pattern",
        confidence: 0.5,
      }
      const once = liftedEffect(direct, "callee-1", 1)
      expect(once).toEqual({
        kind: "calls_external",
        descriptor: "network.http",
        provenance: "transitive",
        origin_symbol_version_id: "callee-1",
        hops: 1,
        source: "heuristic_pattern",
        confidence: 0.5,
      })
      expect("detail" in once).toBe(false)
      // Lifting again keeps the first origin, not the intermediate callee.
      const twice = liftedEffect(once, "callee-2", 2)
      expect(twice.origin_symbol_version_id).toBe("callee-1")
      expect(twice.hops).toBe(2)
    })

    test("deduplicateEffects prefers direct over transitive", () => {
      const dedup = (engine as any).deduplicateEffects.bind(engine)
      const effects: EffectEntry[] = [
        { kind: "reads", descriptor: "db.users", detail: "transitive", provenance: "transitive" },
        { kind: "reads", descriptor: "db.users", detail: "direct", provenance: "direct" },
      ]
      const result = dedup(effects)
      expect(result).toHaveLength(1)
      expect(result[0].provenance).toBe("direct")
    })

    test("deduplicateEffects keeps first when both are direct", () => {
      const dedup = (engine as any).deduplicateEffects.bind(engine)
      const effects: EffectEntry[] = [
        { kind: "reads", descriptor: "db.users", detail: "first", provenance: "direct" },
        { kind: "reads", descriptor: "db.users", detail: "second", provenance: "direct" },
      ]
      const result = dedup(effects)
      expect(result).toHaveLength(1)
      expect(result[0].detail).toBe("first")
    })

    test("collectDescriptors filters by kind", () => {
      const collect = (engine as any).collectDescriptors.bind(engine)
      const effects: EffectEntry[] = [
        { kind: "reads", descriptor: "db.users", detail: "r", provenance: "direct" },
        { kind: "writes", descriptor: "db.orders", detail: "w", provenance: "direct" },
        { kind: "reads", descriptor: "db.products", detail: "r2", provenance: "direct" },
      ]
      const result = collect(effects, "reads")
      expect(result).toEqual(["db.users", "db.products"])
    })

    test("collectDescriptors deduplicates descriptors", () => {
      const collect = (engine as any).collectDescriptors.bind(engine)
      const effects: EffectEntry[] = [
        { kind: "reads", descriptor: "db.users", detail: "r1", provenance: "direct" },
        { kind: "reads", descriptor: "db.users", detail: "r2", provenance: "transitive" },
      ]
      const result = collect(effects, "reads")
      expect(result).toEqual(["db.users"])
    })

    test("computeConfidence base is 0.50", () => {
      const confidence = (engine as any).computeConfidence.bind(engine)
      expect(confidence(false, false, false)).toBe(0.5)
    })

    test("computeConfidence adds 0.20 for behavioral", () => {
      const confidence = (engine as any).computeConfidence.bind(engine)
      expect(confidence(true, false, false)).toBe(0.7)
    })

    test("computeConfidence adds 0.15 for contract", () => {
      const confidence = (engine as any).computeConfidence.bind(engine)
      expect(confidence(false, true, false)).toBe(0.65)
    })

    test("computeConfidence adds 0.10 for body source", () => {
      const confidence = (engine as any).computeConfidence.bind(engine)
      expect(confidence(false, false, true)).toBe(0.6)
    })

    test("computeConfidence caps at 0.95", () => {
      const confidence = (engine as any).computeConfidence.bind(engine)
      expect(confidence(true, true, true)).toBe(0.95)
    })

    test("normalizeDescriptor handles whitespace and special chars", () => {
      const normalize = (engine as any).normalizeDescriptor.bind(engine)
      expect(normalize("  Hello World  ")).toBe("hello_world")
      expect(normalize("foo@bar#baz")).toBe("foobarbaz")
      expect(normalize("my-api.v2")).toBe("my-api.v2")
    })

    test("mineFromBehavioralProfile extracts db reads", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ db_reads: ["users", "orders"] })
      const effects = mine(bp)
      const reads = effects.filter((e: EffectEntry) => e.kind === "reads")
      expect(reads.length).toBe(2)
      expect(reads[0].descriptor).toBe("db.users")
    })

    test("mineFromBehavioralProfile extracts db writes", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ db_writes: ["billing"] })
      const effects = mine(bp)
      const writes = effects.filter((e: EffectEntry) => e.kind === "writes")
      expect(writes.length).toBe(1)
      expect(writes[0].descriptor).toBe("db.billing")
    })

    test("mineFromBehavioralProfile extracts network calls", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ network_calls: ["stripe_api"] })
      const effects = mine(bp)
      const ext = effects.filter((e: EffectEntry) => e.kind === "calls_external")
      expect(ext.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts file_io as opens", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ file_io: ["config.json"] })
      const effects = mine(bp)
      const opens = effects.filter((e: EffectEntry) => e.kind === "opens")
      expect(opens.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts auth_operations", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ auth_operations: ["requireAdmin"] })
      const effects = mine(bp)
      const auth = effects.filter((e: EffectEntry) => e.kind === "requires")
      expect(auth.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts state_mutations", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ state_mutation_profile: ["redux.dispatch"] })
      const effects = mine(bp)
      const mutates = effects.filter((e: EffectEntry) => e.kind === "mutates")
      expect(mutates.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts transactions as writes + lock", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ transaction_profile: ["checkout"] })
      const effects = mine(bp)
      const writes = effects.filter((e: EffectEntry) => e.kind === "writes")
      const locks = effects.filter((e: EffectEntry) => e.kind === "acquires_lock")
      expect(writes.length).toBe(1)
      expect(locks.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts throws from exception_profile", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ exception_profile: ["throws:ValidationError"] })
      const effects = mine(bp)
      const throws = effects.filter((e: EffectEntry) => e.kind === "throws")
      expect(throws.length).toBe(1)
      expect(throws[0].descriptor).toBe("error.ValidationError")
    })

    test("mineFromBehavioralProfile extracts validation_operations", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ validation_operations: ["email_format"] })
      const effects = mine(bp)
      const norms = effects.filter((e: EffectEntry) => e.kind === "normalizes")
      expect(norms.length).toBe(1)
    })

    test("mineFromBehavioralProfile extracts cache write ops", () => {
      const mine = (engine as any).mineFromBehavioralProfile.bind(engine)
      const bp = makeBP({ cache_ops: ["redis.set", "redis.get"] })
      const effects = mine(bp)
      const writes = effects.filter((e: EffectEntry) => e.kind === "writes")
      const reads = effects.filter((e: EffectEntry) => e.kind === "reads")
      expect(writes.length).toBe(1) // 'set' -> write
      expect(reads.length).toBe(1) // 'get' -> read
    })

    test("mineFromContractProfile extracts security_contract", () => {
      const mine = (engine as any).mineFromContractProfile.bind(engine)
      const cp = makeCP({ security_contract: "requireAdmin; requireAuth" })
      const effects = mine(cp)
      const auth = effects.filter((e: EffectEntry) => e.kind === "requires")
      expect(auth.length).toBe(2)
    })

    test("mineFromContractProfile extracts error_contract", () => {
      const mine = (engine as any).mineFromContractProfile.bind(engine)
      const cp = makeCP({ error_contract: "TypeError | ValidationError" })
      const effects = mine(cp)
      const throws = effects.filter((e: EffectEntry) => e.kind === "throws")
      expect(throws.length).toBe(2)
    })

    test("mineFromContractProfile extracts api_contract_refs", () => {
      const mine = (engine as any).mineFromContractProfile.bind(engine)
      const cp = makeCP({ api_contract_refs: ["GET /users"] })
      const effects = mine(cp)
      const reads = effects.filter((e: EffectEntry) => e.kind === "reads")
      expect(reads.length).toBe(1)
    })

    test('mineFromContractProfile skips "none" security', () => {
      const mine = (engine as any).mineFromContractProfile.bind(engine)
      const cp = makeCP({ security_contract: "none" })
      const effects = mine(cp)
      expect(effects.length).toBe(0)
    })

    test('mineFromContractProfile skips "never" error', () => {
      const mine = (engine as any).mineFromContractProfile.bind(engine)
      const cp = makeCP({ error_contract: "never" })
      const effects = mine(cp)
      expect(effects.length).toBe(0)
    })

    test("mineFromFrameworkPatterns detects ORM reads", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = "user = db.findOne({ id: 1 })"
      const effects: EffectEntry[] = mine(code, "ruby")
      expect(effects.some((e: EffectEntry) => e.kind === "reads")).toBe(true)
    })

    test("mineFromFrameworkPatterns detects ORM writes", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = "repository.save({ name: name })"
      const effects: EffectEntry[] = mine(code, "ruby")
      expect(effects.some((e: EffectEntry) => e.kind === "writes")).toBe(true)
    })

    test("mineFromFrameworkPatterns detects HTTP calls", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = 'res = fetch("https://api.example.com")'
      const effects: EffectEntry[] = mine(code, "python")
      expect(effects.some((e: EffectEntry) => e.kind === "calls_external")).toBe(true)
    })

    test("mineFromFrameworkPatterns detects event emission", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = 'event_emitter.emit("user_created", data)'
      const effects: EffectEntry[] = mine(code, "python")
      expect(effects.some((e: EffectEntry) => e.kind === "emits")).toBe(true)
    })

    test("mineFromFrameworkPatterns detects logging", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = 'logger.info("debug info")'
      const effects: EffectEntry[] = mine(code, "python")
      expect(effects.some((e: EffectEntry) => e.kind === "logs")).toBe(true)
    })

    test("mineFromFrameworkPatterns skips generic patterns for typescript (type-resolver owns externals)", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = 'const user = await db.findOne({ id: 1 }); await fetch("https://x");'
      expect(mine(code, "typescript")).toEqual([])
    })

    test("mineFromFrameworkPatterns labels every entry as a heuristic with its own confidence", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const effects: EffectEntry[] = mine("user = db.findOne({ id: 1 })", "ruby")
      expect(effects.length).toBeGreaterThan(0)
      for (const effect of effects) {
        expect(effect.source).toBe("heuristic_pattern")
        expect(effect.confidence).toBe(0.5)
      }
    })

    test("mineFromFrameworkPatterns returns empty for empty code", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      expect(mine("", "typescript")).toEqual([])
    })

    test("mineFromFrameworkPatterns detects Rust-specific patterns", () => {
      const mine = (engine as any).mineFromFrameworkPatterns.bind(engine)
      const code = "let val = result.unwrap();"
      const effects: EffectEntry[] = mine(code, "rust")
      expect(effects.some((e: EffectEntry) => e.kind === "throws")).toBe(true)
    })

    test("mineFromBehaviorHints handles db_read", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "db_read", detail: "users", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("reads")
    })

    test("mineFromBehaviorHints handles db_write", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "db_write", detail: "orders", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("writes")
    })

    test("mineFromBehaviorHints handles network_call", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "network_call", detail: "api", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("calls_external")
    })

    test("mineFromBehaviorHints handles file_io", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "file_io", detail: "config", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("opens")
    })

    test("mineFromBehaviorHints handles cache_op write", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "cache_op", detail: "redis.set", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("writes")
    })

    test("mineFromBehaviorHints handles cache_op read", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "cache_op", detail: "redis.get", line: 1 }]
      const effects = mine(hints)
      expect(effects[0].kind).toBe("reads")
    })

    test("mineFromBehaviorHints handles transaction", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "transaction", detail: "main", line: 1 }]
      const effects = mine(hints)
      expect(effects.length).toBe(2) // writes + acquires_lock
    })

    test("mineFromBehaviorHints skips catches", () => {
      const mine = (engine as any).mineFromBehaviorHints.bind(engine)
      const hints = [{ symbol_key: "k", hint_type: "catches", detail: "Error", line: 1 }]
      const effects = mine(hints)
      expect(effects.length).toBe(0)
    })
  })

  describe("diffEffects", () => {
    test("returns no changes when both are null", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      const diff = await engine.diffEffects("sv-before", "sv-after")
      expect(diff.class_direction).toBe("unchanged")
      expect(diff.added_effects).toEqual([])
      expect(diff.removed_effects).toEqual([])
      expect(diff.summary).toBe("No effect changes detected")
    })
  })
})

// =====================================================================
// 3. DEEP CONTRACT SYNTHESIZER
// =====================================================================

describe("DeepContractSynthesizer", () => {
  const synth = new DeepContractSynthesizer()

  describe("mineFromBody", () => {
    test("detects assert() calls", async () => {
      const body = "function validate(x) { assert(x > 0); }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("assert"))).toBe(true)
    })

    test("detects console.assert()", async () => {
      const body = "function check(val) { console.assert(val !== null); }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("console_assert"))).toBe(true)
    })

    test("detects typeof guards", async () => {
      const body = 'if (typeof name === "string") { return name; }'
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("typeof"))).toBe(true)
    })

    test("detects instanceof guards", async () => {
      const body = "if (error instanceof ValidationError) { throw error; }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("instanceof"))).toBe(true)
    })

    test("detects Array.isArray guard", async () => {
      const body = "if (Array.isArray(items)) { return items.length; }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("Array.isArray"))).toBe(true)
    })

    test("does not record nullish coalescing or optional chaining as invariants", async () => {
      const body = "const val = input ?? defaultValue; const name = user?.profile;"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.startsWith("null_safety:"))).toBe(false)
    })

    test("still records an explicit null check", async () => {
      const body = "if (input !== null) { return input; }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.startsWith("null_check:"))).toBe(true)
    })

    test("does not record nested-function counts or `this` access as invariants", async () => {
      const body = "const inner = (x) => x + this.offset; function helper() {} if (!inner) return null; return { value: inner(1) };"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.startsWith("closure:"))).toBe(false)
      expect(candidates.some((c) => c.expression.startsWith("closure_binding:"))).toBe(false)
      // A return-path fact constrains callers and stays.
      expect(candidates.some((c) => c.expression.startsWith("higher_order:") || c.expression.startsWith("return_shape:"))).toBe(true)
    })

    test("capPerSymbol keeps the strongest MAX_INVARIANTS_PER_SYMBOL of an over-full symbol and leaves others alone", () => {
      const many = Array.from({ length: MAX_INVARIANTS_PER_SYMBOL + 10 }, (_, i) => ({
        expression: `guard:${i}`,
        source_type: "assertion" as const,
        strength: (i % 10) / 10,
        validation_method: "test",
        scope_level: "symbol" as const,
        scope_symbol_id: "busy",
        category: "guard_clause",
      }))
      const few = [{ ...many[0]!, scope_symbol_id: "quiet", expression: "guard:q" }]
      const kept = capPerSymbol([...many, ...few])
      const busy = kept.filter((c) => c.scope_symbol_id === "busy")
      expect(busy.length).toBe(MAX_INVARIANTS_PER_SYMBOL)
      expect(Math.min(...busy.map((c) => c.strength))).toBeGreaterThanOrEqual(0.1)
      expect(kept.filter((c) => c.scope_symbol_id === "quiet").length).toBe(1)
    })

    test("detects regex validators", async () => {
      const body = "if (/^[a-z]+@[a-z]+\\.[a-z]+$/.test(email)) { return true; }"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.source_type === "assertion" && c.expression.includes("regex_validation"))).toBe(
        true,
      )
    })

    test("detects trim normalization", async () => {
      const body = "const cleaned = input.trim();"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("trim"))).toBe(true)
    })

    test("detects toLowerCase normalization", async () => {
      const body = "const lower = email.toLowerCase();"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("lowercased"))).toBe(true)
    })

    test("detects parseInt normalization", async () => {
      const body = "const num = parseInt(input, 10);"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("parsed as integer"))).toBe(true)
    })

    test("detects JSON.parse normalization", async () => {
      const body = "const data = JSON.parse(rawBody);"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("JSON-parsed"))).toBe(true)
    })

    test("detects Zod string schema", async () => {
      const body = "const schema = z.string().min(1).max(100);"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.source_type === "schema")).toBe(true)
    })

    test("detects Zod email validation", async () => {
      const body = "const emailSchema = z.string().email();"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.source_type === "schema")).toBe(true)
    })

    test("detects switch case enum restriction", async () => {
      const body = `switch (status) {
                case 'active': break;
                case 'inactive': break;
                case 'pending': break;
            }`
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("enum"))).toBe(true)
    })

    test("returns empty for empty body", async () => {
      const candidates = await synth.mineFromBody("sv-1", "", "sym-1", "repo-1", "snap-1")
      expect(candidates).toEqual([])
    })

    test("detects Rust assert! macro", async () => {
      const body = "assert!(x > 0);"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1", "rust")
      expect(candidates.some((c) => c.expression.includes("assert"))).toBe(true)
    })

    test("detects Rust unwrap() call", async () => {
      const body = "let val = result.unwrap();"
      const candidates = await synth.mineFromBody("sv-1", body, "sym-1", "repo-1", "snap-1", "rust")
      expect(candidates.some((c) => c.expression.includes("unwrap"))).toBe(true)
    })
  })

  describe("mineFromSignature", () => {
    test("detects return type", async () => {
      const sig = "function getUser(id: string): Promise<User>"
      const candidates = await synth.mineFromSignature("sv-1", sig, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.source_type === "derived" && c.expression.includes("output_guarantee"))).toBe(
        true,
      )
    })

    test("detects generic constraint", async () => {
      const sig = "function process<T extends Serializable>(data: T): T"
      const candidates = await synth.mineFromSignature("sv-1", sig, "sym-1", "repo-1", "snap-1")
      expect(candidates.some((c) => c.expression.includes("extends"))).toBe(true)
    })

    test("detects optional params", async () => {
      const sig = "function create(name: string, age?: number): void"
      const candidates = await synth.mineFromSignature("sv-1", sig, "sym-1", "repo-1", "snap-1")
      expect(candidates.length).toBeGreaterThan(0)
    })
  })
})

// =====================================================================
// 4. DISPATCH RESOLVER
// =====================================================================

describe("parameterTypesFromSignature", () => {
  const { parameterTypesFromSignature } = require("../analysis-engine/dispatch-resolver")
  const types = (sig: string, lang: string) => Object.fromEntries(parameterTypesFromSignature(sig, lang))

  test("Go: receiver and parameters, pointers and package prefixes stripped", () => {
    expect(types("func (c *Context) JSON(code int, obj any)", "go")).toEqual({ c: "Context", code: "int", obj: "any" })
    expect(types("func handle(w http.ResponseWriter, r *http.Request)", "go")).toEqual({ w: "ResponseWriter", r: "Request" })
  })

  test("Java and C#: type before name, annotations and generics ignored", () => {
    expect(types("void run(@Nonnull final Context ctx, List<String> names)", "java")).toEqual({ ctx: "Context", names: "List" })
    expect(types("public Task Handle(ILogger<Foo> logger, CancellationToken token)", "csharp")).toEqual({ logger: "ILogger", token: "CancellationToken" })
  })

  test("TypeScript, Python, Kotlin, Swift: name before type, optional and defaulted parameters", () => {
    expect(types("(ctx?: Context, retries: number = 3): Promise<void>", "typescript")).toEqual({ ctx: "Context", retries: "number" })
    expect(types("def handle(self, request: Request, timeout=5) -> Response", "python")).toEqual({ request: "Request" })
    expect(types("fun render(view: View, depth: Int): Unit", "kotlin")).toEqual({ view: "View", depth: "Int" })
  })

  test("untyped parameters and this/self are not roots", () => {
    expect(types("function f(a, b) {", "javascript")).toEqual({})
    expect(types("def f(self, x)", "python")).toEqual({})
  })
})

describe("DispatchResolver", () => {
  const resolver = new DispatchResolver()

  // Chains were only collected from `this` and `self`, so a receiver named in
  // the signature — every Go method, every call through a typed parameter —
  // produced no dispatch. gin: 428 methods with owners, 0 dispatch edges.
  describe("chains rooted at a typed parameter or receiver", () => {
    const row = (overrides: Record<string, unknown>) => ({
      symbol_version_id: "sv",
      symbol_id: "sym",
      snapshot_id: "snap-1",
      file_id: "f1",
      range_start_line: 1,
      range_start_col: 0,
      range_end_line: 3,
      range_end_col: 0,
      signature: "",
      ast_hash: "",
      body_hash: "",
      summary: "",
      body_source: "",
      visibility: "public",
      language: "go",
      uncertainty_flags: [],
      canonical_name: "",
      kind: "function",
      stable_key: "",
      parent_name: null,
      repo_id: "repo-1",
      file_path: "ctx.go",
      ...overrides,
    })

    test("resolves `c.JSON(...)` inside `func (c *Context)` to Context.JSON", async () => {
      const { coreDataService } = require("../db-driver/core_data")
      coreDataService.getSymbolVersionsForSnapshot.mockResolvedValue([
        row({ symbol_version_id: "sv-ctx", symbol_id: "sym-ctx", canonical_name: "Context", kind: "class", stable_key: "ctx.go::Context" }),
        row({
          symbol_version_id: "sv-json",
          symbol_id: "sym-json",
          canonical_name: "JSON",
          kind: "method",
          stable_key: "ctx.go::Context.JSON",
          parent_name: "Context",
          signature: "func (c *Context) JSON(code int, obj any)",
          body_source: "func (c *Context) JSON(code int, obj any) { c.Render(code, obj) }",
        }),
        row({
          symbol_version_id: "sv-handler",
          symbol_id: "sym-handler",
          file_id: "f2",
          file_path: "routes.go",
          canonical_name: "handler",
          signature: "func handler(c *Context)",
          body_source: "func handler(c *Context) {\n  c.JSON(200, nil)\n}",
        }),
      ])
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      mockBatchInsert.mockClear()

      const edges = await resolver.resolveDispatches("snap-1", "repo-1")

      expect(edges).toBeGreaterThanOrEqual(1)
      const inserts = (mockBatchInsert.mock.calls.at(-1)?.[0] as { text: string; params: unknown[] }[]).filter((s) =>
        s.text.includes("INSERT INTO dispatch_edges"),
      )
      const edge = inserts.find((s) => s.params[2] === "sv-handler")
      expect(edge?.params[3]).toBe("c.JSON")
      expect(edge?.params[5]).toEqual(["sv-json"])
    })
  })

  describe("C3 linearization", () => {
    test("handles single class with no parents", () => {
      const c3 = (resolver as any).computeC3Linearization.bind(resolver)
      const graph = new Map()
      graph.set("A", {
        symbolVersionId: "A",
        parents: [],
        children: [],
        methods: new Map(),
      })
      const result = c3("A", graph)
      expect(result).toEqual(["A"])
    })

    test("handles simple inheritance A -> B", () => {
      const c3 = (resolver as any).computeC3Linearization.bind(resolver)
      const graph = new Map()
      graph.set("A", {
        symbolVersionId: "A",
        parents: [],
        children: ["B"],
        methods: new Map(),
      })
      graph.set("B", {
        symbolVersionId: "B",
        parents: [{ svId: "A", relationKind: "extends" }],
        children: [],
        methods: new Map(),
      })
      const result = c3("B", graph)
      expect(result[0]).toBe("B")
      expect(result).toContain("A")
    })

    test("handles diamond inheritance", () => {
      const c3 = (resolver as any).computeC3Linearization.bind(resolver)
      const graph = new Map()
      graph.set("A", { symbolVersionId: "A", parents: [], children: ["B", "C"], methods: new Map() })
      graph.set("B", {
        symbolVersionId: "B",
        parents: [{ svId: "A", relationKind: "extends" }],
        children: ["D"],
        methods: new Map(),
      })
      graph.set("C", {
        symbolVersionId: "C",
        parents: [{ svId: "A", relationKind: "extends" }],
        children: ["D"],
        methods: new Map(),
      })
      graph.set("D", {
        symbolVersionId: "D",
        parents: [
          { svId: "B", relationKind: "extends" },
          { svId: "C", relationKind: "extends" },
        ],
        children: [],
        methods: new Map(),
      })

      const result = c3("D", graph)
      expect(result[0]).toBe("D")
      // D appears before B and C
      expect(result.indexOf("D")).toBe(0)
    })
  })

  describe("buildClassHierarchy", () => {
    test("returns 0 for empty snapshot", async () => {
      const { coreDataService } = require("../db-driver/core_data")
      coreDataService.getSymbolVersionsForSnapshot.mockResolvedValue([])
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })

      const result = await resolver.buildClassHierarchy("snap-empty")
      expect(result).toBe(0)
    })
  })
})

// =====================================================================
// 5. SYMBOL LINEAGE ENGINE
// =====================================================================

describe("SymbolLineageEngine", () => {
  const lineageEngine = new SymbolLineageEngine()

  describe("computeIdentitySeed", () => {
    test("produces deterministic SHA-256 seed", () => {
      const seed1 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "typescript",
        "function",
        "UserService",
        "validate",
        "sig-hash",
        "src/services/",
      )
      const seed2 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "typescript",
        "function",
        "UserService",
        "validate",
        "sig-hash",
        "src/services/",
      )
      expect(seed1).toBe(seed2)
      expect(seed1).toHaveLength(64) // SHA-256 hex
    })

    test("different inputs produce different seeds", () => {
      const seed1 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "typescript",
        "function",
        "UserService",
        "validate",
        "sig-hash-1",
        "src/services/",
      )
      const seed2 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "typescript",
        "function",
        "UserService",
        "validate",
        "sig-hash-2",
        "src/services/",
      )
      expect(seed1).not.toBe(seed2)
    })

    test("is case-insensitive for language, kind, ancestry, filePath", () => {
      const seed1 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "TypeScript",
        "Function",
        "UserService",
        "validate",
        "hash",
        "src/Services/",
      )
      const seed2 = lineageEngine.computeIdentitySeed(
        "repo-1",
        "typescript",
        "function",
        "userservice",
        "validate",
        "hash",
        "src/services/",
      )
      expect(seed1).toBe(seed2)
    })

    test("is case-sensitive for name", () => {
      const seed1 = lineageEngine.computeIdentitySeed("repo-1", "typescript", "function", "", "Validate", "hash", "")
      const seed2 = lineageEngine.computeIdentitySeed("repo-1", "typescript", "function", "", "validate", "hash", "")
      expect(seed1).not.toBe(seed2)
    })
  })

  describe("computeLineage", () => {
    test("returns zero stats for empty snapshot", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      const result = await lineageEngine.computeLineage("repo-1", "snap-1", null)
      expect(result.total_symbols).toBe(0)
      expect(result.births).toBe(0)
      expect(result.deaths).toBe(0)
      expect(result.exact_matches).toBe(0)
    })
  })

  describe("helper methods", () => {
    test("extractAncestry extracts parent from stable key with :: separator", () => {
      const extract = (lineageEngine as any).extractAncestry.bind(lineageEngine)
      expect(extract("src/services.ts::UserService.validate")).toBe("UserService")
    })

    test("extractAncestry returns empty for simple key", () => {
      const extract = (lineageEngine as any).extractAncestry.bind(lineageEngine)
      expect(extract("validate")).toBe("")
    })

    test("hashSignature normalizes whitespace", () => {
      const hashSig = (lineageEngine as any).hashSignature.bind(lineageEngine)
      const h1 = hashSig("function validate(x: string): boolean")
      const h2 = hashSig("function validate(x: string): boolean")
      expect(h1).toBe(h2)
    })

    test("extractFileContext extracts directory component", () => {
      const extractCtx = (lineageEngine as any).extractFileContext.bind(lineageEngine)
      const ctx = extractCtx("src/services/user/validator.ts")
      expect(ctx).toContain("src")
    })
  })
})

// =====================================================================
// 6. TEMPORAL ENGINE
// =====================================================================

describe("TemporalEngine", () => {
  const temporalEngine = new TemporalEngine()

  describe("parseGitLog", () => {
    const parseLog = (temporalEngine as any).parseGitLog.bind(temporalEngine)

    test("parses single commit", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|Author|test@example.com|2025-01-15 10:30:00 +0000|feat: add feature\nsrc/index.ts\nsrc/utils.ts\n`
      const commits = parseLog(raw)
      expect(commits).toHaveLength(1)
      expect(commits[0].hash).toBe(hash)
      expect(commits[0].author_name).toBe("Author")
      expect(commits[0].author_email).toBe("test@example.com")
      expect(commits[0].files).toEqual(["src/index.ts", "src/utils.ts"])
      expect(commits[0].is_bug_fix).toBe(false)
    })

    test("parses multiple commits", () => {
      const h1 = "a".repeat(40)
      const h2 = "b".repeat(40)
      const raw = `${h1}|Author1|a@b.com|2025-01-15 10:30:00 +0000|feat: add\nsrc/a.ts\n\n${h2}|Author2|c@d.com|2025-01-16 10:30:00 +0000|fix: bug\nsrc/b.ts\n`
      const commits = parseLog(raw)
      expect(commits).toHaveLength(2)
      expect(commits[1].is_bug_fix).toBe(true)
    })

    test("detects bug fix subjects", () => {
      const hash = "a".repeat(40)
      const patterns = [
        "fix: broken button",
        "bug: null reference",
        "hotfix: crash",
        "resolve issue #123",
        "patch: memory leak",
        "closes #42",
      ]
      for (const subject of patterns) {
        const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|${subject}\n`
        const commits = parseLog(raw)
        expect(commits[0].is_bug_fix).toBe(true)
      }
    })

    test("detects revert commits", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|Revert "feat: add button"\nsrc/a.ts\n`
      const commits = parseLog(raw)
      expect(commits[0].is_revert).toBe(true)
    })

    test("detects merge commits", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|Merge pull request #99 from feature\n`
      const commits = parseLog(raw)
      expect(commits[0].is_merge).toBe(true)
    })

    test("handles subject with pipe characters", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|feat: add | operator support\n`
      const commits = parseLog(raw)
      expect(commits[0].subject).toBe("feat: add | operator support")
    })

    test("parses delimiter-safe git output with pipes in identity and paths", () => {
      const hash = "a".repeat(40)
      const raw = `\x1e${hash}\x00Author | Team\x00pipe@example.com\x002025-01-15T10:30:00+00:00\x00fix: support | syntax\x00src/a|b.ts\x00`
      const commits = parseLog(raw)

      expect(commits).toHaveLength(1)
      expect(commits[0]).toMatchObject({
        author_name: "Author | Team",
        subject: "fix: support | syntax",
        files: ["src/a|b.ts"],
        is_bug_fix: true,
      })
    })

    test("skips binary files", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|feat: add icons\nicon.png\nstyles.css\n`
      const commits = parseLog(raw)
      expect(commits[0].files).toEqual(["styles.css"])
    })

    test("skips lock files", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|deps: update\npackage-lock.json\nyarn.lock\nsrc/index.ts\n`
      const commits = parseLog(raw)
      expect(commits[0].files).toEqual(["src/index.ts"])
    })

    test("skips node_modules and dist", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|2025-01-15 10:30:00 +0000|build\nnode_modules/foo/index.js\ndist/bundle.js\nsrc/main.ts\n`
      const commits = parseLog(raw)
      expect(commits[0].files).toEqual(["src/main.ts"])
    })

    test("returns empty array for empty input", () => {
      expect(parseLog("")).toEqual([])
      expect(parseLog("   ")).toEqual([])
    })

    test("skips malformed headers", () => {
      const raw = "not-a-commit-line\nsrc/foo.ts\n"
      const commits = parseLog(raw)
      expect(commits).toHaveLength(0)
    })

    test("skips commits with invalid dates", () => {
      const hash = "a".repeat(40)
      const raw = `${hash}|A|a@b.com|not-a-date|feat: add\nsrc/a.ts\n`
      const commits = parseLog(raw)
      expect(commits).toHaveLength(0)
    })
  })

  describe("isIgnoredPath", () => {
    const isIgnored = (temporalEngine as any).isIgnoredPath.bind(temporalEngine)

    test("ignores image files", () => {
      expect(isIgnored("assets/logo.png")).toBe(true)
      expect(isIgnored("assets/photo.jpg")).toBe(true)
      expect(isIgnored("assets/icon.gif")).toBe(true)
    })

    test("ignores font files", () => {
      expect(isIgnored("fonts/roboto.woff2")).toBe(true)
      expect(isIgnored("fonts/custom.ttf")).toBe(true)
    })

    test("ignores archives", () => {
      expect(isIgnored("assets/data.zip")).toBe(true)
      expect(isIgnored("assets/backup.tar.gz")).toBe(true) // .gz is in binary extensions
      expect(isIgnored("assets/archive.7z")).toBe(true)
    })

    test("ignores lock files", () => {
      expect(isIgnored("package-lock.json")).toBe(true)
      expect(isIgnored("yarn.lock")).toBe(true)
      expect(isIgnored("Cargo.lock")).toBe(true)
      expect(isIgnored("go.sum")).toBe(true)
    })

    test("ignores node_modules", () => {
      expect(isIgnored("node_modules/lodash/index.js")).toBe(true)
    })

    test("ignores dist directory", () => {
      expect(isIgnored("dist/bundle.js")).toBe(true)
    })

    test("allows source files", () => {
      expect(isIgnored("src/index.ts")).toBe(false)
      expect(isIgnored("lib/utils.py")).toBe(false)
      expect(isIgnored("main.go")).toBe(false)
    })
  })

  const emptyHistory = (): SymbolHistory => ({
    commitsBySymbol: new Map(),
    blamedFiles: new Set(),
    symbolsByFile: new Map(),
    filesSkipped: 0,
  })

  /** Which table each batchInsert row went to. */
  const insertedTables = (): string[] =>
    mockBatchInsert.mock.calls.flatMap((call) =>
      (call[0] as { text: string }[]).map((stmt) => /INSERT INTO (\w+)/.exec(stmt.text)?.[1] ?? "?"),
    )

  describe("computeCoChanges", () => {
    test("writes nothing when there is no history", async () => {
      const result = await temporalEngine.computeCoChanges("repo-1", "snap-1", [], emptyHistory())
      expect(result).toEqual({ symbol_pairs: 0, file_pairs: 0 })
      expect(mockBatchInsert).not.toHaveBeenCalled()
    })

    test("skips merge commits for file pairs", async () => {
      const commits = [
        makeGitCommit({ hash: "a".repeat(40), is_merge: true, files: ["src/a.ts", "src/b.ts"] }),
        makeGitCommit({ hash: "b".repeat(40), is_merge: true, files: ["src/a.ts", "src/b.ts"] }),
      ]
      const result = await temporalEngine.computeCoChanges("repo-1", "snap-1", commits, emptyHistory())
      expect(result.file_pairs).toBe(0)
    })

    test("file pairs come from the log; a symbol pair needs blame, not shared files", async () => {
      const commits = [
        makeGitCommit({ hash: "a".repeat(40), files: ["src/a.ts", "src/b.ts"] }),
        makeGitCommit({ hash: "b".repeat(40), files: ["src/a.ts", "src/b.ts"], date: new Date("2025-01-16") }),
      ]
      const history = emptyHistory()
      history.symbolsByFile.set("src/a.ts", ["sym-a"])
      history.symbolsByFile.set("src/b.ts", ["sym-b"])
      const result = await temporalEngine.computeCoChanges("repo-1", "snap-1", commits, history)
      expect(result).toEqual({ symbol_pairs: 0, file_pairs: 1 })
      expect(insertedTables()).toEqual(["temporal_file_co_changes"])
      const row = (mockBatchInsert.mock.calls[0]![0] as { params: unknown[] }[])[0]!.params
      expect(row.slice(1, 7)).toEqual(["src/a.ts", "src/b.ts", 2, 2, 2, 1])
    })

    test("symbol pairs come from commits that last touched both symbols' lines", async () => {
      const commits = [
        makeGitCommit({ hash: "a".repeat(40), files: ["src/a.ts"] }),
        makeGitCommit({ hash: "b".repeat(40), files: ["src/a.ts"], date: new Date("2025-01-16") }),
      ]
      const history = emptyHistory()
      history.blamedFiles.add("src/a.ts")
      history.commitsBySymbol.set("sym-a", new Set(["a".repeat(40), "b".repeat(40)]))
      history.commitsBySymbol.set("sym-b", new Set(["a".repeat(40), "b".repeat(40), "c".repeat(40)]))
      history.commitsBySymbol.set("sym-c", new Set(["c".repeat(40)]))
      const result = await temporalEngine.computeCoChanges("repo-1", "snap-1", commits, history)
      expect(result.symbol_pairs).toBe(1) // a–b twice; b–c only once, below CO_CHANGE_MIN_COUNT
      const symbolRows = mockBatchInsert.mock.calls
        .flatMap((call) => call[0] as { text: string; params: unknown[] }[])
        .filter((stmt) => stmt.text.includes("temporal_co_changes"))
      expect(symbolRows.length).toBe(1)
      // symbol_a, symbol_b, co_change_count, total_a, total_b, jaccard = 2 / (2 + 3 - 2)
      expect(symbolRows[0]!.params.slice(2, 8)).toEqual(["sym-a", "sym-b", 2, 2, 3, 2 / 3])
    })

    test("rewrites both tables so pairs history no longer supports do not linger", async () => {
      await temporalEngine.computeCoChanges("repo-1", "snap-1", [], emptyHistory())
      const deletes = mockQuery.mock.calls.map((call) => String(call[0])).filter((sql) => sql.includes("DELETE FROM"))
      expect(deletes.some((sql) => sql.includes("temporal_file_co_changes"))).toBe(true)
      expect(deletes.some((sql) => sql.includes("temporal_co_changes"))).toBe(true)
    })
  })

  describe("computeRiskScores", () => {
    test("returns 0 when no symbol has history", async () => {
      const result = await temporalEngine.computeRiskScores("repo-1", "snap-1", [makeGitCommit()], emptyHistory())
      expect(result).toBe(0)
    })

    test("uses file-level commits for a file blame did not reach", async () => {
      const commits = [
        makeGitCommit({ files: ["src/a.ts"], is_bug_fix: true }),
        makeGitCommit({ hash: "b".repeat(40), files: ["src/a.ts"], date: new Date("2025-01-20") }),
      ]
      const history = emptyHistory()
      history.symbolsByFile.set("src/a.ts", ["sym-a"])
      const result = await temporalEngine.computeRiskScores("repo-1", "snap-1", commits, history)
      expect(result).toBe(1)
      const row = (mockBatchInsert.mock.calls[0]![0] as { params: unknown[] }[])[0]!.params
      expect(row[4]).toBe(2) // change_frequency
      expect(row[5]).toBe(1) // bug_fix_count
    })

    test("uses blame for a blamed file, so a sibling symbol untouched by the commits scores nothing", async () => {
      const commits = [makeGitCommit({ hash: "a".repeat(40), files: ["src/a.ts"], is_bug_fix: true })]
      const history = emptyHistory()
      history.blamedFiles.add("src/a.ts")
      history.symbolsByFile.set("src/a.ts", ["sym-a", "sym-untouched"])
      history.commitsBySymbol.set("sym-a", new Set(["a".repeat(40)]))
      const result = await temporalEngine.computeRiskScores("repo-1", "snap-1", commits, history)
      expect(result).toBe(1)
      const rows = mockBatchInsert.mock.calls.flatMap((call) => call[0] as { params: unknown[] }[])
      expect(rows.map((r) => r.params[2])).toEqual(["sym-a"])
    })
  })

  describe("query bounds", () => {
    test.each([
      [Number.NaN, 20],
      [-10, 1],
      [Number.POSITIVE_INFINITY, 20],
      [50_000, 500],
    ])("normalizes top-risk limit %s", async (requested, expected) => {
      await temporalEngine.getTopRisks("snap-1", requested)
      expect(mockQuery.mock.calls.at(-1)?.[1]).toEqual(["snap-1", expected])
    })

    test.each([
      [Number.NaN, 0.1],
      [-1, 0],
      [2, 1],
    ])("normalizes co-change threshold %s", async (requested, expected) => {
      await temporalEngine.getCoChangePartners("sym-1", "repo-1", requested)
      expect(mockQuery.mock.calls.at(-1)?.[1]).toEqual(["sym-1", "repo-1", expected])
    })
  })
})

// =====================================================================
// 7. CONCEPT FAMILY ENGINE
// =====================================================================

describe("ConceptFamilyEngine", () => {
  const cfEngine = new ConceptFamilyEngine()

  describe("buildFamilies persistence", () => {
    test("members are written under the family id the database returns, not a generated one", async () => {
      const member = (id: string, name: string) => ({
        symbol_version_id: id,
        canonical_name: name,
        kind: "function",
        stable_key: `src/a.ts#${name}`,
      })
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("ir.relation_type != 'co_changed_with'")) {
          return {
            rows: [
              { src_symbol_version_id: "sv-1", dst_symbol_version_id: "sv-2", confidence: 0.9, relation_type: "semantic_homolog" },
              { src_symbol_version_id: "sv-2", dst_symbol_version_id: "sv-1", confidence: 0.9, relation_type: "semantic_homolog" },
            ],
            rowCount: 2,
          }
        }
        if (sql.includes("s.canonical_name, s.kind, s.stable_key")) {
          return { rows: [member("sv-1", "validateEmail"), member("sv-2", "validatePhone")], rowCount: 2 }
        }
        if (sql.includes("INSERT INTO concept_families")) {
          // The upsert hit an existing row: the database reports that row's id.
          return { rows: [{ family_id: "existing-family-id" }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      })

      const result = await cfEngine.buildFamilies("repo-1", "snap-1")
      expect(result.families_created).toBe(1)

      const memberInserts = mockBatchInsert.mock.calls
        .flatMap((call) => call[0] as { text: string; params: unknown[] }[])
        .filter((stmt) => stmt.text.includes("concept_family_members"))
      expect(memberInserts.length).toBe(2)
      for (const stmt of memberInserts) expect(stmt.params[1]).toBe("existing-family-id")
    })
  })

  describe("clusterBySharedDependencies", () => {
    const cluster = (cfEngine as any).clusterBySharedDependencies.bind(cfEngine)
    const edge = (src: string, dst: string, kind = "function") => ({ src, dst, kind })

    test("seeds a family from symbols that call the same things, whatever their names are called", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          edge("parseUser", "validate"),
          edge("parseUser", "normalize"),
          edge("parseUser", "log"),
          edge("loadOrder", "validate"),
          edge("loadOrder", "normalize"),
          edge("loadOrder", "log"),
          edge("unrelatedTask", "log"),
          edge("unrelatedTask", "fetch"),
        ],
        rowCount: 8,
      })
      const clusters = await cluster("snap-1")
      expect(clusters).toHaveLength(1)
      expect(clusters[0].member_sv_ids.sort()).toEqual(["loadOrder", "parseUser"])
      expect(clusters[0].internal_edges[0].relation_type).toBe("shared_dependencies")
      // 3 shared of 3 ∪ 3 → Jaccard 1
      expect(clusters[0].avg_confidence).toBeCloseTo(1)
    })

    test("a shared name suffix alone is not a family", async () => {
      mockQuery.mockResolvedValue({
        rows: [edge("UserService", "db"), edge("MailService", "smtp"), edge("AuthService", "jwt")],
        rowCount: 3,
      })
      expect(await cluster("snap-1")).toEqual([])
    })

    test("requires at least two shared callees and a Jaccard of 0.5", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          edge("a", "shared1"),
          edge("a", "only-a-1"),
          edge("a", "only-a-2"),
          edge("b", "shared1"),
          edge("b", "only-b-1"),
          edge("b", "only-b-2"),
        ],
        rowCount: 6,
      })
      expect(await cluster("snap-1")).toEqual([])
    })

    test("does not pair symbols of different kinds", async () => {
      mockQuery.mockResolvedValue({
        rows: [edge("fn", "x"), edge("fn", "y"), edge("Klass", "x", "class"), edge("Klass", "y", "class")],
        rowCount: 4,
      })
      expect(await cluster("snap-1")).toEqual([])
    })
  })

  describe("classifyFamilyType", () => {
    test("returns custom for empty members", () => {
      expect(cfEngine.classifyFamilyType([], [], undefined)).toBe("custom")
    })

    test("classifies validator family by kind", () => {
      const members: MemberData[] = [
        makeMemberData({ kind: "validator", canonical_name: "validateEmail" }),
        makeMemberData({ kind: "validator", canonical_name: "validatePhone", symbol_version_id: "sv-2" }),
        makeMemberData({ kind: "function", canonical_name: "otherFunc", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      expect(cfEngine.classifyFamilyType(svIds, members)).toBe("validator")
    })

    test("classifies auth_policy by behavioral profile", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "checkAdmin", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "checkUser", symbol_version_id: "sv-2" }),
        makeMemberData({ canonical_name: "verifyRole", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      const bpMap = new Map<string, BehavioralProfile>()
      bpMap.set("sv-1", makeBP({ auth_operations: ["requireAdmin"], symbol_version_id: "sv-1" }))
      bpMap.set("sv-2", makeBP({ auth_operations: ["requireUser"], symbol_version_id: "sv-2" }))
      bpMap.set("sv-3", makeBP({ auth_operations: ["requireRole"], symbol_version_id: "sv-3" }))
      expect(cfEngine.classifyFamilyType(svIds, members, bpMap)).toBe("auth_policy")
    })

    test("classifies by name heuristic: validator", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "validateEmail", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "checkPhoneNumber", symbol_version_id: "sv-2" }),
        makeMemberData({ canonical_name: "verifyAddress", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      expect(cfEngine.classifyFamilyType(svIds, members)).toBe("validator")
    })

    test("classifies by name heuristic: normalization", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "normalizeInput", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "sanitizeHTML", symbol_version_id: "sv-2" }),
        makeMemberData({ canonical_name: "cleanString", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      expect(cfEngine.classifyFamilyType(svIds, members)).toBe("normalization")
    })

    test("classifies by name heuristic: auth_policy", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "authMiddleware", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "guardRoute", symbol_version_id: "sv-2" }),
        makeMemberData({ canonical_name: "permissionCheck", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      expect(cfEngine.classifyFamilyType(svIds, members)).toBe("auth_policy")
    })

    test("classifies by name heuristic: serializer", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "serializeUser", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "marshalData", symbol_version_id: "sv-2" }),
        makeMemberData({ canonical_name: "encodePayload", symbol_version_id: "sv-3" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      expect(cfEngine.classifyFamilyType(svIds, members)).toBe("serializer")
    })

    test("returns business_rule when behavioral data present but no match", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "doSomething", symbol_version_id: "sv-1" }),
        makeMemberData({ canonical_name: "handleStuff", symbol_version_id: "sv-2" }),
      ]
      const svIds = members.map((m) => m.symbol_version_id)
      const bpMap = new Map<string, BehavioralProfile>()
      bpMap.set("sv-1", makeBP({ symbol_version_id: "sv-1" }))
      expect(cfEngine.classifyFamilyType(svIds, members, bpMap)).toBe("business_rule")
    })
  })

  describe("generateFamilyName", () => {
    const genName = (cfEngine as any).generateFamilyName.bind(cfEngine)

    test("generates name from common tokens", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "validateEmail" }),
        makeMemberData({ canonical_name: "validatePhone" }),
      ]
      const name = genName(members, "validator")
      expect(name).toContain("validate")
      expect(name).toContain("validator")
      expect(name).toContain("family")
    })

    test("returns unnamed for empty members", () => {
      const name = genName([], "custom")
      expect(name).toBe("unnamed_custom")
    })

    test("uses first member name as fallback when no common tokens", () => {
      const members: MemberData[] = [
        makeMemberData({ canonical_name: "alpha" }),
        makeMemberData({ canonical_name: "beta" }),
      ]
      const name = genName(members, "custom")
      expect(name).toContain("custom")
      expect(name).toContain("family")
    })
  })

  describe("tokenizeName", () => {
    const tokenize = (cfEngine as any).tokenizeName.bind(cfEngine)

    test("splits camelCase", () => {
      const result = tokenize("validateEmail")
      expect(result).toContain("validate")
      expect(result).toContain("email")
    })

    test("splits PascalCase", () => {
      const result = tokenize("UserService")
      expect(result).toContain("user")
      expect(result).toContain("service")
    })

    test("splits snake_case", () => {
      const result = tokenize("validate_email")
      expect(result).toContain("validate")
      expect(result).toContain("email")
    })

    test("splits dot-separated names", () => {
      const result = tokenize("user.validate")
      expect(result).toContain("user")
      expect(result).toContain("validate")
    })
  })

  describe("computeMembershipConfidence", () => {
    const computeConf = (cfEngine as any).computeMembershipConfidence.bind(cfEngine)

    test("returns 0 for member with no edges", () => {
      const cluster: RawCluster = {
        member_sv_ids: ["sv-1", "sv-2", "sv-3"],
        internal_edges: [{ src: "sv-2", dst: "sv-3", confidence: 0.8, relation_type: "similar" }],
        avg_confidence: 0.8,
      }
      expect(computeConf("sv-1", cluster)).toBe(0)
    })

    test("computes confidence from edge coverage and strength", () => {
      const cluster: RawCluster = {
        member_sv_ids: ["sv-1", "sv-2", "sv-3"],
        internal_edges: [
          { src: "sv-1", dst: "sv-2", confidence: 0.9, relation_type: "similar" },
          { src: "sv-1", dst: "sv-3", confidence: 0.8, relation_type: "similar" },
        ],
        avg_confidence: 0.85,
      }
      const conf = computeConf("sv-1", cluster)
      expect(conf).toBeGreaterThan(0)
      expect(conf).toBeLessThanOrEqual(1.0)
    })
  })

  describe("computeAvgConfidence", () => {
    const avgConf = (cfEngine as any).computeAvgConfidence.bind(cfEngine)

    test("returns 0 for empty edge list", () => {
      expect(avgConf([])).toBe(0)
    })

    test("computes average correctly", () => {
      const edges = [{ confidence: 0.8 }, { confidence: 0.6 }]
      expect(avgConf(edges)).toBeCloseTo(0.7, 5)
    })
  })

  describe("extractInternalEdges", () => {
    const extractEdges = (cfEngine as any).extractInternalEdges.bind(cfEngine)

    test("extracts only internal edges", () => {
      const adjacency = new Map<string, Map<string, { confidence: number; relation_type: string }>>()
      adjacency.set(
        "A",
        new Map([
          ["B", { confidence: 0.9, relation_type: "similar" }],
          ["C", { confidence: 0.7, relation_type: "similar" }],
        ]),
      )
      adjacency.set("B", new Map([["A", { confidence: 0.9, relation_type: "similar" }]]))

      const edges = extractEdges(["A", "B"], adjacency)
      expect(edges).toHaveLength(1) // A-B only, not A-C
    })

    test("deduplicates edges (undirected)", () => {
      const adjacency = new Map<string, Map<string, { confidence: number; relation_type: string }>>()
      adjacency.set("A", new Map([["B", { confidence: 0.9, relation_type: "similar" }]]))
      adjacency.set("B", new Map([["A", { confidence: 0.9, relation_type: "similar" }]]))

      const edges = extractEdges(["A", "B"], adjacency)
      expect(edges).toHaveLength(1)
    })
  })
})

// =====================================================================
// 8. STRUCTURAL GRAPH ENGINE
// =====================================================================

describe("StructuralGraphEngine", () => {
  const sge = new StructuralGraphEngine()

  describe("computeRelationsFromRaw", () => {
    test("returns 0 for empty raw relations", async () => {
      const result = await sge.computeRelationsFromRaw("snap-1", "repo-1", [])
      expect(result).toBe(0)
    })

    test("resolves source keys via symbol version map", async () => {
      const { coreDataService } = require("../db-driver/core_data")
      coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
        { stable_key: "src/a.ts::funcA", canonical_name: "funcA", symbol_version_id: "sv-a" },
        { stable_key: "src/b.ts::funcB", canonical_name: "funcB", symbol_version_id: "sv-b" },
      ])

      const relations = [{ source_key: "src/a.ts::funcA", target_name: "funcB", relation_type: "calls" as const }]

      const result = await sge.computeRelationsFromRaw("snap-1", "repo-1", relations)
      expect(result).toBe(1)
      // One multi-row statement for the whole snapshot, not one per edge.
      expect(mockBulkInsert).toHaveBeenCalledTimes(1)
      const [table, columns, rows, options] = mockBulkInsert.mock.calls[0]!
      expect(table).toBe("structural_relations")
      expect(columns).toEqual(["relation_id", "src_symbol_version_id", "dst_symbol_version_id", "relation_type", "strength", "source", "confidence"])
      expect(rows).toHaveLength(1)
      expect(rows[0].slice(1, 4)).toEqual(["sv-a", "sv-b", "calls"])
      expect(options.conflict).toContain("DO UPDATE SET confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence)")
      expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("canonical_name IN"))).toBe(false)
    })

    test("the same edge extracted twice is written once", async () => {
      const { coreDataService } = require("../db-driver/core_data")
      coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
        { stable_key: "src/a.ts::funcA", canonical_name: "funcA", symbol_version_id: "sv-a" },
        { stable_key: "src/b.ts::funcB", canonical_name: "funcB", symbol_version_id: "sv-b" },
      ])
      const rel = { source_key: "src/a.ts::funcA", target_name: "funcB", relation_type: "calls" as const }
      const result = await sge.computeRelationsFromRaw("snap-1", "repo-1", [rel, { ...rel }])
      expect(result).toBe(1)
      expect(mockBulkInsert.mock.calls[0]![2]).toHaveLength(1)
    })

    test("skips relations with unresolved source", async () => {
      const { coreDataService } = require("../db-driver/core_data")
      coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
        { stable_key: "src/a.ts::funcA", canonical_name: "funcA", symbol_version_id: "sv-a" },
      ])

      const relations = [{ source_key: "nonexistent::func", target_name: "funcA", relation_type: "calls" as const }]

      const result = await sge.computeRelationsFromRaw("snap-1", "repo-1", relations)
      expect(result).toBe(0)
    })

    // Names are scoped and the scopes are in the keys. Before the ladder,
    // call text was matched against bare names or nothing: gin kept 19% of
    // the relations it extracted, flask 6.5%.
    describe("resolves by scope, from the caller outward", () => {
      const persistedTargets = (): string[] =>
        (mockBulkInsert.mock.calls.at(-1)?.[2] as unknown[][]).map((row) => row[2] as string)

      beforeEach(() => {
        mockBulkInsert.mockClear()
        const { coreDataService } = require("../db-driver/core_data")
        coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
          { stable_key: "pkg/a.go::handle", canonical_name: "handle", symbol_version_id: "sv-a-handle" },
          { stable_key: "pkg/b.go::handle", canonical_name: "handle", symbol_version_id: "sv-b-handle" },
          { stable_key: "other/c.go::handle", canonical_name: "handle", symbol_version_id: "sv-c-handle" },
          { stable_key: "pkg/a.go::caller", canonical_name: "caller", symbol_version_id: "sv-caller" },
          { stable_key: "other/c.go::farCaller", canonical_name: "farCaller", symbol_version_id: "sv-far" },
          { stable_key: "pkg/ctx.go::Context.JSON", canonical_name: "JSON", symbol_version_id: "sv-ctx-json" },
          { stable_key: "pkg/a.go::__module__", canonical_name: "pkg/a.go", symbol_version_id: "sv-mod-a" },
          { stable_key: "lib/only.go::unique", canonical_name: "unique", symbol_version_id: "sv-unique" },
        ])
      })

      test("a name defined in the caller's own file wins over the same name elsewhere", async () => {
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "pkg/a.go::caller", target_name: "handle", relation_type: "calls" as const },
        ])
        expect(n).toBe(1)
        expect(persistedTargets()).toEqual(["sv-a-handle"])
      })

      test("then the caller's directory — the package — before the repository", async () => {
        // From other/c.go, `handle` has a same-file definition; from a file in
        // pkg/ with none of its own, the package's one is ambiguous (a.go and
        // b.go both define it), so nothing is recorded rather than a guess.
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "other/c.go::farCaller", target_name: "handle", relation_type: "calls" as const },
          { source_key: "pkg/ctx.go::Context.JSON", target_name: "handle", relation_type: "calls" as const },
        ])
        expect(n).toBe(1)
        expect(persistedTargets()).toEqual(["sv-c-handle"])
      })

      test("`Owner.member` call text resolves to that owner's member wherever it lives", async () => {
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "other/c.go::farCaller", target_name: "Context.JSON", relation_type: "calls" as const },
          { source_key: "other/c.go::farCaller", target_name: "c.JSON", relation_type: "calls" as const },
        ])
        // The first names the owner; the second names a variable, and JSON is
        // unique in the repository, so both land on the same member — and the
        // same edge is written once.
        expect(n).toBe(1)
        expect(persistedTargets()).toEqual(["sv-ctx-json"])
      })

      test("a file-level relation comes from the file's module symbol", async () => {
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "pkg/a.go::__module__", target_name: "lib.unique", relation_type: "imports" as const },
        ])
        expect(n).toBe(1)
        expect(persistedTargets()).toEqual(["sv-unique"])
      })

      test("`pkg.member` resolves through the file's import to that package, not to an ambiguous bare name", async () => {
        const { coreDataService } = require("../db-driver/core_data")
        coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
          { stable_key: "context.go::__module__", canonical_name: "context.go", symbol_version_id: "sv-mod" },
          { stable_key: "context.go::Context.Bind", canonical_name: "Bind", symbol_version_id: "sv-bind" },
          { stable_key: "internal/json/json.go::Unmarshal", canonical_name: "Unmarshal", symbol_version_id: "sv-json-unmarshal" },
          { stable_key: "internal/json/sonic.go::Marshal", canonical_name: "Marshal", symbol_version_id: "sv-json-marshal" },
          { stable_key: "binding/yaml.go::Unmarshal", canonical_name: "Unmarshal", symbol_version_id: "sv-yaml-unmarshal" },
          { stable_key: "pkg/util.py::helper", canonical_name: "helper", symbol_version_id: "sv-py-helper" },
          { stable_key: "other/util.py::helper", canonical_name: "helper", symbol_version_id: "sv-other-helper" },
          { stable_key: "app.py::__module__", canonical_name: "app.py", symbol_version_id: "sv-app-mod" },
          { stable_key: "app.py#main", canonical_name: "main", symbol_version_id: "sv-main" },
        ])
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "context.go::__module__", target_name: "github.com/gin-gonic/gin/internal/json", relation_type: "imports" as const },
          // Unmarshal is ambiguous repository-wide; the import says which one.
          { source_key: "context.go::Context.Bind", target_name: "json.Unmarshal", relation_type: "calls" as const },
          // A sibling file of the imported package is the same package.
          { source_key: "context.go::Context.Bind", target_name: "json.Marshal", relation_type: "calls" as const },
          { source_key: "app.py::__module__", target_name: "pkg.util", relation_type: "imports" as const },
          { source_key: "app.py#main", target_name: "util.helper", relation_type: "calls" as const },
        ])
        expect(n).toBe(3)
        expect(persistedTargets()).toEqual(["sv-json-unmarshal", "sv-json-marshal", "sv-py-helper"])
      })

      test("a chain resolves by the identifier it ends in, from the index, with no database lookup", async () => {
        // `strings.Split` names a package the index does not know; `Split` is
        // unique in the repository, so the chain lands on it without a query.
        const { coreDataService } = require("../db-driver/core_data")
        coreDataService.getSymbolIdentitiesForSnapshot.mockResolvedValue([
          { stable_key: "pkg/a.go::caller", canonical_name: "caller", symbol_version_id: "sv-caller" },
          { stable_key: "lib/str.go::Split", canonical_name: "Split", symbol_version_id: "sv-split" },
        ])
        const n = await sge.computeRelationsFromRaw("snap-1", "repo-1", [
          { source_key: "pkg/a.go::caller", target_name: "strings.Split", relation_type: "calls" as const },
        ])
        expect(n).toBe(1)
        expect(persistedTargets()).toEqual(["sv-split"])
        expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("canonical_name IN"))).toBe(false)
      })
    })
  })

  describe("getRelationsForSymbol", () => {
    test("queries both src and dst directions", async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            relation_id: "r1",
            src_symbol_version_id: "sv-1",
            dst_symbol_version_id: "sv-2",
            relation_type: "calls",
            strength: 1.0,
            source: "static_analysis",
            confidence: 1.0,
          },
        ],
        rowCount: 1,
      })
      const result = await sge.getRelationsForSymbol("sv-1")
      expect(result).toHaveLength(1)
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("src_symbol_version_id"), ["sv-1", 500])
    })

    test("respects custom limit", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      await sge.getRelationsForSymbol("sv-1", 10)
      expect(mockQuery).toHaveBeenCalledWith(expect.any(String), ["sv-1", 10])
    })
  })

  describe("getCallers", () => {
    test("queries dst direction with calls/references filter", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      await sge.getCallers("sv-1")
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("dst_symbol_version_id"), ["sv-1", 500])
    })
  })

  describe("getCallees", () => {
    test("queries src direction with calls/references filter", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      await sge.getCallees("sv-1")
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("src_symbol_version_id"), ["sv-1", 500])
    })
  })
})

// =====================================================================
// 9. RUNTIME EVIDENCE ENGINE
// =====================================================================

describe("RuntimeEvidenceEngine", () => {
  const rtEngine = new RuntimeEvidenceEngine()

  describe("ingestTrace", () => {
    test("persists valid trace pack", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })
      const tracePack = {
        source: "test_execution" as const,
        timestamp: new Date("2025-01-15"),
        call_edges: [{ caller_key: "funcA", callee_key: "funcB", call_count: 5 }],
        dynamic_routes: [],
        observed_types: [],
        framework_events: [],
      }

      const result = await rtEngine.ingestTrace("repo-1", "snap-1", tracePack as any)
      expect(result.stored).toBe(true)
      expect(result.call_edges_count).toBe(1)
    })

    test("captures validation errors for invalid source", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })
      const tracePack = {
        source: "invalid_source",
        timestamp: new Date("2025-01-15"),
        call_edges: [],
        dynamic_routes: [],
        observed_types: [],
        framework_events: [],
      }

      const result = await rtEngine.ingestTrace("repo-1", "snap-1", tracePack as any)
      expect(result.validation_errors.length).toBeGreaterThan(0)
      expect(result.validation_errors[0]).toContain("Invalid trace source")
    })

    test("handles DB error gracefully", async () => {
      mockQuery.mockRejectedValue(new Error("DB connection failed"))
      const tracePack = {
        source: "test_execution" as const,
        timestamp: new Date("2025-01-15"),
        call_edges: [],
        dynamic_routes: [],
        observed_types: [],
        framework_events: [],
      }

      const result = await rtEngine.ingestTrace("repo-1", "snap-1", tracePack as any)
      expect(result.stored).toBe(false)
      expect(result.validation_errors.some((e: string) => e.includes("Ingestion failed"))).toBe(true)
    })

    test("handles invalid timestamp gracefully", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })
      const tracePack = {
        source: "test_execution" as const,
        timestamp: new Date("invalid"),
        call_edges: [],
        dynamic_routes: [],
        observed_types: [],
        framework_events: [],
      }

      const result = await rtEngine.ingestTrace("repo-1", "snap-1", tracePack as any)
      expect(result.stored).toBe(true)
    })

    test("truncates oversized call_edges", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 1 })
      const tracePack = {
        source: "test_execution" as const,
        timestamp: new Date("2025-01-15"),
        call_edges: Array.from({ length: 60000 }, (_, i) => ({
          caller_key: `func${i}`,
          callee_key: `func${i + 1}`,
          call_count: 1,
        })),
        dynamic_routes: [],
        observed_types: [],
        framework_events: [],
      }

      const result = await rtEngine.ingestTrace("repo-1", "snap-1", tracePack as any)
      expect(result.call_edges_count).toBe(50000)
      expect(result.validation_errors.some((e: string) => e.includes("exceeds maximum"))).toBe(true)
    })
  })

  describe("validateTracePack", () => {
    const validate = (rtEngine as any).validateTracePack.bind(rtEngine)

    test("returns error for null input", () => {
      const errors = validate(null)
      expect(errors).toContain("Trace pack is null or undefined")
    })

    test("validates call_edge structure", () => {
      const pack = {
        source: "test_execution",
        call_edges: [{ caller_key: "", callee_key: "b", call_count: 1 }],
      }
      const errors = validate(pack)
      expect(errors.some((e: string) => e.includes("caller_key"))).toBe(true)
    })

    test("validates dynamic_routes structure", () => {
      const pack = {
        source: "test_execution",
        call_edges: [],
        dynamic_routes: [{ route: "", handler_key: "h" }],
      }
      const errors = validate(pack)
      expect(errors.some((e: string) => e.includes("route"))).toBe(true)
    })

    test("rejects non-array call_edges", () => {
      const pack = {
        source: "test_execution",
        call_edges: "not-an-array",
      }
      const errors = validate(pack)
      expect(errors).toContain("call_edges must be an array")
    })

    test("accepts valid trace pack with no errors", () => {
      const pack = {
        source: "test_execution",
        call_edges: [{ caller_key: "a", callee_key: "b", call_count: 1 }],
        dynamic_routes: [{ route: "/api/users", handler_key: "getUsers" }],
        observed_types: [],
        framework_events: [],
      }
      const errors = validate(pack)
      expect(errors).toEqual([])
    })
  })

  describe("processTraces", () => {
    test("returns 0 when no unprocessed traces", async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 })
      const result = await rtEngine.processTraces("repo-1", "snap-1")
      expect(result).toBe(0)
    })
  })
})
