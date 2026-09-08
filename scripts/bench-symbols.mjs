#!/usr/bin/env node
/**
 * Per-symbol cost, for named symbols, by the same method as the quality bench.
 *
 *   node scripts/bench-symbols.mjs <repo-path> [Name1 Name2 ...]
 *
 * For each symbol: what an agent pays to read the files that mention it
 * (best-first, capped like the quality baseline), against the capsule that
 * answers the same question. One pair per symbol, so a published chart of
 * named symbols can be regenerated instead of remembered.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (!process.env.CONTEXTZERO_ENV_FILE) process.env.CONTEXTZERO_ENV_FILE = path.join(root, ".env")
if (!process.env.SCG_LOG_LEVEL_OVERRIDE) process.env.SCG_LOG_LEVEL_OVERRIDE = "error"

const load = (r) => import(pathToFileURL(path.join(root, r)).href)
const { capsuleCompiler } = await load("dist/analysis-engine/capsule-compiler.js")
const { db } = await load("dist/db-driver/index.js")

const REPO = path.resolve(process.argv[2] || process.cwd())
const NAMES = process.argv.slice(3)
const REPO_NAME = process.env.CZ_BENCH_REPO_NAME || path.basename(REPO)
const BUDGET = parseInt(process.env.CZ_BENCH_BUDGET || "8000", 10)
const FILE_CAP = Number(process.env.CZ_BENCH_NAIVE_FILES || 25)

const tok = (bytes) => Math.round(bytes / 4)
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()

const snap = await db.query(
  "SELECT s.snapshot_id FROM snapshots s JOIN repositories r USING(repo_id)" +
    " WHERE r.name ILIKE $1 AND s.index_status = 'complete' ORDER BY s.indexed_at DESC LIMIT 1",
  [REPO_NAME + "%"],
)
if (snap.rowCount === 0) {
  console.error(`No complete snapshot for "${REPO_NAME}".`)
  process.exit(1)
}
const snapshotId = snap.rows[0].snapshot_id

const files = await db.query("SELECT path FROM files WHERE snapshot_id = $1", [snapshotId])
const corpus = new Map()
for (const row of files.rows) {
  const rel = norm(row.path)
  try {
    const text = fs.readFileSync(path.join(REPO, rel), "utf-8")
    corpus.set(rel, { tokens: tok(Buffer.byteLength(text, "utf-8")), idents: new Set(text.match(IDENT) || []) })
  } catch {
    /* indexed but not on disk */
  }
}

/** Files mentioning `name`, best-first by occurrence, capped like the baseline. */
function readingCost(name) {
  const hits = []
  for (const [rel, f] of corpus) if (f.idents.has(name)) hits.push({ rel, tokens: f.tokens })
  hits.sort((a, b) => b.tokens - a.tokens)
  return hits.slice(0, FILE_CAP).reduce((a, f) => a + f.tokens, 0)
}

const out = []
for (const name of NAMES) {
  const found = await db.query(
    "SELECT sv.symbol_version_id FROM symbol_versions sv JOIN symbols s USING(symbol_id)" +
      " JOIN files f ON f.file_id = sv.file_id WHERE f.snapshot_id = $1 AND s.canonical_name = $2 LIMIT 1",
    [snapshotId, name],
  )
  if (found.rowCount === 0) {
    out.push({ name, note: "not indexed" })
    continue
  }
  let capsule
  try {
    capsule = await capsuleCompiler.compile(found.rows[0].symbol_version_id, snapshotId, "strict", BUDGET)
  } catch (err) {
    out.push({ name, note: `capsule failed: ${err instanceof Error ? err.message : String(err)}` })
    continue
  }
  const cz = tok(Buffer.byteLength(JSON.stringify(capsule), "utf-8"))
  const base = readingCost(name)
  out.push({ name, base, cz, factor: cz > 0 ? +(base / cz).toFixed(2) : null })
}

console.log(JSON.stringify({ repo: REPO_NAME, snapshot: snapshotId, budget: BUDGET, symbols: out }, null, 2))
await db.close()
