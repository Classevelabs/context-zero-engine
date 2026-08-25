#!/usr/bin/env node
/**
 * Context-quality benchmark: does the smaller context still carry the work?
 *
 *   node scripts/bench-context-quality.mjs [tasks] [/path/to/indexed/repo]
 *
 * A token reduction on its own proves nothing — an empty response is a 100%
 * reduction. Two things have to be true at once: the context has to be small,
 * and it has to still contain what the change depends on. Both are measured
 * here from one run, against ground truth read off disk rather than taken from
 * the engine's own graph.
 *
 * GROUND TRUTH — the imports the body actually uses
 *   The target's source is re-read from the file by line range. The defining
 *   file's import statements are parsed, each specifier is resolved to a real
 *   file in the repository, and a dependency is counted when the imported name
 *   appears in the target's own body. That is exact: a name the code uses, a
 *   file it lives in, neither derived from anything the engine believes.
 *   Specifiers that leave the repository (npm packages, node builtins) are
 *   dropped — no capsule and no amount of file-reading would supply them, so
 *   scoring them would measure the package manager.
 *
 * TWO RECALL NUMBERS, ON PURPOSE
 *   `overall` counts every resolved dependency. `of_indexed_symbols` counts
 *   only those the graph could name at all — where a symbol of that name is
 *   indexed in the resolved file. The gap between them is the indexing gap
 *   (exports the extractor never recorded); the shortfall inside
 *   `of_indexed_symbols` is the selection gap (known, not chosen). They are
 *   different engineering problems and are reported apart.
 *
 * THE COMPARISON
 *   Both sides get the same budget: the tokens the capsule actually spent.
 *   The baseline greps for the symbol and reads the files that mention it,
 *   best-first by occurrence count, charged nothing for the search or for
 *   deciding what to open. Both sides draw from the same universe of files —
 *   the ones the index covers — so neither is credited for reach the other
 *   never had.
 *
 * THE ORACLE
 *   The baseline is then given what no real agent has: perfect foreknowledge
 *   of which files it needs. Oracle cost is the token size of the smallest set
 *   of files carrying the same dependencies the capsule delivered, plus the
 *   defining file and one caller. That is the honest price of the same
 *   information by reading, and it is the ratio worth quoting.
 *
 * NOT COUNTED AS A WIN
 *   Effects, contracts and invariants stay out of the score — reading a file
 *   cannot produce a transitive effect signature at any budget, so scoring it
 *   would measure the definition rather than the engine. They are characterised
 *   instead: how many effect entries were read out of the function's own body,
 *   how many arrived by propagation around a call cycle, and how many symbols
 *   end up with the same effect set. Volume is easy to manufacture that way;
 *   the split says how much of it carries information.
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

const REPO = path.resolve(process.argv[3] || process.cwd())
const N = parseInt(process.argv[2] || "40", 10)
const BUDGET = parseInt(process.env.CZ_BENCH_BUDGET || "8000", 10)
const MIN_NAME = parseInt(process.env.CZ_BENCH_MIN_NAME || "12", 10)
const tok = (bytes) => Math.round(bytes / 4)
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g
const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()

// -------------------------------------------------------------- snapshot ---
const snapRes = await db.query(
  "SELECT s.snapshot_id FROM snapshots s JOIN repositories r USING(repo_id)" +
    " WHERE r.name ILIKE $1 AND s.index_status = 'complete'" +
    " ORDER BY s.indexed_at DESC LIMIT 1",
  [path.basename(REPO) + "%"],
)
if (snapRes.rowCount === 0) {
  console.error('No complete snapshot for a repository named like "' + path.basename(REPO) + '".')
  process.exit(1)
}
const snapshotId = snapRes.rows[0].snapshot_id

const fileRes = await db.query("SELECT path FROM files WHERE snapshot_id = $1", [snapshotId])

// ---------------------------------------------------------------- corpus ---
// The shared universe: exactly the files the index covers, read off disk.
// Anything the index never saw is out of scope for both sides, so neither is
// scored against reach the other did not have.
const t0 = Date.now()
const corpus = new Map() // normalized repo-relative path -> { text, tokens, idents }
let missing = 0
for (const row of fileRes.rows) {
  const relPath = norm(row.path)
  const abs = path.join(REPO, relPath)
  let text
  try {
    text = fs.readFileSync(abs, "utf-8")
  } catch {
    missing++
    continue
  }
  corpus.set(relPath, {
    text,
    tokens: tok(Buffer.byteLength(text, "utf-8")),
    idents: new Set(text.match(IDENT) || []),
  })
}
const corpusMs = Date.now() - t0
if (corpus.size === 0) {
  console.error("Indexed files are not readable under " + REPO)
  process.exit(1)
}

/** Files whose identifier set contains `name`, best-first by occurrence count. */
const referencing = (name) => {
  const re = new RegExp("\\b" + name + "\\b", "g")
  const out = []
  for (const [p, f] of corpus) {
    if (!f.idents.has(name)) continue
    out.push({ file: p, tokens: f.tokens, occurrences: (f.text.match(re) || []).length })
  }
  return out.sort((a, b) => b.occurrences - a.occurrences)
}

// ------------------------------------------------------ module resolution ---
const EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]
const hit = (base) => {
  for (const e of EXTS) if (corpus.has(base + e)) return base + e
  return null
}
const packageRootOf = (relPath) => {
  const m = relPath.match(/^((?:packages|services|apps|libs)\/[^/]+)\//)
  return m ? m[1] : null
}

// Workspace packages, so a specifier like "@scope/ui/toast" resolves the way
// the bundler resolves it rather than by a guess about directory layout.
// Without this, internal cross-package imports silently vanish from the ground
// truth, and a dependency the capsule was never asked for cannot be scored.
const workspace = new Map() // package name -> { dir, exports }
const findManifests = (dir, depth) => {
  if (depth > 4) return
  let entries
  try {
    entries = fs.readdirSync(path.join(REPO, dir || "."), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = dir ? dir + "/" + e.name : e.name
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".claude") continue
      findManifests(rel, depth + 1)
    } else if (e.name === "package.json") {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf-8"))
        if (pkg.name) workspace.set(pkg.name, { dir: norm(dir), exports: pkg.exports, main: pkg.main || pkg.module })
      } catch {
        /* an unparseable manifest is not this benchmark's problem */
      }
    }
  }
}
findManifests("", 0)

const conditionTarget = (value) => {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    for (const key of ["import", "module", "default", "require", "types"]) {
      const nested = conditionTarget(value[key])
      if (nested) return nested
    }
  }
  return null
}
/** Apply a package's `exports` map to a subpath, honouring `*` patterns. */
const applyExports = (exp, subpath) => {
  if (!exp) return null
  if (typeof exp === "string") return subpath === "." ? exp : null
  const exact = conditionTarget(exp[subpath])
  if (exact) return exact
  for (const [pattern, value] of Object.entries(exp)) {
    if (!pattern.includes("*")) continue
    const [head, tail] = pattern.split("*")
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue
    const filled = subpath.slice(head.length, subpath.length - (tail.length || 0))
    const target = conditionTarget(value)
    if (target) return target.replace("*", filled)
  }
  return null
}

/** Resolve an import specifier to a file in the shared universe, or null. */
const resolveSpec = (spec, fromRel) => {
  if (spec.startsWith(".")) {
    return hit(norm(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))))
  }
  if (spec.startsWith("@/")) {
    const pkg = packageRootOf(fromRel)
    return pkg ? hit(norm(pkg + "/src/" + spec.slice(2))) : null
  }
  // Longest workspace package name that prefixes the specifier.
  let best = null
  for (const name of workspace.keys()) {
    if (spec === name || spec.startsWith(name + "/")) {
      if (!best || name.length > best.length) best = name
    }
  }
  if (best) {
    const entry = workspace.get(best)
    const subpath = spec === best ? "." : "." + spec.slice(best.length)
    const target = applyExports(entry.exports, subpath) || (subpath === "." ? entry.main : null)
    if (target) {
      const resolved = hit(norm(path.posix.join(entry.dir, target.replace(/^\.\//, ""))))
      if (resolved) return resolved
    }
    // Manifest gave nothing usable; fall back to the conventional layout.
    const tail = subpath === "." ? "index" : subpath.slice(2)
    return hit(norm(path.posix.join(entry.dir, "src", tail))) || hit(norm(path.posix.join(entry.dir, tail)))
  }
  return null // npm package or node builtin: outside the repository
}

const IMPORT_RE = /import\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g
const isInternal = (spec) => {
  if (spec.startsWith(".") || spec.startsWith("@/")) return true
  for (const name of workspace.keys()) if (spec === name || spec.startsWith(name + "/")) return true
  return false
}
// Imports that point inside the repository but resolve to nothing are dropped
// from the ground truth. Counted, so the size of that blind spot is stated
// rather than hidden.
const resolution = { internal: 0, dropped: 0 }
/** Local bindings a file imports, mapped to { imported, file }. */
const importBindings = (text, fromRel) => {
  const out = new Map()
  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const clause = m[1]
    const file = resolveSpec(m[2], fromRel)
    if (isInternal(m[2])) {
      resolution.internal++
      if (!file) resolution.dropped++
    }
    if (!file) continue
    const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (nsMatch) out.set(nsMatch[1], { imported: "*", file, namespace: true })
    const braced = clause.match(/\{([\s\S]*?)\}/)
    if (braced) {
      for (const part of braced[1].split(",")) {
        const bits = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)
        const imported = bits[0]?.trim()
        const local = (bits[1] || bits[0] || "").trim()
        if (imported && local && /^[A-Za-z_$][\w$]*$/.test(local)) out.set(local, { imported, file })
      }
    }
    const def = clause.replace(/\{[\s\S]*?\}/, "").replace(/\*\s+as\s+[\w$]+/, "").split(",")[0]?.trim()
    if (def && /^[A-Za-z_$][\w$]*$/.test(def)) out.set(def, { imported: def, file, default: true })
  }
  return out
}

// Symbols the index knows, per file, so the indexing gap can be separated
// from the selection gap.
const defRes = await db.query(
  "SELECT s.canonical_name AS name, f.path AS file_path" +
    " FROM symbol_versions sv JOIN symbols s USING(symbol_id) JOIN files f ON f.file_id = sv.file_id" +
    " WHERE f.snapshot_id = $1",
  [snapshotId],
)
const symbolsInFile = new Map() // normalized path -> Set(name)
for (const r of defRes.rows) {
  const p = norm(r.file_path)
  let set = symbolsInFile.get(p)
  if (!set) symbolsInFile.set(p, (set = new Set()))
  set.add(r.name)
}

const targets = await db.query(
  "SELECT sv.symbol_version_id, s.canonical_name AS name, f.path AS file_path," +
    " sv.range_start_line, sv.range_end_line" +
    " FROM symbol_versions sv JOIN symbols s USING(symbol_id) JOIN files f ON f.file_id = sv.file_id" +
    " WHERE f.snapshot_id = $1 AND s.kind IN ('function','method','class')" +
    " AND LENGTH(COALESCE(sv.body_source,'')) > 500 AND LENGTH(s.canonical_name) >= $3" +
    " ORDER BY RANDOM() LIMIT $2",
  [snapshotId, N, MIN_NAME],
)

// ------------------------------------------------------------------ run ---
const rows = []
for (const t of targets.rows) {
  const defRel = norm(t.file_path)
  const defFile = corpus.get(defRel)
  if (!defFile) continue

  // Ground-truth body, straight off disk.
  const lines = defFile.text.split(/\r?\n/)
  const body = lines.slice(Math.max(0, t.range_start_line - 1), t.range_end_line).join("\n")
  if (body.length < 400) continue
  const bodyIdents = new Set(body.match(IDENT) || [])

  // Dependencies: imported names this body actually uses, resolved to files.
  const deps = new Map() // canonical name -> { file, indexed }
  for (const [local, info] of importBindings(defFile.text, defRel)) {
    if (!bodyIdents.has(local)) continue
    const known = symbolsInFile.get(info.file) || new Set()
    if (info.namespace) {
      // `ns.member` — credit the members the body actually reaches for.
      const re = new RegExp("\\b" + local + "\\.([A-Za-z_$][\\w$]*)", "g")
      let m
      while ((m = re.exec(body)) !== null) {
        deps.set(m[1], { file: info.file, indexed: known.has(m[1]) })
      }
      continue
    }
    if (info.imported === local && local === t.name) continue
    deps.set(info.imported, { file: info.file, indexed: known.has(info.imported) })
  }
  deps.delete(t.name)

  let capsule
  const tc = Date.now()
  try {
    capsule = await capsuleCompiler.compile(t.symbol_version_id, snapshotId, "strict", BUDGET)
  } catch {
    continue
  }
  const compileMs = Date.now() - tc
  const spent = tok(Buffer.byteLength(JSON.stringify(capsule), "utf-8"))
  if (spent < 50) continue

  const nodes = capsule.context_nodes || []
  const delivered = new Map() // name -> a real body came with it
  for (const n of nodes) {
    if (!n.name) continue
    const hasCode = typeof n.code === "string" && n.code.length > 40
    delivered.set(n.name, (delivered.get(n.name) || false) || hasCode)
  }

  const depNames = [...deps.keys()]
  const indexedDeps = depNames.filter((d) => deps.get(d).indexed)
  const czDeps = depNames.filter((d) => delivered.get(d) === true)
  const czIndexedDeps = indexedDeps.filter((d) => delivered.get(d) === true)

  // How the capsule spent its room. A node repeated under the same name and
  // type is paid for twice and read once, so it is measured as waste.
  const seen = new Set()
  let dupNodes = 0
  let dupTokens = 0
  for (const n of nodes) {
    const key = n.type + " " + n.name + " " + (n.symbol_id ?? "")
    if (seen.has(key)) {
      dupNodes++
      dupTokens += tok(Buffer.byteLength(JSON.stringify(n), "utf-8"))
      continue
    }
    seen.add(key)
  }

  const nameRe = new RegExp("\\b" + t.name + "\\b")
  const czCaller = nodes.some((n) => n.type === "caller" && typeof n.code === "string" && nameRe.test(n.code))
  const czImpl = (capsule.target_symbol?.code?.length ?? 0) > 50
  const czIface = !!capsule.target_symbol?.signature

  // Baseline at the same budget: grep, then read best-first until full.
  const ranked = referencing(t.name)
  const read = []
  let used = 0
  for (const f of ranked) {
    if (used + f.tokens > spent) continue
    used += f.tokens
    read.push(f)
  }
  const readSet = new Set(read.map((f) => f.file))
  const defReadIn = readSet.has(defRel)
  const baseDeps = depNames.filter((d) => readSet.has(deps.get(d).file))
  const baseCaller = read.some((f) => f.file !== defRel)

  // Oracle: the cheapest pile of files carrying what the capsule carried.
  const oracleFiles = new Set([defRel])
  for (const d of czDeps) oracleFiles.add(deps.get(d).file)
  if (czCaller) {
    const c = ranked.find((f) => f.file !== defRel)
    if (c) oracleFiles.add(c.file)
  }
  let oracleTokens = 0
  for (const f of oracleFiles) oracleTokens += corpus.get(f)?.tokens ?? 0

  // Naive cost: what the grep-and-read agent actually pays, capped at 25 files.
  const naiveTokens = ranked.slice(0, 25).reduce((a, f) => a + f.tokens, 0)

  // Effects are not scored, they are characterised. An effect the analyser
  // read out of this function's own body is worth more than one propagated
  // around a call cycle, where a strongly connected component ends up handing
  // every member the union of everyone's effects. Counting the entries by
  // where they came from — and how many symbols end up with byte-identical
  // effect sets — says how much of the volume is actually information.
  const effects = capsule.effect_signature || []
  let effDirect = 0
  let effCycle = 0
  for (const e of effects) {
    if (!e.provenance || e.provenance === "direct") effDirect++
    if (String(e.detail || "").startsWith("[cycle-propagated]")) effCycle++
  }
  const effectTokens = effects.length ? tok(Buffer.byteLength(JSON.stringify(effects), "utf-8")) : 0
  const effectFingerprint = effects.length
    ? [...new Set(effects.map((e) => e.descriptor))].sort().join(",")
    : null

  rows.push({
    name: t.name,
    spent,
    naiveTokens,
    oracleTokens,
    depsTotal: deps.size,
    depsIndexed: indexedDeps.length,
    czDeps: czDeps.length,
    czIndexedDeps: czIndexedDeps.length,
    baseDeps: baseDeps.length,
    czImpl,
    czIface,
    czCaller,
    baseImpl: defReadIn,
    baseIface: defReadIn,
    baseCaller,
    filesRef: ranked.length,
    filesRead: read.length,
    nodes: nodes.length,
    uniqueNodes: seen.size,
    dupNodes,
    dupTokens,
    selfEstimate: capsule.token_estimate ?? 0,
    effTotal: effects.length,
    effectTokens,
    effDirect,
    effCycle,
    effectFingerprint,
    hasEffects: effects.length > 0,
    hasInvariant: nodes.some((n) => n.type === "invariant" || n.type === "contract"),
    hasTest: nodes.some((n) => n.type === "test"),
    compileMs,
  })

  process.stderr.write(
    "  " +
      t.name.slice(0, 28).padEnd(28) +
      " spent=" +
      String(spent).padStart(5) +
      "  imports " +
      String(czDeps.length).padStart(2) +
      "/" +
      String(deps.size).padEnd(3) +
      " (indexed " +
      String(czIndexedDeps.length) +
      "/" +
      String(indexedDeps.length) +
      ")  files " +
      String(baseDeps.length) +
      "/" +
      deps.size +
      "  " +
      compileMs +
      "ms\n",
  )
}

if (rows.length === 0) {
  console.error("No comparable targets.")
  process.exit(1)
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0)
const avg = (f) => sum(f) / rows.length
const pct = (f) => +((rows.filter(f).length / rows.length) * 100).toFixed(1)
const median = (f) => {
  const v = rows.map(f).sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}
const ratio = (a, b) => +((sum(a) / Math.max(1, sum(b))) * 100).toFixed(1)
const czFacts = (r) => (r.czImpl ? 1 : 0) + (r.czIface ? 1 : 0) + (r.czCaller ? 1 : 0) + r.czDeps
const baseFacts = (r) => (r.baseImpl ? 1 : 0) + (r.baseIface ? 1 : 0) + (r.baseCaller ? 1 : 0) + r.baseDeps

console.log(
  JSON.stringify(
    {
      repo: path.basename(REPO),
      shared_universe_files: corpus.size,
      indexed_files_missing_on_disk: missing,
      universe_tokens: [...corpus.values()].reduce((a, f) => a + f.tokens, 0),
      corpus_load_ms: corpusMs,
      tasks: rows.length,
      capsule_token_budget: BUDGET,
      min_symbol_name_length: MIN_NAME,

      cost: {
        avg_capsule_tokens: Math.round(avg((r) => r.spent)),
        naive_grep_read_tokens: sum((r) => r.naiveTokens),
        contextzero_tokens: sum((r) => r.spent),
        reduction_vs_naive: +(sum((r) => r.naiveTokens) / sum((r) => r.spent)).toFixed(1),
        oracle_file_tokens: sum((r) => r.oracleTokens),
        reduction_vs_oracle: +(sum((r) => r.oracleTokens) / sum((r) => r.spent)).toFixed(1),
        reduction_vs_oracle_median: +median((r) => r.oracleTokens / Math.max(1, r.spent)).toFixed(1),
      },

      import_coverage_at_equal_budget: {
        resolved_imports_used_total: sum((r) => r.depsTotal),
        avg_per_task: +avg((r) => r.depsTotal).toFixed(1),
        of_which_indexed_as_symbols_pct: ratio((r) => r.depsIndexed, (r) => r.depsTotal),
        internal_imports_seen: resolution.internal,
        internal_imports_unresolved_pct: +((resolution.dropped / Math.max(1, resolution.internal)) * 100).toFixed(1),
        contextzero_recall_overall_pct: ratio((r) => r.czDeps, (r) => r.depsTotal),
        contextzero_recall_of_indexed_pct: ratio((r) => r.czIndexedDeps, (r) => r.depsIndexed),
        file_reading_recall_overall_pct: ratio((r) => r.baseDeps, (r) => r.depsTotal),
        contextzero_beats_files: rows.filter((r) => r.czDeps > r.baseDeps).length,
        tied: rows.filter((r) => r.czDeps === r.baseDeps).length,
        file_reading_beats_contextzero: rows.filter((r) => r.czDeps < r.baseDeps).length,
      },

      structure_at_equal_budget: {
        has_implementation_pct: { contextzero: pct((r) => r.czImpl), file_reading: pct((r) => r.baseImpl) },
        has_interface_pct: { contextzero: pct((r) => r.czIface), file_reading: pct((r) => r.baseIface) },
        has_verified_caller_pct: { contextzero: pct((r) => r.czCaller), file_reading: pct((r) => r.baseCaller) },
      },

      facts_per_1k_tokens: {
        contextzero: +((sum(czFacts) / sum((r) => r.spent)) * 1000).toFixed(2),
        file_reading: +((sum(baseFacts) / sum((r) => r.spent)) * 1000).toFixed(2),
      },

      capsule_composition: {
        avg_nodes: +avg((r) => r.nodes).toFixed(1),
        duplicate_node_pct: ratio((r) => r.dupNodes, (r) => r.nodes),
        duplicate_token_pct: ratio((r) => r.dupTokens, (r) => r.spent),
        budget_utilization_pct: +((sum((r) => r.spent) / (rows.length * BUDGET)) * 100).toFixed(1),
        self_reported_vs_actual_tokens_pct: ratio((r) => r.selfEstimate, (r) => r.spent),
        tasks_over_budget: rows.filter((r) => r.spent > BUDGET).length,
      },

      derived_context_not_obtainable_by_reading: {
        effect_signature_pct: pct((r) => r.hasEffects),
        contract_or_invariant_pct: pct((r) => r.hasInvariant),
        linked_test_pct: pct((r) => r.hasTest),
        effect_entries_total: sum((r) => r.effTotal),
        share_of_capsule_tokens_pct: ratio((r) => r.effectTokens, (r) => r.spent),
        read_from_the_body_itself_pct: ratio((r) => r.effDirect, (r) => r.effTotal),
        propagated_around_a_call_cycle_pct: ratio((r) => r.effCycle, (r) => r.effTotal),
        distinct_effect_sets_pct: +(
          (new Set(rows.map((r) => r.effectFingerprint).filter(Boolean)).size /
            Math.max(1, rows.filter((r) => r.effectFingerprint).length)) *
          100
        ).toFixed(1),
      },

      latency: {
        avg_capsule_compile_ms: Math.round(avg((r) => r.compileMs)),
        p90_ms: rows.map((r) => r.compileMs).sort((a, b) => a - b)[Math.floor(rows.length * 0.9)],
      },

      weakest_tasks: rows
        .filter((r) => r.depsIndexed >= 3)
        .sort((a, b) => a.czIndexedDeps / a.depsIndexed - b.czIndexedDeps / b.depsIndexed)
        .slice(0, 8)
        .map((r) => ({
          name: r.name,
          imports_used: r.depsTotal,
          indexed: r.depsIndexed,
          delivered: r.czIndexedDeps,
          nodes: r.uniqueNodes,
          spent: r.spent,
        })),
    },
    null,
    2,
  ),
)

await db.close()
