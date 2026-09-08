#!/usr/bin/env node
/**
 * Render a sweep directory into the report that gets published.
 *
 *   node scripts/bench-tables.mjs [--in benchmarks/<date>] [--corpus <dir>]
 *
 * Reads only the JSON the sweep wrote, so the prose cannot drift from the run:
 * a number in the text that no file supports is a number that will eventually
 * be quoted somewhere it cannot be defended.
 *
 * The report deliberately carries the costs alongside the savings. A token
 * reduction on its own is not a result — returning nothing reduces tokens by
 * 100% — so every table that says what was saved is followed by one that says
 * what it cost, where it lost, and what it still cannot do.
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}

const stamp = new Date().toISOString().slice(0, 10)
const inDir = path.resolve(arg("--in", path.join(repoRoot, "benchmarks", stamp)))
const corpusDir = path.resolve(arg("--corpus", path.join(repoRoot, "..", ".bench-corpus")))

const languages = {}
for (const line of fs.readFileSync(path.join(repoRoot, "benchmarks", "manifest.tsv"), "utf8").split(/\r?\n/)) {
  const [name, language] = line.split("\t")
  if (name) languages[name.trim()] = language
}
languages["engine-ts"] = "typescript"

const commits = {}
const lockPath = path.join(corpusDir, "corpus.lock.tsv")
if (fs.existsSync(lockPath)) {
  for (const line of fs.readFileSync(lockPath, "utf8").split(/\r?\n/)) {
    const [name, , sha] = line.split("\t")
    if (name && sha) commits[name.trim()] = sha.trim().slice(0, 10)
  }
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(inDir, f), "utf8"))
const rows = fs
  .readdirSync(inDir)
  .filter((f) => f.endsWith(".quality.json"))
  .map((f) => f.replace(".quality.json", ""))
  .filter((r) => fs.existsSync(path.join(inDir, `${r}.e2e.json`)))
  .sort()
  .map((r) => ({ r, q: read(`${r}.quality.json`), e: read(`${r}.e2e.json`) }))

const median = (values) => {
  const v = [...values].sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}
const sum = (values) => values.reduce((a, b) => a + b, 0)
const mb = (bytes) => (Number(bytes) / (1024 * 1024)).toFixed(1)
const num = (n) => Number(n).toLocaleString("en-US")

const totalTasks = sum(rows.map((x) => x.q.tasks))
const totalFailed = sum(rows.map((x) => x.q.failed_tasks))
const budget = rows[0]?.q.capsule_token_budget
const fileCap = rows[0]?.q.naive_baseline_file_cap

const out = []
const w = (line = "") => out.push(line)

w(`# Benchmark sweep — ${path.basename(inDir)}`)
w()
w("Every repository is a public checkout pinned by commit in `.bench-corpus/corpus.lock.tsv`. Reproduce with:")
w()
w("```bash")
w("node scripts/bench-corpus.mjs      # clone and pin the corpus")
w("node scripts/bench-sweep.mjs       # ingest and measure every repository")
w("node scripts/bench-tables.mjs      # render this file from the JSON")
w("```")
w()
w(
  `${rows.length} repositories, ${num(totalTasks)} tasks, **${totalFailed} failed**. ` +
    `The job is "change this function": the function, what it uses from other files, and what calls it. ` +
    `The capsule gets a ${num(budget)}-token budget. The baseline greps for the symbol and reads up to ` +
    `${fileCap} of the files that mention it, best-first, charged nothing for the search or for deciding what to open.`,
)
w()

// ── 1. what it saves ────────────────────────────────────────────────────────
w("## 1. What it saves")
w()
w("Median tokens for one job. `vs reading` is against the grep-and-read baseline; `vs oracle` is against a")
w("baseline given perfect foreknowledge of which files it needs — the honest floor, and the ratio worth quoting.")
w()
w("| Repository | Language | Commit | Reading | Capsule | Saved | vs reading | vs oracle |")
w("|---|---|---|---:|---:|---:|---:|---:|")
for (const { r, q } of rows) {
  w(
    `| ${r} | ${languages[r] || "-"} | \`${commits[r] || "local"}\` | ${num(q.one_typical_task.reading_files.tokens)} | ` +
      `${num(q.one_typical_task.contextzero.tokens)} | ${q.one_typical_task.tokens_saved_pct}% | ` +
      `${q.cost.reduction_vs_naive}x | ${q.cost.reduction_vs_oracle}x |`,
  )
}
w()
w(
  `**Medians:** ${median(rows.map((x) => x.q.one_typical_task.tokens_saved_pct))}% of tokens saved, ` +
    `${median(rows.map((x) => x.q.cost.reduction_vs_naive))}x fewer than reading files, ` +
    `${median(rows.map((x) => x.q.cost.reduction_vs_oracle))}x fewer than an oracle that already knows which files to open.`,
)
w()

// ── 2. where it does not save ───────────────────────────────────────────────
w("## 2. Where it does not save")
w()
w("A capsule carries callers, effects and contracts that the source file does not, so on a short symbol in a")
w("small file that overhead can cost more than simply reading. These are the cases where that happens.")
w()
w("| Repository | Tasks | Costs more than reading | Costs more than the oracle | Worst comparable case | Reading found nothing | Over budget |")
w("|---|---:|---:|---:|---:|---:|---:|")
for (const { r, q } of rows) {
  const c = q.cost
  w(
    `| ${r} | ${q.tasks} | ${c.tasks_capsule_cost_more_than_reading ?? "-"} | ${c.tasks_capsule_cost_more_than_oracle ?? "-"} | ` +
      `${c.worst_task_capsule_vs_reading ? c.worst_task_capsule_vs_reading + "x" : "-"} | ` +
      `${c.tasks_where_reading_found_nothing ?? "-"} | ${q.capsule_composition.tasks_over_budget} |`,
  )
}
const lostReading = sum(rows.map((x) => x.q.cost.tasks_capsule_cost_more_than_reading || 0))
const lostOracle = sum(rows.map((x) => x.q.cost.tasks_capsule_cost_more_than_oracle || 0))
w()
w(
  `Across all ${num(totalTasks)} tasks the capsule cost more than reading **${lostReading} times** ` +
    `(${((lostReading / totalTasks) * 100).toFixed(1)}%), and more than the oracle **${lostOracle} times** ` +
    `(${((lostOracle / totalTasks) * 100).toFixed(1)}%).`,
)
w()

// ── 3. does it still carry the work ─────────────────────────────────────────
w("## 3. Does the smaller context still carry the work")
w()
w("Both sides get the same number of tokens to spend. Ground truth is read off disk, not taken from the graph.")
w("`Deps scored` is the size of the population the recall column rests on; a small count is a thin measurement.")
w()
w("| Repository | Deps scored | Recall | Has implementation | Has caller | Linked test | Facts per 1k tokens |")
w("|---|---:|---:|---:|---:|---:|---:|")
for (const { r, q } of rows) {
  const ic = q.import_coverage_at_equal_budget
  const st = q.structure_at_equal_budget
  w(
    `| ${r} | ${ic.resolved_imports_used_total} | ${ic.contextzero_recall_of_indexed_pct}% | ` +
      `${st.has_implementation_pct.contextzero}% vs ${st.has_implementation_pct.file_reading}% | ` +
      `${st.has_verified_caller_pct.contextzero}% vs ${st.has_verified_caller_pct.file_reading}% | ` +
      `${q.derived_context_not_obtainable_by_reading.linked_test_pct}% | ` +
      `${q.facts_per_1k_tokens.contextzero} vs ${q.facts_per_1k_tokens.file_reading} |`,
  )
}
w()

// ── 4. what it costs to run ─────────────────────────────────────────────────
w("## 4. What it costs to run")
w()
w("Indexing is paid once, then incrementally. The database is the price of not re-reading files.")
w()
w("| Repository | Files | Symbols | Relations | Cold index | Re-index | One-file edit | Peak RSS | Database | Source |")
w("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for (const { r, q, e } of rows) {
  const peak = e.ingest.coldPeakRss
  w(
    `| ${r} | ${num(e.source.files)} | ${num(e.storage.counts.symbols)} | ${num(e.storage.counts.relations)} | ` +
      `${(e.ingest.coldMs / 1000).toFixed(1)} s | ${(e.ingest.warmMs / 1000).toFixed(1)} s | ` +
      `${(e.ingest.incrementalMs / 1000).toFixed(1)} s | ${peak ? mb(peak) + " MB" : "-"} | ` +
      `${mb(e.storage.totals.db)} MB | ${mb(e.source.bytes)} MB |`,
  )
}
w()
w(
  `Totals: ${num(sum(rows.map((x) => x.e.source.files)))} files indexed, ` +
    `${(sum(rows.map((x) => x.e.ingest.coldMs)) / 1000 / 60).toFixed(1)} minutes of cold indexing, ` +
    `${(sum(rows.map((x) => Number(x.e.storage.totals.db))) / 1024 ** 3).toFixed(1)} GB of database for ` +
    `${(sum(rows.map((x) => x.e.source.bytes)) / 1024 ** 2).toFixed(0)} MB of source.`,
)
w()

// ── 5. latency and integrity ────────────────────────────────────────────────
w("## 5. Answer latency and integrity")
w()
w("Every read path, many iterations over rotating inputs. A handler that errors immediately benchmarks well,")
w("so the failure count is reported beside the timing.")
w()
const allQueryNames = [...new Set(rows.flatMap((x) => x.e.queries.map((q) => q.name)))]
w("| Query | p50 | p95 | p99 | Calls | Failed | Empty answers |")
w("|---|---:|---:|---:|---:|---:|---:|")
for (const name of allQueryNames) {
  const entries = rows.map((x) => x.e.queries.find((q) => q.name === name)).filter(Boolean)
  if (!entries.length) continue
  const emptyish = entries.filter((q) => q.avgBytes < 200).length
  w(
    `| \`${name}\` | ${median(entries.map((q) => q.p50)).toFixed(1)} ms | ${median(entries.map((q) => q.p95)).toFixed(1)} ms | ` +
      `${median(entries.map((q) => q.p99)).toFixed(1)} ms | ${num(sum(entries.map((q) => q.ok)))} | ` +
      `${sum(entries.map((q) => q.failed))} | ${emptyish} of ${entries.length} repos |`,
  )
}
w()
w(
  `Capsule compile time, median across repositories: ${median(rows.map((x) => x.q.latency.avg_capsule_compile_ms))} ms average, ` +
    `${median(rows.map((x) => x.q.latency.p90_ms))} ms at p90.`,
)
w()

// ── 6. what is still thin ───────────────────────────────────────────────────
w("## 6. What is still thin")
w()
const noRelations = rows.filter((x) => Number(x.e.storage.counts.relations) === 0)
const noDeps = rows.filter((x) => x.q.import_coverage_at_equal_budget.resolved_imports_used_total === 0)
const noTests = rows.filter((x) => x.q.derived_context_not_obtainable_by_reading.linked_test_pct === 0)
if (noRelations.length) {
  w(`- **No relations at all:** ${noRelations.map((x) => x.r).join(", ")}.`)
} else {
  w("- **Every repository in the corpus produces a call graph.**")
}
w(
  `- **Dependency recall is scored on ${rows.length - noDeps.length} of ${rows.length} repositories.** ` +
    `The rest resolve no internal imports the harness can score, so their recall cell is an empty measurement, ` +
    `not a failure: ${noDeps.map((x) => x.r).join(", ") || "none"}.`,
)
w(
  `- **${noTests.length} of ${rows.length} repositories link no test to any symbol** — ` +
    `${noTests.map((x) => x.r).join(", ") || "none"}.`,
)
w(
  "- **Inline Rust `#[cfg(test)]` modules are invisible to a path-based test rule**, so a crate that keeps its " +
    "tests beside the code links fewer of them than one using `tests/`.",
)
w()

const outPath = path.join(inDir, "BENCH-TABLES.md")
fs.writeFileSync(outPath, out.join("\n"), "utf8")
process.stdout.write(`${outPath}\n${rows.length} repositories, ${num(totalTasks)} tasks, ${totalFailed} failed\n`)
