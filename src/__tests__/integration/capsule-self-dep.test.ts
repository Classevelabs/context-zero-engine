/**
 * Integration test — a container is never emitted as its own dependency.
 *
 * Regression guard for the defect where `loadDirectDependencies`' member-scope
 * query (capsule-compiler.ts) re-admitted the container symbol itself: the
 * predicate `dst NOT IN (SELECT svid FROM scope WHERE svid <> $1)` excluded
 * sibling members from the dependency set but kept edges pointing back at the
 * class ($1), so a self-referential class (recursive fields, factories,
 * singletons, fluent builders, `new Self()`) listed itself as a dependency and
 * pasted its whole body a second time — duplicating content, defeating the
 * class-skeleton optimisation, and crowding real dependencies out of the budget.
 *
 * The pre-existing capsule.test.ts mocks the DB and never exercises this SQL, so
 * the bug was invisible to it. This test drives the real query end to end.
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
import { capsuleCompiler } from "../../analysis-engine/capsule-compiler"

const runRealDbTests = process.env["CONTEXTZERO_RUN_REAL_DB_TESTS"] === "1"
const describeRealDb = runRealDbTests ? describe : describe.skip

describeRealDb("a container is not its own dependency", () => {
  let repoDir: string
  let canRun = false
  let snapshotId = ""
  let treeNodeSvId = ""
  let basePath = ""

  beforeAll(async () => {
    if (!runRealDbTests) return
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cz-selfdep-"))
    process.env["SCG_ALLOWED_BASE_PATHS"] = os.tmpdir()
    try {
      await runPendingMigrations()
      await db.query("SELECT 1")
      await db.query("DELETE FROM repositories WHERE name LIKE 'cz-selfdep%'")
      canRun = true
    } catch {
      canRun = false
    }
    if (!canRun) return

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })
    // One genuine external dependency (makeId) plus heavy self-reference:
    // recursive fields, a method parameter, `new TreeNode()`, and a return type.
    fs.writeFileSync(
      path.join(repoDir, "src", "helper.ts"),
      "export function makeId(): string {\n  return Math.random().toString(36).slice(2)\n}\n",
    )
    fs.writeFileSync(
      path.join(repoDir, "src", "tree.ts"),
      'import { makeId } from "./helper"\n' +
        "export class TreeNode {\n" +
        "  children: TreeNode[] = []\n" +
        "  parent: TreeNode | null = null\n" +
        "  id: string = makeId()\n" +
        "  addChild(child: TreeNode): void {\n" +
        "    child.parent = this\n" +
        "    this.children.push(child)\n" +
        "  }\n" +
        "  clone(): TreeNode {\n" +
        "    const copy = new TreeNode()\n" +
        "    copy.children = this.children.map((c) => c.clone())\n" +
        "    return copy\n" +
        "  }\n" +
        "}\n",
    )
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "cz-selfdep", version: "1.0.0" }))
    fs.writeFileSync(
      path.join(repoDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "commonjs", moduleResolution: "node", strict: true },
        include: ["src"],
      }),
    )

    const cold = await ingestor.ingestRepo(repoDir, `cz-selfdep-${Date.now()}`, "cold", "main")
    if (cold.error) {
      canRun = false
      return
    }
    snapshotId = cold.snapshot_id as string
    basePath = repoDir

    const row = (
      await db.query(
        `SELECT sv.symbol_version_id AS id
           FROM symbol_versions sv
           JOIN symbols s ON s.symbol_id = sv.symbol_id
          WHERE sv.snapshot_id = $1 AND s.canonical_name = $2 AND s.kind = 'class'
          LIMIT 1`,
        [snapshotId, "TreeNode"],
      )
    ).rows[0]
    treeNodeSvId = row?.id ?? ""
  })

  afterAll(async () => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
    if (canRun) await db.query("DELETE FROM repositories WHERE name LIKE 'cz-selfdep%'").catch(() => {})
    await db.close().catch(() => {})
  })

  it("ingested the fixture and resolved the TreeNode class", () => {
    if (!canRun) return
    expect(treeNodeSvId).not.toBe("")
  })

  it("does not list the class as one of its own dependencies", async () => {
    if (!canRun) return
    const capsule = await capsuleCompiler.compile(treeNodeSvId, snapshotId, "standard", undefined, basePath)
    const deps = capsule.context_nodes.filter((n) => n.type === "dependency")
    const selfDeps = deps.filter((n) => n.symbol_id === treeNodeSvId || n.name === "TreeNode")
    // Before the fix this is non-empty: TreeNode is admitted as its own
    // dependency with its full body duplicated.
    expect(selfDeps).toEqual([])
  })

  it("still delivers the genuine external dependency (makeId)", async () => {
    if (!canRun) return
    const capsule = await capsuleCompiler.compile(treeNodeSvId, snapshotId, "standard", undefined, basePath)
    const deps = capsule.context_nodes.filter((n) => n.type === "dependency")
    // The fix must not throw the baby out: real cross-file deps still arrive.
    expect(deps.some((n) => n.name === "makeId")).toBe(true)
  })
})
