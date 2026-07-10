import { spawn, spawnSync } from "child_process"
import * as crypto from "crypto"
import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import { performance } from "perf_hooks"
import { db } from "../src/db-driver"
import { ingestor } from "../src/ingestor"
import { capsuleCompiler } from "../src/analysis-engine/capsule-compiler"
import { blastRadiusEngine } from "../src/analysis-engine/blast-radius"
import type { SupportedLanguage } from "../src/adapters/universal"

const contextZeroRoot = path.resolve(__dirname, "..")
const benchmarksRoot = path.resolve(process.argv[2] || "D:/Lab/new/benchmarks")
const outputPath = path.resolve(
  process.argv[3] || path.join(contextZeroRoot, "MULTILANGUAGE_CONTEXTZERO_BENCHMARK_REPORT.md"),
)
const cacheDir = path.join(contextZeroRoot, ".benchmark-results")
const targetLimit = Math.max(1, Math.min(5, Number(process.env.BENCH_TARGETS || 3)))
const tokenDivisor = 4
const pythonCommand = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")

process.env.PATH = `${path.join(contextZeroRoot, ".bench-bin")}${path.delimiter}${process.env.PATH || ""}`

const sourceExts = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".pyw",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".cpp",
  ".cc",
  ".cxx",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".kt",
  ".kts",
  ".swift",
  ".php",
  ".sh",
  ".bash",
  ".json",
  ".md",
  ".yml",
  ".yaml",
])

const skipDirs = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".yarn",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  "egg-info",
  "target",
  "vendor",
  ".gradle",
  ".mvn",
  "bin",
  "obj",
  "packages",
  "Pods",
  ".build",
  ".idea",
  ".vscode",
  "coverage",
  ".cache",
  "tmp",
  "temp",
])

interface BenchTarget {
  id: string
  name: string
  pathName: string
  primaryLanguages: string[]
  note: string
}

const allTargets: BenchTarget[] = [
  { id: "django", name: "Django", pathName: "django", primaryLanguages: ["python"], note: "Python web framework" },
  {
    id: "prometheus",
    name: "Prometheus",
    pathName: "prometheus",
    primaryLanguages: ["go"],
    note: "Go monitoring system",
  },
  { id: "tokio", name: "Tokio", pathName: "tokio", primaryLanguages: ["rust"], note: "Rust async runtime" },
  {
    id: "spring-framework",
    name: "Spring Framework",
    pathName: "spring-framework",
    primaryLanguages: ["java"],
    note: "Java application framework",
  },
  {
    id: "commons-lang",
    name: "Apache Commons Lang",
    pathName: "commons-lang",
    primaryLanguages: ["java"],
    note: "Java utility library",
  },
  {
    id: "dotnet-runtime",
    name: ".NET Runtime",
    pathName: "dotnet-runtime",
    primaryLanguages: ["csharp"],
    note: "C#/.NET runtime repository",
  },
  {
    id: "serilog",
    name: "Serilog",
    pathName: "serilog",
    primaryLanguages: ["csharp"],
    note: "C# structured logging library",
  },
  { id: "rails", name: "Rails", pathName: "rails", primaryLanguages: ["ruby"], note: "Ruby web framework" },
  {
    id: "okhttp",
    name: "OkHttp",
    pathName: "okhttp",
    primaryLanguages: ["kotlin", "java"],
    note: "Kotlin/Java HTTP client",
  },
  {
    id: "alamofire",
    name: "Alamofire",
    pathName: "alamofire",
    primaryLanguages: ["swift"],
    note: "Swift networking library",
  },
  { id: "bitcoin", name: "Bitcoin Core", pathName: "bitcoin", primaryLanguages: ["cpp"], note: "C++ Bitcoin node" },
  {
    id: "laravel-framework",
    name: "Laravel Framework",
    pathName: "laravel-framework",
    primaryLanguages: ["php"],
    note: "PHP web framework",
  },
  { id: "nvm", name: "nvm", pathName: "nvm", primaryLanguages: ["bash"], note: "Bash version manager" },
]

interface CorpusStats {
  files: number
  source_files: number
  bytes: number
  source_bytes: number
  lines: number
  source_estimated_tokens: number
  by_extension: Record<string, { files: number; bytes: number; lines: number }>
}

interface TokenTask {
  symbol: string
  file_path: string
  full_source_estimated_tokens: number
  exact_files: number
  exact_estimated_tokens: number
  contextzero_estimated_tokens: number
  exact_elapsed_ms: number
  contextzero_elapsed_ms: number
  full_source_reduction_ratio: number
  exact_reduction_ratio: number
  exact_savings_percent: number
}

interface TargetResult {
  target: BenchTarget
  path: string
  remote: string
  commit: string
  corpus: CorpusStats
  ingest: {
    repo_id: string
    snapshot_id: string
    commit_sha: string
    elapsed_ms: number
    result: Record<string, unknown>
  }
  dbCounts: Record<string, number>
  languageCounts: Array<Record<string, string | number>>
  tokenRows: TokenTask[]
  queryMetrics: Array<{ name: string; elapsed_ms: number; bytes: number; estimated_tokens: number }>
}

interface SmokeRow {
  language: string
  adapter: string
  status: string
  symbols: number
  relations: number
  note: string
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start)
}

function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / tokenDivisor)
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  const header = `| ${headers.join(" | ")} |`
  const divider = `| ${headers.map(() => "---").join(" | ")} |`
  const body = rows.map(
    (row) => `| ${row.map((cell) => String(cell).replace(/\n/g, "<br>").replace(/\|/g, "\\|")).join(" | ")} |`,
  )
  return [header, divider, ...body].join("\n")
}

function resultCachePath(target: BenchTarget): string {
  return path.join(cacheDir, `${target.id}.json`)
}

async function loadCachedResult(target: BenchTarget): Promise<TargetResult | null> {
  if (process.env.BENCH_FORCE === "1") return null
  try {
    const raw = await fsp.readFile(resultCachePath(target), "utf8")
    return JSON.parse(raw) as TargetResult
  } catch {
    return null
  }
}

async function saveCachedResult(target: BenchTarget, result: TargetResult): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(resultCachePath(target), `${JSON.stringify(result, null, 2)}\n`, "utf8")
}

async function walkFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) await walkFiles(root, full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

async function collectCorpusStats(root: string): Promise<CorpusStats> {
  const files = await walkFiles(root)
  const byExtension: CorpusStats["by_extension"] = {}
  let bytes = 0
  let sourceBytes = 0
  let sourceFiles = 0
  let lines = 0

  for (const file of files) {
    const stat = await fsp.stat(file)
    bytes += stat.size
    const ext = path.extname(file).toLowerCase() || "[none]"
    if (!sourceExts.has(ext)) continue
    sourceFiles++
    sourceBytes += stat.size
    const text = await fsp.readFile(file, "utf8").catch(() => "")
    const fileLines = text ? text.split(/\r\n|\r|\n/).length : 0
    lines += fileLines
    const slot = byExtension[ext] || { files: 0, bytes: 0, lines: 0 }
    slot.files++
    slot.bytes += stat.size
    slot.lines += fileLines
    byExtension[ext] = slot
  }

  return {
    files: files.length,
    source_files: sourceFiles,
    bytes,
    source_bytes: sourceBytes,
    lines,
    source_estimated_tokens: estimatedTokens(sourceBytes),
    by_extension: Object.fromEntries(Object.entries(byExtension).sort((a, b) => b[1].bytes - a[1].bytes)),
  }
}

function gitValue(repoPath: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", timeout: 30_000 })
  return result.status === 0 ? result.stdout.trim() : "[unavailable]"
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const result = await db.query(sql, params)
  const row = result.rows[0] as { count?: number | string } | undefined
  return Number(row?.count ?? 0)
}

async function collectDbCounts(snapshotId: string): Promise<Record<string, number>> {
  return {
    files: await countRows("SELECT COUNT(*)::int AS count FROM files WHERE snapshot_id = $1", [snapshotId]),
    symbol_versions: await countRows("SELECT COUNT(*)::int AS count FROM symbol_versions WHERE snapshot_id = $1", [
      snapshotId,
    ]),
    structural_relations: await countRows(
      `SELECT COUNT(DISTINCT sr.relation_id)::int AS count
             FROM structural_relations sr
             JOIN symbol_versions src ON src.symbol_version_id = sr.src_symbol_version_id
             JOIN symbol_versions dst ON dst.symbol_version_id = sr.dst_symbol_version_id
             WHERE src.snapshot_id = $1 OR dst.snapshot_id = $1`,
      [snapshotId],
    ),
    behavioral_profiles: await countRows(
      `SELECT COUNT(*)::int AS count
             FROM behavioral_profiles bp
             JOIN symbol_versions sv ON sv.symbol_version_id = bp.symbol_version_id
             WHERE sv.snapshot_id = $1`,
      [snapshotId],
    ),
    contract_profiles: await countRows(
      `SELECT COUNT(*)::int AS count
             FROM contract_profiles cp
             JOIN symbol_versions sv ON sv.symbol_version_id = cp.symbol_version_id
             WHERE sv.snapshot_id = $1`,
      [snapshotId],
    ),
    effect_signatures: await countRows(
      `SELECT COUNT(*)::int AS count
             FROM effect_signatures es
             JOIN symbol_versions sv ON sv.symbol_version_id = es.symbol_version_id
             WHERE sv.snapshot_id = $1`,
      [snapshotId],
    ),
    invariants: await countRows("SELECT COUNT(*)::int AS count FROM invariants WHERE last_verified_snapshot_id = $1", [
      snapshotId,
    ]),
  }
}

async function collectLanguageCounts(snapshotId: string): Promise<Array<Record<string, string | number>>> {
  const result = await db.query(
    `SELECT sv.language,
                COUNT(*)::int AS symbols,
                COUNT(bp.*)::int AS behavioral_profiles,
                COUNT(cp.*)::int AS contract_profiles,
                COUNT(es.*)::int AS effect_signatures
         FROM symbol_versions sv
         LEFT JOIN behavioral_profiles bp ON bp.symbol_version_id = sv.symbol_version_id
         LEFT JOIN contract_profiles cp ON cp.symbol_version_id = sv.symbol_version_id
         LEFT JOIN effect_signatures es ON es.symbol_version_id = sv.symbol_version_id
         WHERE sv.snapshot_id = $1
         GROUP BY sv.language
         ORDER BY symbols DESC`,
    [snapshotId],
  )
  return result.rows as Array<Record<string, string | number>>
}

async function selectTargets(
  snapshotId: string,
  languages: string[],
): Promise<
  Array<{
    symbol_version_id: string
    canonical_name: string
    file_path: string
  }>
> {
  const result = await db.query(
    `SELECT sv.symbol_version_id, s.canonical_name, f.path AS file_path,
                LENGTH(COALESCE(sv.body_source, '')) AS body_len
         FROM symbol_versions sv
         JOIN symbols s ON s.symbol_id = sv.symbol_id
         JOIN files f ON f.file_id = sv.file_id
         WHERE sv.snapshot_id = $1
           AND sv.language = ANY($2)
           AND s.kind IN ('function', 'method', 'class', 'interface', 'type_alias')
           AND LENGTH(COALESCE(sv.body_source, '')) >= 120
           AND f.path NOT LIKE '%test%'
           AND f.path NOT LIKE '%spec%'
         ORDER BY body_len DESC, s.canonical_name ASC
         LIMIT $3`,
    [snapshotId, languages, targetLimit],
  )
  return result.rows as Array<{ symbol_version_id: string; canonical_name: string; file_path: string }>
}

function symbolPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol) ? new RegExp(`\\b${escaped}\\b`) : new RegExp(escaped)
}

async function exactSymbolFootprint(
  root: string,
  symbol: string,
): Promise<{ files: number; bytes: number; elapsed_ms: number }> {
  const start = performance.now()
  const pattern = symbolPattern(symbol)
  const files = await walkFiles(root)
  let matches = 0
  let bytes = 0
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (!sourceExts.has(ext)) continue
    const text = await fsp.readFile(file, "utf8").catch(() => "")
    if (!pattern.test(text)) continue
    matches++
    bytes += (await fsp.stat(file)).size
  }
  return { files: matches, bytes, elapsed_ms: elapsedMs(start) }
}

async function runTimed(
  name: string,
  fn: () => Promise<unknown>,
): Promise<{ name: string; elapsed_ms: number; bytes: number; estimated_tokens: number }> {
  const start = performance.now()
  const data = await fn()
  const json = JSON.stringify(data)
  const bytes = Buffer.byteLength(json, "utf8")
  return { name, elapsed_ms: elapsedMs(start), bytes, estimated_tokens: estimatedTokens(bytes) }
}

async function tokenBenchmarks(
  root: string,
  snapshotId: string,
  languages: string[],
  corpus: CorpusStats,
): Promise<{
  rows: TokenTask[]
  queryMetrics: TargetResult["queryMetrics"]
}> {
  const targets = await selectTargets(snapshotId, languages)
  const rows: TokenTask[] = []
  const queryMetrics: TargetResult["queryMetrics"] = []
  const firstTarget = targets[0]
  if (firstTarget) {
    queryMetrics.push(
      await runTimed("capsule_strict_first_target", () =>
        capsuleCompiler.compile(firstTarget.symbol_version_id, snapshotId, "strict"),
      ),
    )
    queryMetrics.push(
      await runTimed("blast_radius_depth_1_first_target", () =>
        blastRadiusEngine.computeBlastRadius(snapshotId, [firstTarget.symbol_version_id], 1),
      ),
    )
  }

  for (const target of targets) {
    const exact = await exactSymbolFootprint(root, target.canonical_name)
    const start = performance.now()
    const capsule = await capsuleCompiler.compile(target.symbol_version_id, snapshotId, "strict")
    const capsuleBytes = Buffer.byteLength(JSON.stringify(capsule), "utf8")
    const contextTokens = estimatedTokens(capsuleBytes)
    const exactTokens = estimatedTokens(exact.bytes)
    rows.push({
      symbol: target.canonical_name,
      file_path: target.file_path,
      full_source_estimated_tokens: corpus.source_estimated_tokens,
      exact_files: exact.files,
      exact_estimated_tokens: exactTokens,
      contextzero_estimated_tokens: contextTokens,
      exact_elapsed_ms: exact.elapsed_ms,
      contextzero_elapsed_ms: elapsedMs(start),
      full_source_reduction_ratio: round(corpus.source_estimated_tokens / Math.max(1, contextTokens), 2),
      exact_reduction_ratio: round(exactTokens / Math.max(1, contextTokens), 2),
      exact_savings_percent: round((1 - contextTokens / Math.max(1, exactTokens)) * 100, 2),
    })
  }

  return { rows, queryMetrics }
}

async function ingestTarget(target: BenchTarget): Promise<TargetResult> {
  const repoPath = path.join(benchmarksRoot, target.pathName)
  const remote = gitValue(repoPath, ["config", "--get", "remote.origin.url"])
  const actualCommit = gitValue(repoPath, ["rev-parse", "HEAD"])
  const syntheticCommit = `bench-${target.id}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  const corpus = await collectCorpusStats(repoPath)
  const start = performance.now()
  const result = await ingestor.ingestRepo(repoPath, `${target.id}-multi-bench`, syntheticCommit, "benchmark")
  const elapsed = elapsedMs(start)
  const snap = await db.query(
    `SELECT s.snapshot_id, r.repo_id
         FROM snapshots s
         JOIN repositories r ON r.repo_id = s.repo_id
         WHERE s.commit_sha = $1
         ORDER BY s.indexed_at DESC
         LIMIT 1`,
    [syntheticCommit],
  )
  const row = snap.rows[0] as { snapshot_id: string; repo_id: string } | undefined
  if (!row) throw new Error(`No snapshot found after ingesting ${target.id}`)
  const dbCounts = await collectDbCounts(row.snapshot_id)
  const languageCounts = await collectLanguageCounts(row.snapshot_id)
  const token = await tokenBenchmarks(repoPath, row.snapshot_id, target.primaryLanguages, corpus)

  return {
    target,
    path: repoPath,
    remote,
    commit: actualCommit,
    corpus,
    ingest: {
      repo_id: row.repo_id,
      snapshot_id: row.snapshot_id,
      commit_sha: syntheticCommit,
      elapsed_ms: elapsed,
      result: result as unknown as Record<string, unknown>,
    },
    dbCounts,
    languageCounts,
    tokenRows: token.rows,
    queryMetrics: token.queryMetrics,
  }
}

async function adapterSmoke(): Promise<SmokeRow[]> {
  const rows: SmokeRow[] = []
  const tempDir = path.join(os.tmpdir(), `contextzero-smoke-${Date.now()}`)
  await fsp.mkdir(tempDir, { recursive: true })

  const tsPath = path.join(tempDir, "sample.ts")
  await fsp.writeFile(tsPath, "export function add(a: number, b: number): number { return a + b; }\n", "utf8")
  try {
    const { extractFromTypeScript } = await import("../src/adapters/ts")
    const r = extractFromTypeScript([tsPath])
    rows.push({
      language: "typescript/javascript",
      adapter: "TypeScript Compiler API",
      status: r.symbols.length > 0 ? "pass" : "fail",
      symbols: r.symbols.length,
      relations: r.relations.length,
      note: "",
    })
  } catch (error) {
    rows.push({
      language: "typescript/javascript",
      adapter: "TypeScript Compiler API",
      status: "fail",
      symbols: 0,
      relations: 0,
      note: error instanceof Error ? error.message : String(error),
    })
  }

  const pyPath = path.join(tempDir, "sample.py")
  await fsp.writeFile(pyPath, "def add(a: int, b: int) -> int:\n    return a + b\n", "utf8")
  const py = spawnSync(pythonCommand, [path.join(contextZeroRoot, "src", "adapters", "py", "extractor.py"), pyPath], {
    cwd: contextZeroRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  try {
    const parsed = JSON.parse(py.stdout || "{}") as { symbols?: unknown[]; relations?: unknown[] }
    rows.push({
      language: "python",
      adapter: "LibCST subprocess",
      status: py.status === 0 && (parsed.symbols?.length || 0) > 0 ? "pass" : "fail",
      symbols: parsed.symbols?.length || 0,
      relations: parsed.relations?.length || 0,
      note: py.stderr.trim(),
    })
  } catch {
    rows.push({
      language: "python",
      adapter: "LibCST subprocess",
      status: "fail",
      symbols: 0,
      relations: 0,
      note: py.stderr.trim() || py.stdout.trim(),
    })
  }

  const { extractWithTreeSitter } = await import("../src/adapters/universal")
  const samples: Array<{ language: SupportedLanguage; file: string; source: string }> = [
    {
      language: "typescript",
      file: "sample.ts",
      source: "export function add(a: number, b: number): number { return a + b; }",
    },
    { language: "javascript", file: "sample.js", source: "export function add(a, b) { return a + b; }" },
    { language: "python", file: "sample.py", source: "def add(a, b):\n    return a + b\n" },
    { language: "cpp", file: "sample.cpp", source: "int add(int a, int b) { return a + b; }" },
    { language: "go", file: "sample.go", source: "package main\nfunc add(a int, b int) int { return a + b }" },
    { language: "rust", file: "sample.rs", source: "pub fn add(a: i32, b: i32) -> i32 { a + b }" },
    { language: "java", file: "Sample.java", source: "class Sample { int add(int a, int b) { return a + b; } }" },
    { language: "csharp", file: "Sample.cs", source: "class Sample { int Add(int a, int b) { return a + b; } }" },
    { language: "ruby", file: "sample.rb", source: "def add(a, b)\n  a + b\nend" },
    { language: "kotlin", file: "Sample.kt", source: "fun add(a: Int, b: Int): Int { return a + b }" },
    { language: "swift", file: "Sample.swift", source: "func add(_ a: Int, _ b: Int) -> Int { return a + b }" },
    { language: "php", file: "sample.php", source: "<?php function add($a, $b) { return $a + $b; }" },
    { language: "bash", file: "sample.sh", source: "add() { echo $(($1 + $2)); }" },
  ]
  for (const { language, file, source } of samples) {
    try {
      const r = extractWithTreeSitter(file, source, language)
      const status = r.symbols.length > 0 ? "pass" : "fail"
      const note = status === "pass" ? "" : "adapter returned zero symbols"
      rows.push({
        language,
        adapter: "tree-sitter universal",
        status,
        symbols: r.symbols.length,
        relations: r.relations.length,
        note,
      })
    } catch (error) {
      rows.push({
        language,
        adapter: "tree-sitter universal",
        status: "fail",
        symbols: 0,
        relations: 0,
        note: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return rows
}

async function mcpSmoke(): Promise<{ ok: boolean; elapsed_ms: number; tools: number; stderr_tail: string }> {
  const start = performance.now()
  return await new Promise((resolve) => {
    const child = spawn("node", [path.join(contextZeroRoot, "dist", "mcp-bridge", "index.js")], {
      cwd: contextZeroRoot,
      env: {
        ...process.env,
        LOG_LEVEL: "error",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (ok: boolean, tools = 0) => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      resolve({
        ok,
        elapsed_ms: elapsedMs(start),
        tools,
        stderr_tail: stderr.trim().split(/\r?\n/).slice(-5).join("\n"),
      })
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 2 && Array.isArray(msg.result?.tools)) finish(true, msg.result.tools.length)
        } catch {
          // Ignore partial JSON lines.
        }
      }
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", () => finish(false))
    child.on("exit", () => {
      if (!settled) finish(false)
    })
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "multi-language-benchmark", version: "1.0.0" } } })}\n`,
    )
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)
    setTimeout(() => finish(false), 15_000)
  })
}

function summarizeTokenRows(
  rows: TokenTask[],
  corpusTokens: number,
): {
  tasks: number
  exact_tokens: number
  context_tokens: number
  full_ratio: number
  exact_ratio: number
  exact_savings: number
} {
  const exactTokens = rows.reduce((sum, row) => sum + row.exact_estimated_tokens, 0)
  const contextTokens = rows.reduce((sum, row) => sum + row.contextzero_estimated_tokens, 0)
  return {
    tasks: rows.length,
    exact_tokens: exactTokens,
    context_tokens: contextTokens,
    full_ratio: round((corpusTokens * rows.length) / Math.max(1, contextTokens), 2),
    exact_ratio: round(exactTokens / Math.max(1, contextTokens), 2),
    exact_savings: round((1 - contextTokens / Math.max(1, exactTokens)) * 100, 2),
  }
}

async function writeReport(
  smokeRows: SmokeRow[],
  results: TargetResult[],
  mcp: Awaited<ReturnType<typeof mcpSmoke>>,
): Promise<void> {
  const host = `${os.hostname()} / ${os.platform()} ${os.release()} / ${os.cpus()[0]?.model || "unknown CPU"}`
  const lines: string[] = []
  lines.push("# ContextZero Multi-Language Benchmark Report")
  lines.push("")
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Benchmark root: \`${benchmarksRoot}\``)
  lines.push(`ContextZero root: \`${contextZeroRoot}\``)
  lines.push(`Host: \`${host}\``)
  lines.push(`Database: \`${process.env.DB_NAME || "scg_multi_bench"}\``)
  lines.push(`Token estimate policy: \`ceil(bytes / ${tokenDivisor})\`.`)
  lines.push("")
  lines.push("## Benchmarks Included")
  lines.push("")
  lines.push("1. Adapter smoke tests for every advertised language path.")
  lines.push("2. Real repository corpus size by files, bytes, lines, and estimated source tokens.")
  lines.push("3. End-to-end ContextZero ingestion/indexing on cloned public repositories.")
  lines.push("4. Database graph counts per repository and per indexed language.")
  lines.push("5. Context capsule latency and output size for real symbols.")
  lines.push("6. Token savings against whole-source reads and exact-symbol grep-and-read baselines.")
  lines.push("7. MCP stdio bridge startup and tool-list smoke test.")
  lines.push("")
  lines.push("## Adapter Support Smoke Test")
  lines.push("")
  lines.push(
    markdownTable(
      ["Language", "Adapter", "Status", "Symbols", "Relations", "Note"],
      smokeRows.map((row) => [row.language, row.adapter, row.status, row.symbols, row.relations, row.note]),
    ),
  )
  lines.push("")
  lines.push("## Executive Summary")
  lines.push("")
  lines.push(
    markdownTable(
      [
        "Repo",
        "Primary Language",
        "Source Tokens",
        "Ingest Time",
        "Files Indexed",
        "Files Failed",
        "Symbol Versions",
        "Relations",
        "Token Tasks",
        "Full-Source Reduction",
        "Exact-Symbol Reduction",
        "Exact Savings",
      ],
      results.map((result) => {
        const tokenSummary = summarizeTokenRows(result.tokenRows, result.corpus.source_estimated_tokens)
        return [
          result.target.name,
          result.target.primaryLanguages.join(", "),
          formatNumber(result.corpus.source_estimated_tokens),
          `${formatNumber(result.ingest.elapsed_ms)} ms`,
          formatNumber(result.dbCounts.files || 0),
          formatNumber(Number(result.ingest.result.files_failed || 0)),
          formatNumber(result.dbCounts.symbol_versions || 0),
          formatNumber(result.dbCounts.structural_relations || 0),
          tokenSummary.tasks,
          tokenSummary.tasks ? `${tokenSummary.full_ratio}x` : "[no target]",
          tokenSummary.tasks ? `${tokenSummary.exact_ratio}x` : "[no target]",
          tokenSummary.tasks ? `${tokenSummary.exact_savings}%` : "[no target]",
        ]
      }),
    ),
  )
  lines.push("")
  lines.push("## MCP Readiness")
  lines.push("")
  lines.push(
    markdownTable(
      ["Check", "Result"],
      [
        ["Stdio bridge starts", mcp.ok ? "yes" : "no"],
        ["Tools listed", formatNumber(mcp.tools)],
        ["Handshake and tools/list time", `${formatNumber(mcp.elapsed_ms)} ms`],
        ["Stderr tail", mcp.stderr_tail],
      ],
    ),
  )
  lines.push("")

  for (const result of results) {
    const tokenSummary = summarizeTokenRows(result.tokenRows, result.corpus.source_estimated_tokens)
    lines.push(`## ${result.target.name}`)
    lines.push("")
    lines.push(`Remote: \`${result.remote}\``)
    lines.push(`Commit: \`${result.commit}\``)
    lines.push(`Path: \`${result.path}\``)
    lines.push(`Note: ${result.target.note}`)
    lines.push("")
    lines.push(
      markdownTable(
        ["Metric", "Value"],
        [
          ["Corpus files", formatNumber(result.corpus.files)],
          ["Source/document files", formatNumber(result.corpus.source_files)],
          ["Lines", formatNumber(result.corpus.lines)],
          ["Source bytes", formatNumber(result.corpus.source_bytes)],
          ["Source estimated tokens", formatNumber(result.corpus.source_estimated_tokens)],
          ["Ingest wall time", `${formatNumber(result.ingest.elapsed_ms)} ms`],
          ["Files processed", formatNumber(Number(result.ingest.result.files_processed || 0))],
          ["Files failed", formatNumber(Number(result.ingest.result.files_failed || 0))],
          ["DB files indexed", formatNumber(result.dbCounts.files || 0)],
          ["DB symbol versions", formatNumber(result.dbCounts.symbol_versions || 0)],
          ["DB structural relations", formatNumber(result.dbCounts.structural_relations || 0)],
          ["DB behavioral profiles", formatNumber(result.dbCounts.behavioral_profiles || 0)],
          ["DB contract profiles", formatNumber(result.dbCounts.contract_profiles || 0)],
          ["DB effect signatures", formatNumber(result.dbCounts.effect_signatures || 0)],
          ["DB invariants", formatNumber(result.dbCounts.invariants || 0)],
          ["Full-source reduction", tokenSummary.tasks ? `${tokenSummary.full_ratio}x` : "[no target]"],
          ["Exact-symbol reduction", tokenSummary.tasks ? `${tokenSummary.exact_ratio}x` : "[no target]"],
          ["Exact-symbol savings", tokenSummary.tasks ? `${tokenSummary.exact_savings}%` : "[no target]"],
        ],
      ),
    )
    lines.push("")
    lines.push("### Corpus By Extension")
    lines.push("")
    lines.push(
      markdownTable(
        ["Extension", "Files", "Lines", "Bytes"],
        Object.entries(result.corpus.by_extension)
          .slice(0, 12)
          .map(([ext, stats]) => [
            ext,
            formatNumber(stats.files),
            formatNumber(stats.lines),
            formatNumber(stats.bytes),
          ]),
      ),
    )
    lines.push("")
    lines.push("### Indexed Languages")
    lines.push("")
    lines.push(
      markdownTable(
        ["Language", "Symbols", "Behavior Profiles", "Contract Profiles", "Effect Signatures"],
        result.languageCounts.map((row) => [
          String(row.language),
          formatNumber(Number(row.symbols || 0)),
          formatNumber(Number(row.behavioral_profiles || 0)),
          formatNumber(Number(row.contract_profiles || 0)),
          formatNumber(Number(row.effect_signatures || 0)),
        ]),
      ),
    )
    lines.push("")
    lines.push("### Query Metrics")
    lines.push("")
    lines.push(
      markdownTable(
        ["Query", "Time", "Bytes", "Estimated Tokens"],
        result.queryMetrics.map((metric) => [
          metric.name,
          `${formatNumber(metric.elapsed_ms)} ms`,
          formatNumber(metric.bytes),
          formatNumber(metric.estimated_tokens),
        ]),
      ),
    )
    lines.push("")
    lines.push("### Token Tasks")
    lines.push("")
    lines.push(
      markdownTable(
        [
          "Symbol",
          "File",
          "Full Source Tokens",
          "Exact Files",
          "Exact Tokens",
          "ContextZero Tokens",
          "Full Reduction",
          "Exact Reduction",
          "Exact Savings",
          "Exact Time",
          "Context Time",
        ],
        result.tokenRows.map((row) => [
          row.symbol,
          row.file_path,
          formatNumber(row.full_source_estimated_tokens),
          row.exact_files,
          formatNumber(row.exact_estimated_tokens),
          formatNumber(row.contextzero_estimated_tokens),
          `${row.full_source_reduction_ratio}x`,
          `${row.exact_reduction_ratio}x`,
          `${row.exact_savings_percent}%`,
          `${formatNumber(row.exact_elapsed_ms)} ms`,
          `${formatNumber(row.contextzero_elapsed_ms)} ms`,
        ]),
      ),
    )
    lines.push("")
  }

  lines.push("## Caveats")
  lines.push("")
  lines.push(
    "- These are local Windows measurements from this machine; ingestion timings include local disk, CPU, Node, and PostgreSQL pool behavior.",
  )
  lines.push("- Token counts are byte-based estimates for repeatability, not exact model tokenizer counts.")
  lines.push(
    "- Some repositories are intentionally multi-language; the primary language column names the benchmark focus, while the indexed-language table shows what actually landed in the graph.",
  )
  lines.push(
    "- PHP and Bash adapter smoke tests currently return zero symbols on this install because their tree-sitter grammar setup fails or yields no symbol nodes; Laravel and nvm are included to show that failure at repo level instead of hiding it.",
  )
  lines.push(
    "- The whole-source baseline represents an agent reading all source/document files for each task. The exact-symbol baseline is stricter and usually much smaller.",
  )
  lines.push("")

  await fsp.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8")
}

async function main(): Promise<void> {
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
  await fsp.mkdir(cacheDir, { recursive: true })
  const smokeRows = await adapterSmoke()
  const selected = process.env.BENCH_REPOS
    ? allTargets.filter((target) =>
        process.env
          .BENCH_REPOS!.split(",")
          .map((s) => s.trim())
          .includes(target.id),
      )
    : allTargets
  const results: TargetResult[] = []
  for (const target of selected) {
    const cached = await loadCachedResult(target)
    if (cached) {
      process.stderr.write(`\n--- Using cached benchmark ${target.name} (${target.primaryLanguages.join(", ")}) ---\n`)
      results.push(cached)
      await writeReport(smokeRows, results, {
        ok: false,
        elapsed_ms: 0,
        tools: 0,
        stderr_tail: "[pending until final step]",
      })
      continue
    }
    process.stderr.write(`\n--- Benchmarking ${target.name} (${target.primaryLanguages.join(", ")}) ---\n`)
    const result = await ingestTarget(target)
    results.push(result)
    await saveCachedResult(target, result)
    await writeReport(smokeRows, results, {
      ok: false,
      elapsed_ms: 0,
      tools: 0,
      stderr_tail: "[pending until final step]",
    })
  }
  const mcp = await mcpSmoke()
  await writeReport(smokeRows, results, mcp)
  await db.close()
  process.stdout.write(`Multi-language benchmark report written to ${outputPath}\n`)
}

main().catch(async (error) => {
  await db.close().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
