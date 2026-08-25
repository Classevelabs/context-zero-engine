#!/usr/bin/env node
/**
 * Quality-per-token benchmark: what survives the compression.
 *
 *   node scripts/bench-quality.mjs [tasks] [/path/to/indexed/repo]
 *
 * Reporting a token reduction on its own proves nothing — returning an empty
 * response is a 100% reduction. The question worth measuring is whether the
 * smaller context still contains what someone needs to change the code safely.
 *
 * So both sides are given the SAME budget — the number of tokens the capsule
 * actually used — and scored on facts that can be checked exactly:
 *
 *   F1 implementation   the target's own body is present
 *   F2 caller evidence  the body of something that genuinely references the
 *                       target is present, verified by checking that text
 *                       literally contains the target's name
 *   F3 interface        signature, parameter and return types
 *
 * F2 is verified rather than asserted on purpose. An earlier version of this
 * benchmark tried to derive "the true set of callers" by finding the nearest
 * declaration above each grep hit, and a symbol named `Parameters` produced 151
 * of them, mostly imports and type annotations. Scoring against a ground truth
 * that bad measures the heuristic, not the engine. Here a caller only counts
 * when its own source references the target.
 *
 * The baseline is given every advantage available to it:
 *   - candidate files ranked best-first, by how often the symbol occurs
 *   - reading the defining file earns F1 and F3 outright, since the signature
 *     and types are right there in the source
 *   - it is charged nothing for the searching, and nothing for deciding what
 *     to open
 *
 * Effects are deliberately excluded from the score. A transitive effect
 * signature is not something reading one file can produce at any budget, so
 * including it would flatter the result rather than inform it; it is reported
 * separately instead.
 */
import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
if (!process.env.CONTEXTZERO_ENV_FILE) process.env.CONTEXTZERO_ENV_FILE = path.join(root, ".env")
if (!process.env.SCG_LOG_LEVEL_OVERRIDE) process.env.SCG_LOG_LEVEL_OVERRIDE = "error"

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href)
const { capsuleCompiler } = await load("dist/analysis-engine/capsule-compiler.js")
const { db } = await load("dist/db-driver/index.js")

const REPO = path.resolve(process.argv[3] || process.cwd())
const N = parseInt(process.argv[2] || "40", 10)
const TOKEN_BUDGET = parseInt(process.env.CZ_BENCH_BUDGET || "8000", 10)
const tok = (bytes) => Math.round(bytes / 4)
const SRC = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|rb|kt|swift|php)$/i

/** Source files referencing `name`, ranked by occurrence count, best first. */
function referencingFiles(name) {
  let files = []
  try {
    const out = execFileSync(
      "grep",
      ["-rlw", "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.git",
        "--exclude-dir=build", "--exclude=*.lock", "--exclude=package-lock.json", name, REPO],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    )
    files = out.split("\n").filter((f) => f && SRC.test(f))
  } catch {
    /* grep exits 1 when nothing matches */
  }
  return files
    .map((file) => {
      try {
        const text = fs.readFileSync(file, "utf-8")
        return {
          file,
          occurrences: text.split(new RegExp(`\\b${name}\\b`)).length - 1,
          tokens: tok(Buffer.byteLength(text, "utf-8")),
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.occurrences - a.occurrences)
}

const snapRes = await db.query(
  `SELECT s.snapshot_id FROM snapshots s JOIN repositories r USING(repo_id)
    WHERE r.name ILIKE $1 AND s.index_status = 'complete'
    ORDER BY s.indexed_at DESC LIMIT 1`,
  [`${path.basename(REPO)}%`],
)
if (snapRes.rowCount === 0) {
  console.error(`No complete snapshot for a repository named like "${path.basename(REPO)}". Ingest it first.`)
  process.exit(1)
}
const snapshotId = snapRes.rows[0].snapshot_id

const targets = await db.query(
  `SELECT sv.symbol_version_id, s.canonical_name AS name, f.path AS file_path
     FROM symbol_versions sv
     JOIN symbols s USING(symbol_id)
     JOIN files f ON f.file_id = sv.file_id
    WHERE f.snapshot_id = $1 AND s.kind IN ('function','method','class')
      AND LENGTH(COALESCE(sv.body_source,'')) > 500 AND LENGTH(s.canonical_name) >= 12
    ORDER BY RANDOM() LIMIT $2`,
  [snapshotId, N],
)

const rows = []
for (const target of targets.rows) {
  const ranked = referencingFiles(target.name)
  if (ranked.length === 0) continue

  let capsule
  try {
    // Pin the budget rather than letting it float. This is the budget the
    // scg_compile_context_capsule tool defaults to, so it is the configuration
    // an agent actually runs — and a floating budget quietly hands the
    // file-reading baseline more room as capsules grow richer, which measures
    // the benchmark rather than the engine.
    capsule = await capsuleCompiler.compile(target.symbol_version_id, snapshotId, "strict", TOKEN_BUDGET)
  } catch {
    continue
  }
  const budget = tok(Buffer.byteLength(JSON.stringify(capsule), "utf-8"))
  if (budget < 50) continue

  const nodes = capsule.context_nodes || []
  const nameRe = new RegExp(`\\b${target.name}\\b`)
  const callerNodes = nodes.filter((n) => n.type === "caller")
  const verifiedCallers = callerNodes.filter((n) => typeof n.code === "string" && nameRe.test(n.code))

  const cz = {
    f1: (capsule.target_symbol?.code?.length ?? 0) > 50,
    f2: verifiedCallers.length > 0,
    f3: !!capsule.target_symbol?.signature || nodes.some((n) => n.type === "contract"),
  }

  // Cost of the honest alternative: reading the files that mention the symbol,
  // capped at the 25 an agent would plausibly open before abandoning grep.
  const REALISTIC_FILE_CAP = 25
  const traditionalTokens = ranked.slice(0, REALISTIC_FILE_CAP).reduce((a, f) => a + f.tokens, 0)

  // Baseline: fill the same budget with the highest-signal files available.
  let spent = 0
  const read = []
  for (const f of ranked) {
    if (spent + f.tokens > budget) continue
    spent += f.tokens
    read.push(f)
  }
  const defBase = path.basename(target.file_path).toLowerCase()
  const defFileRead = read.some((f) => path.basename(f.file).toLowerCase() === defBase)
  const base = { f1: defFileRead, f2: read.length > (defFileRead ? 1 : 0), f3: defFileRead }

  const score = (o) => (o.f1 ? 1 : 0) + (o.f2 ? 1 : 0) + (o.f3 ? 1 : 0)
  rows.push({
    budget,
    traditionalTokens,
    czScore: score(cz),
    baseScore: score(base),
    cz,
    base,
    claimed: callerNodes.length,
    verified: verifiedCallers.length,
    hasEffects: (capsule.effect_signature?.length ?? 0) > 0,
    refFiles: ranked.length,
    afforded: read.length,
  })

  process.stderr.write(
    `  ${target.name.slice(0, 32).padEnd(32)} budget=${String(budget).padStart(6)}  ` +
      `cz=${score(cz)}/3  files=${score(base)}/3  afforded=${read.length}/${ranked.length}\n`,
  )
}

if (rows.length === 0) {
  console.error("No comparable targets found.")
  process.exit(1)
}

const avg = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length
const pct = (f) => +((rows.filter(f).length / rows.length) * 100).toFixed(1)
const claimed = rows.reduce((a, r) => a + r.claimed, 0)
const verified = rows.reduce((a, r) => a + r.verified, 0)

console.log(
  JSON.stringify(
    {
      repo: path.basename(REPO),
      tasks: rows.length,
      equal_token_budget: true,
      capsule_token_budget: TOKEN_BUDGET,
      avg_budget_tokens: Math.round(avg((r) => r.budget)),
      tokens_file_reading_total: rows.reduce((a, r) => a + r.traditionalTokens, 0),
      tokens_contextzero_total: rows.reduce((a, r) => a + r.budget, 0),
      token_reduction_pooled: +(
        rows.reduce((a, r) => a + r.traditionalTokens, 0) / Math.max(1, rows.reduce((a, r) => a + r.budget, 0))
      ).toFixed(1),
      token_savings_pooled_pct: +(
        (1 - rows.reduce((a, r) => a + r.budget, 0) / Math.max(1, rows.reduce((a, r) => a + r.traditionalTokens, 0))) * 100
      ).toFixed(1),
      token_reduction_median: +(() => {
        const rs = rows.map((r) => r.traditionalTokens / Math.max(1, r.budget)).sort((x, y) => x - y)
        return rs[Math.floor(rs.length / 2)]
      })().toFixed(1),
      contextzero_facts_of_3: +avg((r) => r.czScore).toFixed(2),
      filereading_facts_of_3: +avg((r) => r.baseScore).toFixed(2),
      has_implementation_pct: { contextzero: pct((r) => r.cz.f1), file_reading: pct((r) => r.base.f1) },
      has_verified_caller_pct: { contextzero: pct((r) => r.cz.f2), file_reading: pct((r) => r.base.f2) },
      has_interface_pct: { contextzero: pct((r) => r.cz.f3), file_reading: pct((r) => r.base.f3) },
      caller_precision_verified_pct: claimed ? +((verified / claimed) * 100).toFixed(1) : null,
      avg_referencing_files_in_repo: +avg((r) => r.refFiles).toFixed(1),
      avg_files_baseline_could_afford: +avg((r) => r.afforded).toFixed(2),
      tasks_contextzero_better: rows.filter((r) => r.czScore > r.baseScore).length,
      tasks_tied: rows.filter((r) => r.czScore === r.baseScore).length,
      tasks_file_reading_better: rows.filter((r) => r.czScore < r.baseScore).length,
      symbols_with_computed_effects_pct: pct((r) => r.hasEffects),
    },
    null,
    2,
  ),
)

await db.close()
