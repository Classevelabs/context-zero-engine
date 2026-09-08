#!/usr/bin/env node
/**
 * Run the whole published benchmark: every repository in the corpus, both
 * measurements, into one dated directory.
 *
 *   node scripts/bench-sweep.mjs [--corpus <dir>] [--out <dir>] [--tasks 60]
 *
 * The two measurements answer different questions and are run in this order
 * because the second depends on the first:
 *
 *   e2e      ingests the repository into a FRESH database and measures what it
 *            cost — time, memory, storage, query latency, query failures.
 *   quality  reads the snapshot the e2e run just produced and measures whether
 *            the smaller context still carries the work.
 *
 * `--fresh` per repository is deliberate: storage numbers are meaningless if a
 * previous repository is still resident, and the quality run resolves its
 * snapshot by repository name, which is ambiguous in a shared database.
 *
 * A repository that fails is recorded to `<name>.<stage>.err` and the sweep
 * continues — one broken grammar must not cost the other sixteen results. The
 * exit code is non-zero if anything failed, so a green sweep is a fact and not
 * an impression.
 */
import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}

const corpusDir = path.resolve(arg("--corpus", path.join(repoRoot, "..", ".bench-corpus")))
const stamp = new Date().toISOString().slice(0, 10)
const outDir = path.resolve(arg("--out", path.join(repoRoot, "benchmarks", stamp)))
const TASKS = arg("--tasks", "60")

fs.mkdirSync(outDir, { recursive: true })

const manifest = fs
  .readFileSync(path.join(repoRoot, "benchmarks", "manifest.tsv"), "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [name, language] = l.split("\t")
    return { name, language, dir: path.join(corpusDir, name) }
  })

// The engine's own tree is measured too — it is the only repository in the set
// whose graph the authors can check by hand against what they know is there.
manifest.push({ name: "engine-ts", language: "typescript", dir: repoRoot })

const present = manifest.filter((r) => fs.existsSync(r.dir))
for (const r of manifest) {
  if (!present.includes(r)) process.stderr.write(`missing checkout, skipped: ${r.name} (${r.dir})\n`)
}

/** File count, so the log orders work smallest-first and a stall is legible. */
function countFiles(dir) {
  let total = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === "target") continue
      if (e.isDirectory()) walk(path.join(d, e.name))
      else total += 1
    }
  }
  walk(dir)
  return total
}

for (const r of present) r.files = countFiles(r.dir)
present.sort((a, b) => a.files - b.files)

const logPath = path.join(outDir, "sweep.log")
const clock = () => new Date().toTimeString().slice(0, 8)
// Appended synchronously, not through a WriteStream: the sweep ends on
// process.exit() to carry the failure count out, and that kills the process
// before an async stream flushes — which silently lost the entire log of a
// 40-minute run. A sweep whose record does not survive its own exit is not a
// record. Volume here is a few lines per repository, so the syscall is free.
const say = (line) => {
  process.stdout.write(line + "\n")
  fs.appendFileSync(logPath, line + "\n", "utf8")
}

say(`${clock()} SWEEP START — ${present.length} repos`)
say(`${clock()} corpus ${corpusDir}`)
say(`${clock()} out    ${outDir}`)

const failures = []

function run(label, name, stage, args, stdoutFile) {
  const started = Date.now()
  say(`${clock()} >>> ${label} — ${stage}`)
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
    // The quality run looks the snapshot up by REGISTERED name; the e2e run
    // registered it as `name`, which is not the directory name for every repo.
    env: { ...process.env, SCG_LOG_LEVEL_OVERRIDE: "error", CZ_BENCH_REPO_NAME: name },
  })
  const secs = Math.round((Date.now() - started) / 1000)
  if (res.status !== 0) {
    const errFile = path.join(outDir, `${name}.${stage}.err`)
    fs.writeFileSync(errFile, (res.stdout || "") + "\n--- stderr ---\n" + (res.stderr || ""), "utf8")
    say(`${clock()}     ${stage} FAIL rc=${res.status} (${secs}s) — see ${path.basename(errFile)}`)
    failures.push({ name, stage })
    return false
  }
  if (stdoutFile) fs.writeFileSync(stdoutFile, res.stdout, "utf8")
  say(`${clock()}     ${stage} OK (${secs}s)`)
  return true
}

for (const r of present) {
  const e2eOut = path.join(outDir, `${r.name}.e2e.json`)
  const okE2e = run(
    `${r.name} (${r.language}, ${r.files} files)`,
    r.name,
    "e2e",
    ["scripts/bench-e2e.mjs", r.dir, r.name, "--fresh", "--json", e2eOut],
    null,
  )
  // The quality run reads the snapshot the e2e run wrote. Without it there is
  // nothing to measure, and running it anyway would score the previous repo.
  if (!okE2e) continue
  run(r.name, r.name, "quality", ["scripts/bench-context-quality.mjs", TASKS, r.dir], path.join(outDir, `${r.name}.quality.json`))
}

say(`${clock()} SWEEP COMPLETE — ${present.length - failures.length}/${present.length} repos clean`)
if (failures.length) {
  for (const f of failures) say(`${clock()}     FAILED ${f.name} ${f.stage}`)
}
process.exit(failures.length ? 1 : 0)
