#!/usr/bin/env node
/**
 * Fetch the benchmark corpus named in benchmarks/manifest.tsv.
 *
 *   node scripts/bench-corpus.mjs [--dir <path>]
 *
 * The manifest lists a repository per line as `name<TAB>language<TAB>url`. Each
 * is cloned shallow — the benchmark reads a working tree, never history, so a
 * full clone would cost gigabytes to measure nothing.
 *
 * The resolved commit of every checkout is written to `corpus.lock.tsv` beside
 * the clones. Without it a published table cannot be reproduced: "the same
 * checkouts" is not a property a branch name has, and upstream moves.
 */
import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const argv = process.argv.slice(2)
const dirIdx = argv.indexOf("--dir")
const corpusDir = path.resolve(dirIdx >= 0 ? argv[dirIdx + 1] : path.join(repoRoot, "..", ".bench-corpus"))

const manifestPath = path.join(repoRoot, "benchmarks", "manifest.tsv")
const entries = fs
  .readFileSync(manifestPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [name, language, url] = line.split("\t")
    return { name, language, url }
  })

fs.mkdirSync(corpusDir, { recursive: true })

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, shell: false })
}

const lock = []
let failures = 0

for (const entry of entries) {
  const dest = path.join(corpusDir, entry.name)
  if (fs.existsSync(path.join(dest, ".git"))) {
    process.stdout.write(`= ${entry.name} (present)\n`)
  } else {
    process.stdout.write(`> ${entry.name} <- ${entry.url}\n`)
    fs.rmSync(dest, { recursive: true, force: true })
    const res = git(["clone", "--depth", "1", "--quiet", entry.url, dest])
    if (res.status !== 0) {
      process.stderr.write(`  FAIL ${entry.name}: ${(res.stderr || "").trim()}\n`)
      failures += 1
      continue
    }
  }
  const head = git(["rev-parse", "HEAD"], dest)
  const sha = head.status === 0 ? head.stdout.trim() : "unknown"
  lock.push([entry.name, entry.language, sha, entry.url].join("\t"))
}

fs.writeFileSync(path.join(corpusDir, "corpus.lock.tsv"), lock.join("\n") + "\n", "utf8")
process.stdout.write(`\n${lock.length} repositories in ${corpusDir}\n`)
process.stdout.write(`commits pinned in ${path.join(corpusDir, "corpus.lock.tsv")}\n`)
process.exit(failures > 0 ? 1 : 0)
