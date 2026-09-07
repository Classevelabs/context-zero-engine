#!/usr/bin/env node
/**
 * End-to-end benchmark: what this engine actually costs to run.
 *
 *   node scripts/bench-e2e.mjs <repo-path> [repo-name] [--fresh] [--json out.json]
 *
 * Unit tests answer whether the code is correct, which is a different question
 * from whether it is usable, and they answer it on inputs sized for speed. This
 * measures the real thing: a real repository, ingested into a real PostgreSQL,
 * queried through the same handler functions the MCP client calls.
 *
 * Four things get measured, because they fail independently and a good number
 * in one routinely hides a bad number in another.
 *
 *   ingest      cold, re-index with nothing changed, and a one-file edit —
 *               the three costs that actually occur, with peak RSS sampled
 *               throughout rather than reported at the end
 *   storage     the database against the source that produced it, split into
 *               heap and index, then per table and per column, because "57 MB"
 *               does not tell you whether to fix a representation or an index
 *   query       every major read path, many iterations over rotating inputs,
 *               reported as p50/p95/p99/max — an average hides the tail, and
 *               the tail is what a user feels
 *   integrity   how many of those calls actually returned an answer, since a
 *               handler that errors immediately benchmarks beautifully
 *
 * Percentiles come from rotating inputs so that a warm cache on one symbol
 * cannot stand in for the general case.
 */

import path from "path"
import { fileURLToPath } from "url"
import { readdir, stat, readFile, writeFile } from "fs/promises"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
if (!process.env.CONTEXTZERO_ENV_FILE) process.env.CONTEXTZERO_ENV_FILE = path.join(repoRoot, ".env")

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith("--")))
const positional = argv.filter((a) => !a.startsWith("--"))
const jsonIdx = argv.indexOf("--json")
const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : null

const REPO_PATH = positional[0] ?? repoRoot
const REPO_NAME = positional[1] ?? `bench-${path.basename(REPO_PATH).toLowerCase()}`
const QUERY_ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 40)

const url = (p) => new URL(`file://${path.resolve(repoRoot, p).replace(/\\/g, "/")}`).href

// ── infrastructure ──────────────────────────────────────────────────────────

if (flags.has("--fresh")) {
  const { getConnectionConfig } = await import(url("dist/db-driver/config.js"))
  const conn = getConnectionConfig()
  const pg = (await import("pg")).default
  const name = conn.database
  const admin = new pg.Client({
    host: conn.host, port: conn.port, user: conn.user, password: conn.password, database: "postgres",
  })
  await admin.connect()
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [name])
  const quoted = `"${String(name).replace(/"/g, '""')}"`
  await admin.query(`DROP DATABASE IF EXISTS ${quoted}`)
  await admin.query(`CREATE DATABASE ${quoted}`)
  await admin.end()
  const { execFileSync } = await import("child_process")
  execFileSync("npx", ["ts-node", "db/migrate.ts"], { cwd: repoRoot, stdio: "pipe", shell: true })
  console.log(`fresh database "${name}" created and migrated\n`)
}

const { ingestor } = await import(url("dist/ingestor/index.js"))
const { db } = await import(url("dist/db-driver/index.js"))
const H = await import(url("dist/mcp-bridge/handlers.js"))

const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await rows(sql, params))[0]
const quietLog = { debug() {}, info() {}, warn() {}, error() {} }

// ── helpers ─────────────────────────────────────────────────────────────────

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|c|h|cpp|cc|cxx|hpp|hh|hxx|cu|cuh|cs|rb|php|sh)$/
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".gradle", "target", "bin", "obj"])

async function sourceStats(dir) {
  let bytes = 0
  let files = 0
  let lines = 0
  const walk = async (cur) => {
    let entries
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIR.has(e.name)) continue
      const full = path.join(cur, e.name)
      if (e.isDirectory()) await walk(full)
      else if (SOURCE_EXT.test(e.name)) {
        const s = await stat(full)
        bytes += s.size
        files++
        if (s.size < 4_000_000) lines += (await readFile(full, "utf8")).split("\n").length
      }
    }
  }
  await walk(dir)
  return { bytes, files, lines }
}

/** Run `fn`, sampling RSS throughout so peak is measured rather than guessed. */
async function withPeakRss(fn) {
  const base = process.memoryUsage().rss
  let peak = base
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
  }, 200)
  timer.unref?.()
  const started = Date.now()
  try {
    const value = await fn()
    return { value, ms: Date.now() - started, peakRssBytes: peak, baseRssBytes: base }
  } finally {
    clearInterval(timer)
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

const mb = (b) => `${(Number(b) / 1048576).toFixed(2)} MB`
const kb = (b) => `${(Number(b) / 1024).toFixed(0)} kB`
const ms = (n) => `${n.toFixed(1)} ms`

// ── storage anatomy ─────────────────────────────────────────────────────────

async function storageAnatomy() {
  const totals = await one(`
    SELECT pg_database_size(current_database()) AS db,
           COALESCE(sum(pg_relation_size(relid)),0)  AS heap,
           COALESCE(sum(pg_indexes_size(relid)),0)   AS idx,
           COALESCE(sum(pg_total_relation_size(relid) - pg_relation_size(relid) - pg_indexes_size(relid)),0) AS toast
      FROM pg_stat_user_tables`)

  const counts = await one(`
    SELECT (SELECT count(*) FROM snapshots)                        AS snapshots,
           (SELECT count(*) FROM symbols)                          AS symbols,
           (SELECT count(*) FROM symbol_versions)                  AS versions,
           (SELECT count(DISTINCT body_hash) FROM symbol_versions) AS distinct_bodies,
           (SELECT count(*) FROM semantic_vectors)                 AS vectors,
           (SELECT count(*) FROM structural_relations)             AS relations,
           (SELECT count(*) FROM idf_corpus)                       AS idf_rows`)

  const tables = await rows(`
    SELECT relname AS name, n_live_tup AS rows,
           pg_relation_size(relid) AS heap, pg_indexes_size(relid) AS idx,
           pg_total_relation_size(relid) AS total
      FROM pg_stat_user_tables
     WHERE pg_total_relation_size(relid) > 0
     ORDER BY pg_total_relation_size(relid) DESC LIMIT 14`)

  const vectorCols = await one(`
    SELECT COALESCE(sum(pg_column_size(sparse_vector)),0)     AS sparse,
           COALESCE(sum(pg_column_size(minhash_signature)),0) AS minhash,
           COALESCE(sum(pg_column_size(band_keys)),0)         AS bands,
           count(minhash_signature)                           AS with_sig
      FROM semantic_vectors`)

  const versionCols = await one(`
    SELECT (SELECT COALESCE(sum(pg_column_size(body_source)),0) FROM symbol_bodies) AS body_source,
           COALESCE(sum(pg_column_size(signature)),0)   AS signature,
           COALESCE(sum(pg_column_size(ast_hash) + pg_column_size(body_hash)
                      + COALESCE(pg_column_size(normalized_ast_hash),0)),0) AS hashes,
           COALESCE(sum(pg_column_size(summary)),0)     AS summary
      FROM symbol_versions`)

  const idxTop = await rows(`
    SELECT relname AS tbl, indexrelname AS name, pg_relation_size(indexrelid) AS bytes, idx_scan AS scans
      FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 10`)

  const unused = await one(`
    SELECT COALESCE(sum(pg_relation_size(indexrelid)),0) AS bytes, count(*) AS n
      FROM pg_stat_user_indexes WHERE idx_scan = 0`)

  return { totals, counts, tables, vectorCols, versionCols, idxTop, unused }
}

// ── query benchmark ─────────────────────────────────────────────────────────

async function buildQueryCases(snapshotId, repoId) {
  const symbols = await rows(`
    SELECT sv.symbol_version_id, s.symbol_id, s.canonical_name, f.path
      FROM symbol_versions sv
      LEFT JOIN symbol_bodies sb ON sb.body_hash = sv.body_ref
      JOIN symbols s ON s.symbol_id = sv.symbol_id
      JOIN files f ON f.file_id = sv.file_id
     WHERE sv.snapshot_id = $1 AND sb.body_source IS NOT NULL
     ORDER BY length(sb.body_source) DESC
     LIMIT 60`, [snapshotId])

  if (symbols.length === 0) return []

  // Handlers that only answer for symbols carrying a particular artifact get
  // their own pool. Feeding them arbitrary symbols measures the not-found path,
  // which is fast for the wrong reason.
  const withContract = await rows(`
    SELECT sv.symbol_version_id FROM contract_profiles cp
      JOIN symbol_versions sv ON sv.symbol_version_id = cp.symbol_version_id
     WHERE sv.snapshot_id = $1 LIMIT 40`, [snapshotId])
  const withTests = await rows(`
    SELECT DISTINCT s.symbol_id FROM test_artifacts ta
      JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
      JOIN symbols s ON s.symbol_id = sv.symbol_id
     WHERE sv.snapshot_id = $1 LIMIT 40`, [snapshotId])

  const pick = (i) => symbols[i % symbols.length]
  const pickContract = (i) => (withContract.length ? withContract[i % withContract.length] : pick(i))
  const pickTestSym = (i) => (withTests.length ? withTests[i % withTests.length] : pick(i))
  const terms = ["parse configuration", "database connection", "error handling", "read file contents",
                 "validate input", "cache lookup", "authentication token", "retry on failure"]
  const patterns = ["function", "return", "async", "const", "error", "import"]

  return [
    ["scg_snapshot_stats",        H.handleSnapshotStats,       (i) => ({ snapshot_id: snapshotId })],
    ["scg_codebase_overview",     H.handleCodebaseOverview,    (i) => ({ repo_id: repoId, snapshot_id: snapshotId })],
    ["scg_resolve_symbol",        H.handleResolveSymbol,       (i) => ({ query: pick(i).canonical_name, repo_id: repoId, snapshot_id: snapshotId })],
    ["scg_get_symbol_details",    H.handleGetSymbolDetails,    (i) => ({ symbol_version_id: pick(i).symbol_version_id })],
    ["scg_get_neighbors",         H.handleGetNeighbors,        (i) => ({ symbol_version_id: pick(i).symbol_version_id, snapshot_id: snapshotId, depth: 2 })],
    ["scg_get_symbol_relations",  H.handleGetSymbolRelations,  (i) => ({ symbol_version_id: pick(i).symbol_version_id })],
    ["scg_get_behavioral_profile",H.handleGetBehavioralProfile,(i) => ({ symbol_version_id: pick(i).symbol_version_id })],
    ["scg_get_contract_profile",  H.handleGetContractProfile,  (i) => ({ symbol_version_id: pickContract(i).symbol_version_id })],
    ["scg_get_effect_signature",  H.handleGetEffectSignature,  (i) => ({ symbol_version_id: pick(i).symbol_version_id })],
    ["scg_get_tests",             H.handleGetTests,            (i) => ({ symbol_id: pickTestSym(i).symbol_id, snapshot_id: snapshotId })],
    ["scg_get_invariants",        H.handleGetInvariants,       (i) => ({ symbol_id: pick(i).symbol_id })],
    ["scg_get_temporal_risk",     H.handleGetTemporalRisk,     (i) => ({ symbol_id: pick(i).symbol_id, snapshot_id: snapshotId })],
    ["scg_read_source",           H.handleReadSource,          (i) => ({ repo_id: repoId, symbol_version_id: pick(i).symbol_version_id })],
    ["scg_search_code",           H.handleSearchCode,          (i) => ({ repo_id: repoId, pattern: patterns[i % patterns.length], max_results: 20 })],
    ["scg_semantic_search",       H.handleSemanticSearch,      (i) => ({ query: terms[i % terms.length], snapshot_id: snapshotId, limit: 10 })],
    ["scg_find_homologs",         H.handleFindHomologs,        (i) => ({ symbol_version_id: pick(i).symbol_version_id, snapshot_id: snapshotId, limit: 5 })],
    ["scg_blast_radius",          H.handleBlastRadius,         (i) => ({ symbol_version_ids: [pick(i).symbol_version_id], snapshot_id: snapshotId, depth: 2 })],
    ["scg_compile_context_capsule", H.handleCompileContextCapsule, (i) => ({ symbol_version_id: pick(i).symbol_version_id, snapshot_id: snapshotId, task: "modify this function safely" })],
    ["scg_smart_context",         H.handleSmartContext,        (i) => ({ task_description: terms[i % terms.length], target_symbol_version_ids: [pick(i).symbol_version_id], snapshot_id: snapshotId, repo_id: repoId, token_budget: 20000 })],
  ].filter(([, fn]) => typeof fn === "function")
}

async function benchQueries(snapshotId, repoId, iterations) {
  const cases = await buildQueryCases(snapshotId, repoId)
  const results = []

  for (const [name, fn, argsFor] of cases) {
    const samples = []
    let ok = 0
    let failed = 0
    let firstError = null
    let bytes = 0

    // One untimed call so a cold plan cache is not charged to p50.
    try {
      await fn(argsFor(0), quietLog)
    } catch {
      /* measured below */
    }

    for (let i = 0; i < iterations; i++) {
      const t0 = process.hrtime.bigint()
      try {
        const res = await fn(argsFor(i), quietLog)
        const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
        samples.push(elapsed)
        if (res?.isError) {
          failed++
          if (!firstError) firstError = String(res?.content?.[0]?.text ?? "error").slice(0, 120)
        } else {
          ok++
          bytes += JSON.stringify(res?.content ?? "").length
        }
      } catch (err) {
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
        failed++
        if (!firstError) firstError = String(err?.message ?? err).slice(0, 120)
      }
    }

    samples.sort((a, b) => a - b)
    results.push({
      name,
      ok,
      failed,
      firstError,
      avgBytes: ok > 0 ? Math.round(bytes / ok) : 0,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples[samples.length - 1] ?? 0,
    })
  }
  return results
}

// ── run ─────────────────────────────────────────────────────────────────────

const src = await sourceStats(REPO_PATH)
console.log(`repository   ${REPO_PATH}`)
console.log(`source       ${src.files} files, ${src.lines.toLocaleString()} lines, ${mb(src.bytes)}`)
console.log(`iterations   ${QUERY_ITERATIONS} per query\n`)

console.log("── ingest ──────────────────────────────────────────────────────")
const cold = await withPeakRss(() => ingestor.ingestRepo(REPO_PATH, REPO_NAME, "bench-cold", "main"))
if (cold.value.error) {
  console.error(`cold ingest refused: ${cold.value.error}`)
  process.exit(1)
}
const snapshotId = cold.value.snapshot_id
console.log(
  `cold           ${ms(cold.ms)}  ${cold.value.files_processed} files, ${cold.value.symbols_extracted} symbols` +
    `  peak RSS ${mb(cold.peakRssBytes)}`,
)
console.log(
  `               ${(cold.value.symbols_extracted / (cold.ms / 1000)).toFixed(0)} symbols/s` +
    `, ${(src.lines / (cold.ms / 1000)).toFixed(0)} lines/s`,
)

const beforeWarm = await one(`SELECT count(*) AS v FROM semantic_vectors`)
const warm = await withPeakRss(() => ingestor.ingestRepo(REPO_PATH, REPO_NAME, "bench-warm", "main", snapshotId))
const afterWarm = await one(`SELECT count(*) AS v FROM semantic_vectors`)
const warmAdded = Number(afterWarm.v) - Number(beforeWarm.v)
console.log(
  `re-index       ${ms(warm.ms)}  unchanged=${warm.value.unchanged === true}` +
    `, vectors added ${warmAdded}  peak RSS ${mb(warm.peakRssBytes)}`,
)

// One-file edit: the cost a watcher actually pays after a keystroke settles.
const edited = await one(
  `SELECT f.path FROM files f
     JOIN symbol_versions sv ON sv.file_id = f.file_id
    WHERE f.snapshot_id = $1 GROUP BY f.path ORDER BY count(*) DESC LIMIT 1`,
  [snapshotId],
)
let incremental = null
if (edited?.path) {
  incremental = await withPeakRss(() =>
    ingestor.ingestIncremental(cold.value.repo_id, snapshotId, [edited.path], { refine: "deferred" }),
  )
  console.log(
    `one-file edit  ${ms(incremental.ms)}  ${edited.path}` +
      `  peak RSS ${mb(incremental.peakRssBytes)}`,
  )
}

console.log("\n── storage ─────────────────────────────────────────────────────")
const st = await storageAnatomy()
const perSource = Number(st.totals.db) / src.bytes
console.log(`database       ${mb(st.totals.db)}   ${perSource.toFixed(1)}x source, ${(Number(st.totals.db) / Math.max(Number(st.counts.versions), 1)).toFixed(0)} B/symbol`)
console.log(`  heap         ${mb(st.totals.heap)}   ${((Number(st.totals.heap) / Number(st.totals.db)) * 100).toFixed(0)}%`)
console.log(`  index        ${mb(st.totals.idx)}   ${((Number(st.totals.idx) / Number(st.totals.db)) * 100).toFixed(0)}%`)
console.log(`  toast        ${mb(st.totals.toast)}`)
console.log(`  never scanned ${mb(st.unused.bytes)} across ${st.unused.n} indexes`)
console.log(
  `symbols ${st.counts.symbols}, versions ${st.counts.versions} (${st.counts.distinct_bodies} distinct bodies)` +
    `, vectors ${st.counts.vectors}, relations ${st.counts.relations}, idf rows ${st.counts.idf_rows}`,
)

console.log(`\n  table                    rows      heap     index     total`)
for (const t of st.tables) {
  console.log(
    `  ${String(t.name).padEnd(22)} ${String(t.rows).padStart(7)}  ${kb(t.heap).padStart(9)} ${kb(t.idx).padStart(9)} ${kb(t.total).padStart(9)}`,
  )
}

console.log(`\n  semantic_vectors columns: sparse ${kb(st.vectorCols.sparse)}, minhash ${kb(st.vectorCols.minhash)} (${st.vectorCols.with_sig} rows), bands ${kb(st.vectorCols.bands)}`)
console.log(`  bodies (symbol_bodies) ${kb(st.versionCols.body_source)}; symbol_versions columns: hashes ${kb(st.versionCols.hashes)}, signature ${kb(st.versionCols.signature)}, summary ${kb(st.versionCols.summary)}`)

console.log(`\n  largest indexes`)
for (const i of st.idxTop) {
  console.log(`  ${String(i.name).padEnd(48)} ${kb(i.bytes).padStart(9)}  ${String(i.scans).padStart(7)} scans`)
}

console.log("\n── query latency ───────────────────────────────────────────────")
const q = await benchQueries(snapshotId, cold.value.repo_id, QUERY_ITERATIONS)
console.log(`  handler                          p50       p95       p99       max    ok/fail   avg bytes`)
for (const r of q) {
  console.log(
    `  ${r.name.padEnd(30)} ${ms(r.p50).padStart(9)} ${ms(r.p95).padStart(9)} ${ms(r.p99).padStart(9)} ${ms(r.max).padStart(9)}` +
      `  ${String(`${r.ok}/${r.failed}`).padStart(8)}  ${String(r.avgBytes).padStart(9)}`,
  )
}
const broken = q.filter((r) => r.failed > 0)
if (broken.length > 0) {
  console.log(`\n  handlers returning errors (a fast error is not a fast answer):`)
  for (const r of broken) console.log(`    ${r.name}: ${r.failed}/${r.ok + r.failed} — ${r.firstError}`)
}

const rssNow = process.memoryUsage()
console.log(`\n── memory ──────────────────────────────────────────────────────`)
console.log(`  before any ingest        ${mb(cold.baseRssBytes)}  (engine loaded, idle)`)
console.log(`  peak during cold ingest  ${mb(cold.peakRssBytes)}  (+${mb(cold.peakRssBytes - cold.baseRssBytes)} for the ingest itself)`)
console.log(`  peak during re-index     ${mb(warm.peakRssBytes)}`)
if (incremental) console.log(`  peak during one-file     ${mb(incremental.peakRssBytes)}`)
console.log(`  after query load         rss ${mb(rssNow.rss)}, heap used ${mb(rssNow.heapUsed)}`)

if (jsonOut) {
  await writeFile(
    path.resolve(jsonOut),
    JSON.stringify(
      {
        // basename, not the absolute path — these files are committed to a
        // public repo and REPO_PATH is wherever the machine happened to run.
        // Matches bench-quality.mjs / bench-context-quality.mjs.
        repo: path.basename(REPO_PATH), name: REPO_NAME, source: src,
        ingest: {
          coldMs: cold.ms, coldPeakRss: cold.peakRssBytes,
          warmMs: warm.ms, warmVectorsAdded: warmAdded,
          incrementalMs: incremental?.ms ?? null,
        },
        storage: st, queries: q,
      },
      null, 2,
    ),
  )
  console.log(`\njson written to ${path.resolve(jsonOut)}`)
}

await db.close?.()
process.exit(0)
