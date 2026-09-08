/**
 * Integration test — incremental indexing preserves inbound (caller) edges.
 *
 * Regression guard for the defect where re-indexing a file cascade-deleted the
 * structural_relations pointing INTO that file (callers living in OTHER,
 * unchanged files), because dst_symbol_version_id carries ON DELETE CASCADE and
 * the caller's file is not re-extracted on an incremental pass. The result was
 * that editing one file silently erased every "who calls this?" answer for the
 * symbols it defines, while the snapshot still read 'complete'.
 *
 * Real DB only: opt in with CONTEXTZERO_RUN_REAL_DB_TESTS=1 (the same gate the
 * other real-PostgreSQL integration tests use). Skipped otherwise.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { db } from "../../db-driver"
import { runPendingMigrations } from "../../db-driver/migrate"
import { ingestor } from "../../ingestor"

const runRealDbTests = process.env["CONTEXTZERO_RUN_REAL_DB_TESTS"] === "1"
const describeRealDb = runRealDbTests ? describe : describe.skip

describeRealDb("incremental indexing preserves inbound caller edges", () => {
  let repoDir: string
  let canRun = false

  beforeAll(async () => {
    if (!runRealDbTests) return
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-edge-"))
    // ingestion resolves the repo by its own base_path; allow the temp tree.
    process.env["SCG_ALLOWED_BASE_PATHS"] = os.tmpdir()
    try {
      await runPendingMigrations() // idempotent; ensures the schema exists
      await db.query("SELECT 1")
      // The uuid mock is deterministic, so a re-run would mint the same repo_id
      // and collide on repositories_pkey. Clear anything a prior run of this
      // suite left behind (cascades to snapshots/symbols/relations).
      await db.query("DELETE FROM repositories WHERE name LIKE 'cz-edge%'")
      canRun = true
    } catch {
      canRun = false // no reachable/migratable database — the suite no-ops
    }
    if (!canRun) return

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, "src", "a.ts"),
      "export function calleeAlpha(x: number): number {\n  return x * 2\n}\n" +
        "export function calleeBeta(x: number): number {\n  return x + 1\n}\n",
    )
    fs.writeFileSync(
      path.join(repoDir, "src", "b.ts"),
      'import { calleeAlpha, calleeBeta } from "./a"\n' +
        "export function callerOne(n: number): number {\n  return calleeAlpha(n) + calleeBeta(n)\n}\n" +
        "export function callerTwo(n: number): number {\n  return calleeAlpha(n) - 1\n}\n",
    )
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "cz-edge", version: "1.0.0" }))
    fs.writeFileSync(
      path.join(repoDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", moduleResolution: "node", strict: true }, include: ["src"] }),
    )
  })

  afterAll(async () => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
    if (canRun) await db.query("DELETE FROM repositories WHERE name LIKE 'cz-edge%'").catch(() => {})
    await db.close().catch(() => {})
  })

  const inboundCount = async (snapshotId: string, callee: string): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n
             FROM structural_relations sr
             JOIN symbol_versions dv ON dv.symbol_version_id = sr.dst_symbol_version_id
             JOIN symbols d ON d.symbol_id = dv.symbol_id
             JOIN symbol_versions sv2 ON sv2.symbol_version_id = sr.src_symbol_version_id
            WHERE dv.snapshot_id = $1 AND d.canonical_name = $2 AND sv2.file_id <> dv.file_id`,
          [snapshotId, callee],
        )
      ).rows[0].n,
    )

  it("keeps a callee's cross-file callers after its own file is re-indexed", async () => {
    if (!canRun) return

    const cold = await ingestor.ingestRepo(repoDir, `cz-edge-${Date.now()}`, "cold", "main")
    expect(cold.error).toBeUndefined()
    const snapshotId = cold.snapshot_id as string

    // Precondition: b.ts's calls into a.ts were recorded as inbound edges.
    const beforeAlpha = await inboundCount(snapshotId, "calleeAlpha")
    expect(beforeAlpha).toBeGreaterThan(0)

    // Edit ONLY a.ts (the callee's file). b.ts is untouched, so nothing
    // re-extracts its edges — they must be re-pointed by the incremental pass.
    fs.appendFileSync(path.join(repoDir, "src", "a.ts"), "\nexport function calleeGamma(x: number): number {\n  return x - 3\n}\n")
    const inc = await ingestor.ingestIncremental(cold.repo_id as string, snapshotId, ["src/a.ts"], { refine: "deferred" })
    expect(inc.error).toBeUndefined()

    // The new symbol is indexed AND the pre-existing inbound edges survived.
    const afterAlpha = await inboundCount(snapshotId, "calleeAlpha")
    expect(afterAlpha).toBeGreaterThanOrEqual(beforeAlpha)

    // No edge points at a symbol_version that no longer exists.
    const dangling = Number(
      (
        await db.query(
          `SELECT count(*)::int AS n
             FROM structural_relations sr
             LEFT JOIN symbol_versions s1 ON s1.symbol_version_id = sr.src_symbol_version_id
             LEFT JOIN symbol_versions s2 ON s2.symbol_version_id = sr.dst_symbol_version_id
            WHERE (s1.snapshot_id = $1 OR s2.snapshot_id = $1)
              AND (s1.symbol_version_id IS NULL OR s2.symbol_version_id IS NULL)`,
          [snapshotId],
        )
      ).rows[0].n,
    )
    expect(dangling).toBe(0)
  }, 120_000)
})
