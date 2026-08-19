/**
 * BUG-002 — index-integrity guard COVERAGE.
 *
 * The behavioural tests for the guard live in mcp-bridge-handlers.test.ts.
 * This file guards the thing those tests cannot see: that the guard is
 * actually WIRED to every tool it is supposed to protect, on both transports.
 *
 * The failure this exists to catch is the one the fix was written to prevent —
 * a snapshot-resolving read tool that quietly ships without the check, and so
 * keeps answering "0 relations" from a partial index. A per-handler copy-paste
 * is how one gets missed; a policy table plus these assertions is how it gets
 * caught.
 *
 * Deliberately source-text based: it must not import the Express app (which
 * boots config, a pg pool and the migration runner on import), and a static
 * assertion is exactly the right shape for "this line is present in that file".
 */

import * as fs from "fs"
import * as path from "path"

const SRC = path.resolve(__dirname, "..")
const HANDLERS_SRC = fs.readFileSync(path.join(SRC, "mcp-bridge", "handlers.ts"), "utf-8")
const HTTP_SRC = fs.readFileSync(path.join(SRC, "mcp-interface", "index.ts"), "utf-8")

/** Tool names declared in the INDEX_INTEGRITY_POLICIES table, with their policy. */
function parsePolicyTable(): Map<string, string> {
  const start = HANDLERS_SRC.indexOf("export const INDEX_INTEGRITY_POLICIES")
  expect(start).toBeGreaterThan(-1)
  const end = HANDLERS_SRC.indexOf("\n}", start)
  const body = HANDLERS_SRC.slice(start, end)
  const table = new Map<string, string>()
  for (const m of body.matchAll(/^\s{2}(scg_[a-z0-9_]+):\s*"(strict|flag|diagnostic)",$/gm)) {
    table.set(m[1], m[2])
  }
  return table
}

function matchAllGroups(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map((m) => m[1])
}

const POLICIES = parsePolicyTable()

// Routes that resolve a snapshot but are WRITES, not reads. The mandate covers
// read tools; the change-transaction path has its own 'complete'-only gate in
// src/transactional-editor/index.ts. Listed explicitly so that adding a new
// READ route with a snapshot_id and forgetting the gate turns this file red.
const SNAPSHOT_WRITE_ROUTES = new Set([
  "scg_ingest_runtime_trace",
  "scg_incremental_index",
  "scg_batch_embed",
  "scg_persist_homologs",
  "scg_create_change_transaction",
  "scg_prepare_change",
])

describe("BUG-002 coverage — the guard is wired, not just written", () => {
  test("the policy table is populated and every entry names a known policy", () => {
    expect(POLICIES.size).toBeGreaterThanOrEqual(30)
    for (const [tool, policy] of POLICIES) {
      expect(tool).toMatch(/^scg_/)
      expect(["strict", "flag", "diagnostic"]).toContain(policy)
    }
  })

  test("all three shapes of the rule are actually in use", () => {
    const values = [...POLICIES.values()]
    expect(values).toContain("strict")
    expect(values).toContain("flag")
    expect(values).toContain("diagnostic")
  })

  test("the index-health tools are diagnostics — a broken index must stay diagnosable", () => {
    expect(POLICIES.get("scg_snapshot_stats")).toBe("diagnostic")
    expect(POLICIES.get("scg_get_uncertainty")).toBe("diagnostic")
  })

  test("the tools whose empty answer reads as dead code are strict", () => {
    // These are the answers a downstream agent turns into a deletion.
    for (const tool of [
      "scg_get_symbol_relations",
      "scg_get_neighbors",
      "scg_blast_radius",
      "scg_get_dispatch_edges",
      "scg_get_tests",
      "scg_explain_relation",
    ]) {
      expect(POLICIES.get(tool)).toBe("strict")
    }
  })

  describe("MCP bridge (src/mcp-bridge/handlers.ts)", () => {
    const guarded = matchAllGroups(HANDLERS_SRC, /guardRead\("(scg_[a-z0-9_]+)",/g)

    test("every tool in the policy table is exported through guardRead", () => {
      const missing = [...POLICIES.keys()].filter((t) => !guarded.includes(t))
      expect(missing).toEqual([])
    })

    test("every guardRead call names a tool in the policy table", () => {
      const unknown = guarded.filter((t) => !POLICIES.has(t))
      expect(unknown).toEqual([])
    })

    test("no tool is wrapped twice", () => {
      expect(new Set(guarded).size).toBe(guarded.length)
    })

    test("the unguarded …Impl functions are not exported — one public path per tool", () => {
      const exportedImpls = matchAllGroups(HANDLERS_SRC, /export (?:async function|const) (handle\w+Impl)\b/g)
      expect(exportedImpls).toEqual([])
    })

    test("'Index incomplete' is a safe error prefix, so the block message survives sanitization", () => {
      expect(HANDLERS_SRC).toContain('"Index incomplete",')
    })
  })

  describe("HTTP API (src/mcp-interface/index.ts)", () => {
    const gated = matchAllGroups(HTTP_SRC, /indexIntegrityGate\("(scg_[a-z0-9_]+)"\)/g)
    const routes = matchAllGroups(HTTP_SRC, /^ {2}"\/(scg_[a-z0-9_]+)",$/gm)

    test("every policy-table tool that has an HTTP route carries the gate", () => {
      const missing = [...POLICIES.keys()].filter((t) => routes.includes(t) && !gated.includes(t))
      expect(missing).toEqual([])
    })

    test("every gated route names a tool in the shared policy table", () => {
      const unknown = gated.filter((t) => !POLICIES.has(t))
      expect(unknown).toEqual([])
    })

    test("no route is gated twice", () => {
      expect(new Set(gated).size).toBe(gated.length)
    })

    test("every route that resolves a snapshot is either gated or a declared write", () => {
      // Split the file into route blocks and look at each one's validated body.
      const blocks = HTTP_SRC.split(/\napp\.(?:post|get)\(\n/).slice(1)
      const unguarded: string[] = []
      for (const block of blocks) {
        const name = /^ {2}"\/(scg_[a-z0-9_]+)",/.exec(block)?.[1]
        if (!name) continue
        const header = block.split(/\n {2}(?:safeHandler\(|async \(req)/)[0]
        const resolvesSnapshot = /\b(snapshot_id|base_snapshot_id):/.test(header)
        if (!resolvesSnapshot) continue
        if (gated.includes(name) || SNAPSHOT_WRITE_ROUTES.has(name)) continue
        unguarded.push(name)
      }
      expect(unguarded).toEqual([])
    })

    test("the HTTP gate reuses the shared helper rather than reimplementing the check", () => {
      expect(HTTP_SRC).toMatch(/import \{[\s\S]*?checkIndexIntegrity[\s\S]*?\} from "\.\.\/mcp-bridge\/handlers"/)
      expect(HTTP_SRC).toContain("mergeIntegrityAnnotation")
      // A blocked read is a 409: well-formed request, index state cannot answer it.
      expect(HTTP_SRC).toContain("res.status(409).json({ error: decision.message")
    })
  })
})
