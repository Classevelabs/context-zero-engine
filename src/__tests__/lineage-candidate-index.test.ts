/**
 * Rename candidates come from an index, not a scan: the old symbols sharing
 * the most name bigrams, plus any sharing the body or normalized-AST hash,
 * within the same kind and language, never the symbol itself.
 */

jest.mock("../db-driver", () => ({ db: { query: jest.fn(), batchInsert: jest.fn(), transaction: jest.fn() } }))
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), startTimer: () => () => {} })),
}))

import { CandidateIndex, nameBigrams } from "../analysis-engine/symbol-lineage"

const sym = (canonical_name: string, over: Record<string, unknown> = {}) =>
  ({
    symbol_id: `id-${canonical_name}`,
    symbol_version_id: `sv-${canonical_name}`,
    canonical_name,
    kind: "function",
    language: "typescript",
    file_path: "src/a.ts",
    stable_key: `src/a.ts::${canonical_name}`,
    signature: "()",
    body_hash: `body-${canonical_name}`,
    normalized_ast_hash: null,
    logical_namespace: null,
    ...over,
  }) as any

describe("nameBigrams", () => {
  test("lower-cases and slides a window of two", () => {
    expect([...nameBigrams("AbC")]).toEqual(["ab", "bc"])
    expect([...nameBigrams("x")]).toEqual(["x"])
    expect(nameBigrams("").size).toBe(0)
  })
})

describe("CandidateIndex", () => {
  const oldByKind = new Map([
    [
      "function",
      [
        sym("loadUserProfile"),
        sym("loadUserSettings"),
        sym("renderChart"),
        sym("zz", { body_hash: "shared-body" }),
        sym("other", { language: "python" }),
      ],
    ],
    ["class", [sym("LoadUserProfile", { kind: "class" })]],
  ])
  const index = new CandidateIndex(oldByKind)

  test("ranks by shared bigrams and stays within kind and language", () => {
    const got = index.candidatesFor(sym("loadUserProfil"), 10).map((c) => c.sym.canonical_name)
    expect(got[0]).toBe("loadUserProfile")
    expect(got[1]).toBe("loadUserSettings")
    expect(got).not.toContain("LoadUserProfile") // a class
    expect(got).not.toContain("other") // python
  })

  test("a symbol with the same body is a candidate even when its name shares nothing", () => {
    const got = index.candidatesFor(sym("qq", { body_hash: "shared-body" }), 10).map((c) => c.sym.canonical_name)
    expect(got).toContain("zz")
  })

  test("never offers the symbol itself, and respects the limit", () => {
    const got = index.candidatesFor(sym("loadUserProfile"), 1).map((c) => c.sym.canonical_name)
    expect(got).not.toContain("loadUserProfile")
    expect(got.length).toBeLessThanOrEqual(2) // one by bigrams, hash matches always allowed through
  })

  test("returns nothing for a kind it has never seen", () => {
    expect(index.candidatesFor(sym("x", { kind: "enum" }), 10)).toEqual([])
  })
})
