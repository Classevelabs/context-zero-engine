#!/usr/bin/env node
/**
 * Storage and re-index benchmark: what an index costs, and what it costs again.
 *
 *   node scripts/bench-storage.mjs [/path/to/repo] [repo-name]
 *
 * Two questions, because they fail independently.
 *
 * The first is how much a repository costs to hold. An index is a derived
 * artifact, so the only honest way to read its size is against the source it
 * describes: a tree of 2.91 MB producing 52 MB of database is the number that
 * starts an investigation, and "52 MB" alone is not. The breakdown below
 * separates heap from index, because those have entirely different causes — a
 * heap problem is a representation problem, an index problem is usually a
 * shape problem — and reports the vector columns individually, because one
 * column has repeatedly turned out to be most of the table.
 *
 * The second is what a re-index costs when nothing changed. That case is not a
 * curiosity, it is the common one: a watcher or a CI hook re-runs ingestion far
 * more often than the code actually moves. It is also the case that silently
 * degrades, because a full duplicate snapshot looks exactly like a successful
 * index from the outside. Measuring rows written on the second pass is what
 * catches it — the number should be zero, and for a long time it was not.
 *
 * Run it against a scratch database. It ingests twice and reports.
 */

import path from "path"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")

if (!process.env.CONTEXTZERO_ENV_FILE) {
  process.env.CONTEXTZERO_ENV_FILE = path.join(repoRoot, ".env")
}

const REPO_PATH = process.argv[2] ?? repoRoot
const REPO_NAME = process.argv[3] ?? "czbench-storage"

const toFileUrl = (p) => new URL(`file://${path.resolve(repoRoot, p).replace(/\\/g, "/")}`).href
const { ingestor } = await import(toFileUrl("dist/ingestor/index.js"))
const { db } = await import(toFileUrl("dist/db-driver/index.js"))

const rows = async (sql, params = []) => (await db.query(sql, params)).rows
const one = async (sql, params = []) => (await rows(sql, params))[0]

async function sourceBytes(dir) {
  const { readdir, stat } = await import("fs/promises")
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".gradle"])
  const SOURCE = /\.(ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|hpp|cs|kt|swift|sh)$/
  let total = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (SOURCE.test(entry.name)) total += (await stat(full)).size
    }
  }
  await walk(dir)
  return total
}

async function snapshot() {
  const totals = await one(`
    SELECT pg_database_size(current_database())          AS db_bytes,
           sum(pg_relation_size(relid))                  AS heap_bytes,
           sum(pg_indexes_size(relid))                   AS index_bytes
      FROM pg_stat_user_tables`)

  const counts = await one(`
    SELECT (SELECT count(*) FROM snapshots)                          AS snapshots,
           (SELECT count(*) FROM symbol_versions)                    AS versions,
           (SELECT count(DISTINCT body_hash) FROM symbol_versions)   AS distinct_bodies,
           (SELECT count(*) FROM semantic_vectors)                   AS vectors,
           (SELECT count(*) FROM idf_corpus)                         AS idf_rows`)

  const columns = await one(`
    SELECT COALESCE(sum(pg_column_size(sparse_vector)), 0)     AS sparse_bytes,
           COALESCE(sum(pg_column_size(minhash_signature)), 0) AS minhash_bytes,
           COALESCE(sum(pg_column_size(band_keys)), 0)         AS band_bytes,
           count(minhash_signature)                            AS with_signature
      FROM semantic_vectors`)

  const views = await rows(`
    SELECT view_type,
           count(*)                    AS rows,
           round(avg(token_count))     AS avg_tokens,
           count(minhash_signature)    AS with_signature,
           COALESCE(sum(pg_column_size(sparse_vector)), 0)     AS sparse_bytes,
           COALESCE(sum(pg_column_size(minhash_signature)), 0) AS minhash_bytes
      FROM semantic_vectors GROUP BY view_type ORDER BY count(*) DESC, view_type`)

  const deadIndexes = await one(`
    SELECT COALESCE(sum(pg_relation_size(indexrelid)), 0) AS bytes, count(*) AS count
      FROM pg_stat_user_indexes WHERE idx_scan = 0`)

  return { totals, counts, columns, views, deadIndexes }
}

const mb = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(2)} MB`
const kb = (bytes) => `${(Number(bytes) / 1024).toFixed(0)} kB`
const pad = (value, width) => String(value).padStart(width)

function report(label, s, sourceSize) {
  const { totals, counts, columns, views, deadIndexes } = s
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`)
  console.log(`  source indexed        ${mb(sourceSize)}`)
  console.log(`  database              ${mb(totals.db_bytes)}   (${(Number(totals.db_bytes) / sourceSize).toFixed(1)}x source)`)
  console.log(`    heap                ${mb(totals.heap_bytes)}`)
  console.log(`    index               ${mb(totals.index_bytes)}`)
  console.log(`    index never scanned ${mb(deadIndexes.bytes)} across ${deadIndexes.count}`)
  console.log(`  snapshots             ${counts.snapshots}`)
  console.log(
    `  symbol_versions       ${counts.versions}  (${counts.distinct_bodies} distinct bodies` +
      `, ${((Number(counts.distinct_bodies) / Math.max(Number(counts.versions), 1)) * 100).toFixed(1)}% unique)`,
  )
  console.log(`  semantic_vectors      ${counts.vectors} rows, ${counts.with_signature ?? columns.with_signature} with a signature`)
  console.log(`    sparse_vector       ${kb(columns.sparse_bytes)}`)
  console.log(`    minhash_signature   ${kb(columns.minhash_bytes)}`)
  console.log(`    band_keys           ${kb(columns.band_bytes)}`)
  console.log(`  idf_corpus rows       ${counts.idf_rows}${Number(counts.idf_rows) === 0 ? "   <- scoring falls back to term frequency" : ""}`)

  console.log(`\n  view        rows  avgTok  w/sig      sparse      minhash`)
  for (const v of views) {
    console.log(
      `  ${String(v.view_type).padEnd(10)} ${pad(v.rows, 5)}  ${pad(v.avg_tokens, 6)}  ${pad(v.with_signature, 5)}  ${pad(kb(v.sparse_bytes), 10)}  ${pad(kb(v.minhash_bytes), 10)}`,
    )
  }
}

const sourceSize = await sourceBytes(REPO_PATH)
console.log(`indexing ${REPO_PATH} as "${REPO_NAME}" (${mb(sourceSize)} of source)`)

const coldStart = Date.now()
const cold = await ingestor.ingestRepo(REPO_PATH, REPO_NAME, "bench-cold", "main")
const coldMs = Date.now() - coldStart
if (cold.error) {
  console.error(`cold ingest refused: ${cold.error}`)
  process.exit(1)
}
console.log(`\ncold ingest            ${coldMs} ms   ${cold.files_processed} files, ${cold.symbols_extracted} symbols`)

const before = await snapshot()
report("after a cold index", before, sourceSize)

const warmStart = Date.now()
const warm = await ingestor.ingestRepo(REPO_PATH, REPO_NAME, "bench-warm", "main", cold.snapshot_id)
const warmMs = Date.now() - warmStart
const after = await snapshot()

const addedVectors = Number(after.counts.vectors) - Number(before.counts.vectors)
const addedVersions = Number(after.counts.versions) - Number(before.counts.versions)
const addedSnapshots = Number(after.counts.snapshots) - Number(before.counts.snapshots)

console.log(`\nre-index, nothing changed  ${warmMs} ms   (${(coldMs / Math.max(warmMs, 1)).toFixed(1)}x faster than cold)`)
console.log(`  reported unchanged   ${warm.unchanged === true}`)
console.log(`  reused the snapshot  ${warm.snapshot_id === cold.snapshot_id}`)
console.log(`  rows added           ${addedSnapshots} snapshots, ${addedVersions} versions, ${addedVectors} vectors`)

const duplicated = addedSnapshots > 0 || addedVersions > 0 || addedVectors > 0
if (duplicated) {
  console.log(`\n  A second pass over unchanged source wrote rows. Every one of them`)
  console.log(`  duplicates something already stored, and the cost repeats on every`)
  console.log(`  pass after it.`)
}

await db.close?.()
process.exit(duplicated ? 1 : 0)
