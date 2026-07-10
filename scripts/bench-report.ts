import { spawn, spawnSync } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"
import { performance } from "perf_hooks"
import { db } from "../src/db-driver"
import { ingestor } from "../src/ingestor"
import { capsuleCompiler } from "../src/analysis-engine/capsule-compiler"
import { blastRadiusEngine } from "../src/analysis-engine/blast-radius"
import { buildNativeCodebaseOverview, searchWorkspaceCode, searchWorkspaceSymbols } from "../src/workspace-native"

const repoRoot = path.resolve(process.argv[2] || process.cwd())
const contextZeroRoot = path.resolve(__dirname, "..")
const outputPath = path.resolve(process.argv[3] || path.join(repoRoot, "CONTEXTZERO_BENCHMARK_REPORT.md"))
const benchmarkTargetCount = Math.max(1, Math.min(12, Number(process.env.BENCH_TARGETS || 8)))
const tokenDivisor = 4

const skipDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pytest_cache",
  "__pycache__",
])

const sourceExts = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".cpp",
  ".cc",
  ".cxx",
  ".h",
  ".hpp",
  ".rb",
  ".kt",
  ".swift",
  ".php",
  ".sh",
  ".sql",
  ".json",
  ".md",
  ".yml",
  ".yaml",
])

interface CorpusStats {
  files: number
  source_files: number
  bytes: number
  source_bytes: number
  lines: number
  estimated_tokens: number
  source_estimated_tokens: number
  by_extension: Record<string, { files: number; bytes: number; lines: number }>
}

interface CommandResult {
  command: string
  exit_code: number | null
  elapsed_ms: number
  stdout_tail: string
  stderr_tail: string
}

interface QueryMetric {
  name: string
  elapsed_ms: number
  response_bytes: number
  estimated_tokens: number
  notes: string
}

interface RepoMetadata {
  remote: string
  commit: string
  branch: string
}

interface TokenTask {
  symbol: string
  file_path: string
  full_source_estimated_tokens: number
  full_repo_reduction_ratio: number
  full_repo_savings_percent: number
  traditional_files: number
  traditional_bytes: number
  traditional_estimated_tokens: number
  traditional_elapsed_ms: number
  contextzero_bytes: number
  contextzero_estimated_tokens: number
  contextzero_elapsed_ms: number
  token_reduction_ratio: number
  token_savings_percent: number
}

interface IndexCounts {
  files: number
  symbol_versions: number
  structural_relations: number
  behavioral_profiles: number
  contract_profiles: number
  effect_signatures: number
  invariants: number
  dispatch_edges: number
  class_hierarchy: number
  concept_families: number
  concept_family_members: number
  temporal_co_changes: number
  temporal_risk_scores: number
  runtime_traces: number
  runtime_observed_edges: number
}

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start)
}

function estimatedTokens(bytesOrChars: number): number {
  return Math.ceil(bytesOrChars / tokenDivisor)
}

function normalizeRel(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/")
}

function shouldSkipDir(dirName: string): boolean {
  return skipDirs.has(dirName)
}

function isInsideRepo(filePath: string): boolean {
  const relative = path.relative(repoRoot, filePath)
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function shouldSkipFile(filePath: string): boolean {
  return path.resolve(filePath) === outputPath
}

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!shouldSkipDir(entry.name)) {
        await walkFiles(full, out)
      }
      continue
    }
    if (entry.isFile() && !shouldSkipFile(full)) out.push(full)
  }
  return out
}

async function collectCorpusStats(): Promise<CorpusStats> {
  const files = await walkFiles(repoRoot)
  const byExtension: CorpusStats["by_extension"] = {}
  let sourceFiles = 0
  let bytes = 0
  let sourceBytes = 0
  let lines = 0

  for (const file of files) {
    const ext = path.extname(file).toLowerCase() || "[none]"
    const stat = await fsp.stat(file)
    bytes += stat.size

    if (!sourceExts.has(ext)) continue
    sourceFiles++
    sourceBytes += stat.size
    const text = await fsp.readFile(file, "utf8").catch(() => "")
    const fileLines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length
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
    estimated_tokens: estimatedTokens(bytes),
    source_estimated_tokens: estimatedTokens(sourceBytes),
    by_extension: Object.fromEntries(Object.entries(byExtension).sort((a, b) => b[1].bytes - a[1].bytes)),
  }
}

function runCommand(command: string, args: string[], timeoutMs: number): CommandResult {
  const start = performance.now()
  const result = spawnSync(command, args, {
    cwd: contextZeroRoot,
    env: {
      ...process.env,
      DB_HOST: process.env.DB_HOST || "localhost",
      DB_PORT: process.env.DB_PORT || "5432",
      DB_NAME: process.env.DB_NAME || "scg_v2",
      DB_USER: process.env.DB_USER || "postgres",
      DB_PASSWORD: process.env.DB_PASSWORD || "postgres",
      NODE_ENV: process.env.NODE_ENV || "development",
      LOG_LEVEL: process.env.LOG_LEVEL || "warn",
      SCG_ALLOWED_BASE_PATHS: process.env.SCG_ALLOWED_BASE_PATHS || repoRoot,
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 30 * 1024 * 1024,
    shell: process.platform === "win32",
  })
  return {
    command: [command, ...args].join(" "),
    exit_code: result.status,
    elapsed_ms: elapsedMs(start),
    stdout_tail: tail(result.stdout || "", 12),
    stderr_tail: tail(result.stderr || "", 12),
  }
}

function gitValue(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  })
  return result.status === 0 ? result.stdout.trim() : "[unavailable]"
}

function collectRepoMetadata(): RepoMetadata {
  return {
    remote: gitValue(["config", "--get", "remote.origin.url"]),
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
  }
}

function tail(text: string, lines: number): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n")
}

async function ensureDatabaseReady(): Promise<void> {
  await db.query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
}

async function timedQuery(name: string, notes: string, fn: () => Promise<unknown>): Promise<QueryMetric> {
  const start = performance.now()
  const data = await fn()
  const json = JSON.stringify(data)
  const bytes = Buffer.byteLength(json, "utf8")
  return {
    name,
    elapsed_ms: elapsedMs(start),
    response_bytes: bytes,
    estimated_tokens: estimatedTokens(bytes),
    notes,
  }
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const result = await db.query(sql, params)
  const row = result.rows[0] as { count?: number | string; c?: number | string } | undefined
  return Number(row?.count ?? row?.c ?? 0)
}

async function collectIndexCounts(snapshotId: string, repoId: string): Promise<IndexCounts> {
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
    invariants: await countRows(
      `SELECT COUNT(*)::int AS count
             FROM invariants
             WHERE last_verified_snapshot_id = $1`,
      [snapshotId],
    ),
    dispatch_edges: await countRows("SELECT COUNT(*)::int AS count FROM dispatch_edges WHERE snapshot_id = $1", [
      snapshotId,
    ]),
    class_hierarchy: await countRows("SELECT COUNT(*)::int AS count FROM class_hierarchy WHERE snapshot_id = $1", [
      snapshotId,
    ]),
    concept_families: await countRows("SELECT COUNT(*)::int AS count FROM concept_families WHERE snapshot_id = $1", [
      snapshotId,
    ]),
    concept_family_members: await countRows(
      `SELECT COUNT(*)::int AS count
             FROM concept_family_members cfm
             JOIN concept_families cf ON cf.family_id = cfm.family_id
             WHERE cf.snapshot_id = $1`,
      [snapshotId],
    ),
    temporal_co_changes: await countRows("SELECT COUNT(*)::int AS count FROM temporal_co_changes WHERE repo_id = $1", [
      repoId,
    ]),
    temporal_risk_scores: await countRows(
      "SELECT COUNT(*)::int AS count FROM temporal_risk_scores WHERE snapshot_id = $1",
      [snapshotId],
    ),
    runtime_traces: await countRows("SELECT COUNT(*)::int AS count FROM runtime_traces WHERE snapshot_id = $1", [
      snapshotId,
    ]),
    runtime_observed_edges: await countRows(
      "SELECT COUNT(*)::int AS count FROM runtime_observed_edges WHERE snapshot_id = $1",
      [snapshotId],
    ),
  }
}

async function ingestBenchmark(): Promise<{
  repo_id: string | null
  snapshot_id: string
  commit_sha: string
  elapsed_ms: number
  result: Record<string, unknown>
  index_counts: IndexCounts
}> {
  const commitSha = `bench-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  const start = performance.now()
  const result = await ingestor.ingestRepo(repoRoot, `${path.basename(repoRoot)}-benchmark`, commitSha, "benchmark")
  const ingestElapsed = elapsedMs(start)

  const snap = await db.query(
    `SELECT s.snapshot_id, r.repo_id
         FROM snapshots s
         JOIN repositories r ON r.repo_id = s.repo_id
         WHERE s.commit_sha = $1
         ORDER BY s.indexed_at DESC
         LIMIT 1`,
    [commitSha],
  )
  const row = snap.rows[0] as { snapshot_id: string; repo_id: string } | undefined
  if (!row) throw new Error("Benchmark ingestion completed but no snapshot row was found.")
  const indexCounts = await collectIndexCounts(row.snapshot_id, row.repo_id)

  return {
    repo_id: row.repo_id,
    snapshot_id: row.snapshot_id,
    commit_sha: commitSha,
    elapsed_ms: ingestElapsed,
    result: result as unknown as Record<string, unknown>,
    index_counts: indexCounts,
  }
}

async function selectTargets(snapshotId: string): Promise<
  Array<{
    symbol_version_id: string
    canonical_name: string
    file_path: string
    body_len: number
  }>
> {
  const result = await db.query(
    `SELECT sv.symbol_version_id,
                s.canonical_name,
                f.path AS file_path,
                LENGTH(COALESCE(sv.body_source, '')) AS body_len
         FROM symbol_versions sv
         JOIN symbols s ON s.symbol_id = sv.symbol_id
         JOIN files f ON f.file_id = sv.file_id
         WHERE f.snapshot_id = $1
           AND s.kind IN ('function', 'method', 'class')
           AND LENGTH(COALESCE(sv.body_source, '')) >= 400
           AND LENGTH(s.canonical_name) >= 6
           AND f.path NOT LIKE '%__tests__%'
         ORDER BY body_len DESC, s.canonical_name ASC
         LIMIT $2`,
    [snapshotId, benchmarkTargetCount],
  )
  return result.rows as Array<{
    symbol_version_id: string
    canonical_name: string
    file_path: string
    body_len: number
  }>
}

async function traditionalFootprint(symbol: string): Promise<{
  files: number
  bytes: number
  elapsed_ms: number
}> {
  const start = performance.now()
  const allFiles = await walkFiles(repoRoot)
  const matches: string[] = []
  const wordPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase()
    if (!sourceExts.has(ext)) continue
    const text = await fsp.readFile(file, "utf8").catch(() => "")
    if (wordPattern.test(text)) matches.push(file)
  }

  let bytes = 0
  for (const file of matches) {
    bytes += (await fsp.stat(file)).size
  }

  return {
    files: matches.length,
    bytes,
    elapsed_ms: elapsedMs(start),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function tokenSavingsBenchmarks(snapshotId: string, corpusForTokenBench: CorpusStats): Promise<TokenTask[]> {
  const targets = await selectTargets(snapshotId)
  const rows: TokenTask[] = []

  for (const target of targets) {
    const traditional = await traditionalFootprint(target.canonical_name)
    const start = performance.now()
    const capsule = await capsuleCompiler.compile(target.symbol_version_id, snapshotId, "strict")
    const contextzeroJson = JSON.stringify(capsule)
    const contextzeroBytes = Buffer.byteLength(contextzeroJson, "utf8")
    const contextzeroElapsed = elapsedMs(start)
    const traditionalTokens = estimatedTokens(traditional.bytes)
    const contextzeroTokens = estimatedTokens(contextzeroBytes)
    const ratio = traditionalTokens / Math.max(1, contextzeroTokens)
    const fullRepoRatio = corpusForTokenBench.source_estimated_tokens / Math.max(1, contextzeroTokens)
    rows.push({
      symbol: target.canonical_name,
      file_path: target.file_path,
      full_source_estimated_tokens: corpusForTokenBench.source_estimated_tokens,
      full_repo_reduction_ratio: round(fullRepoRatio, 2),
      full_repo_savings_percent: round(
        (1 - contextzeroTokens / Math.max(1, corpusForTokenBench.source_estimated_tokens)) * 100,
        2,
      ),
      traditional_files: traditional.files,
      traditional_bytes: traditional.bytes,
      traditional_estimated_tokens: traditionalTokens,
      traditional_elapsed_ms: traditional.elapsed_ms,
      contextzero_bytes: contextzeroBytes,
      contextzero_estimated_tokens: contextzeroTokens,
      contextzero_elapsed_ms: contextzeroElapsed,
      token_reduction_ratio: round(ratio, 2),
      token_savings_percent: round((1 - contextzeroTokens / Math.max(1, traditionalTokens)) * 100, 2),
    })
  }

  return rows
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

async function mcpSmoke(): Promise<{
  ok: boolean
  elapsed_ms: number
  tools: number
  stderr_tail: string
}> {
  const start = performance.now()
  return await new Promise((resolve) => {
    const child = spawn("node", [path.join(contextZeroRoot, "dist", "mcp-bridge", "index.js")], {
      cwd: contextZeroRoot,
      env: {
        ...process.env,
        DB_HOST: process.env.DB_HOST || "localhost",
        DB_PORT: process.env.DB_PORT || "5432",
        DB_NAME: process.env.DB_NAME || "scg_v2",
        DB_USER: process.env.DB_USER || "postgres",
        DB_PASSWORD: process.env.DB_PASSWORD || "postgres",
        NODE_ENV: process.env.NODE_ENV || "development",
        LOG_LEVEL: "error",
        SCG_ALLOWED_BASE_PATHS: process.env.SCG_ALLOWED_BASE_PATHS || repoRoot,
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
        stderr_tail: tail(stderr, 8),
      })
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
            finish(true, msg.result.tools.length)
          }
        } catch {
          // Ignore partial JSON-RPC frames until a full line arrives.
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

    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "contextzero-benchmark", version: "1.0.0" },
      },
    }
    child.stdin.write(`${JSON.stringify(initialize)}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`)

    setTimeout(() => finish(false), 15_000)
  })
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  const header = `| ${headers.join(" | ")} |`
  const divider = `| ${headers.map(() => "---").join(" | ")} |`
  const body = rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\n/g, "<br>")).join(" | ")} |`)
  return [header, divider, ...body].join("\n")
}

function summarizeTokenRows(rows: TokenTask[]): {
  full_repo_tokens: number
  traditional_tokens: number
  contextzero_tokens: number
  traditional_files: number
  traditional_time_ms: number
  contextzero_time_ms: number
  full_repo_reduction_ratio: number
  full_repo_savings_percent: number
  token_reduction_ratio: number
  token_savings_percent: number
} {
  const totals = rows.reduce(
    (acc, row) => {
      acc.full_repo_tokens += row.full_source_estimated_tokens
      acc.traditional_tokens += row.traditional_estimated_tokens
      acc.contextzero_tokens += row.contextzero_estimated_tokens
      acc.traditional_files += row.traditional_files
      acc.traditional_time_ms += row.traditional_elapsed_ms
      acc.contextzero_time_ms += row.contextzero_elapsed_ms
      return acc
    },
    {
      full_repo_tokens: 0,
      traditional_tokens: 0,
      contextzero_tokens: 0,
      traditional_files: 0,
      traditional_time_ms: 0,
      contextzero_time_ms: 0,
    },
  )

  return {
    ...totals,
    full_repo_reduction_ratio: round(totals.full_repo_tokens / Math.max(1, totals.contextzero_tokens), 2),
    full_repo_savings_percent: round((1 - totals.contextzero_tokens / Math.max(1, totals.full_repo_tokens)) * 100, 2),
    token_reduction_ratio: round(totals.traditional_tokens / Math.max(1, totals.contextzero_tokens), 2),
    token_savings_percent: round((1 - totals.contextzero_tokens / Math.max(1, totals.traditional_tokens)) * 100, 2),
  }
}

function collectBenchmarkCaveats(data: {
  corpus: CorpusStats
  commands: CommandResult[]
  ingest: Awaited<ReturnType<typeof ingestBenchmark>>
  mcp: Awaited<ReturnType<typeof mcpSmoke>>
}): string[] {
  const caveats: string[] = []
  const python3 = spawnSync("python3", ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
    shell: process.platform === "win32",
  })
  const filesFailed = Number(data.ingest.result.files_failed || 0)
  const lineagesComputed = Number(data.ingest.result.lineages_computed || 0)

  if (python3.status !== 0) {
    caveats.push(
      "`python3` is not available on this Windows PATH. Python extraction can be incomplete until Python is installed or the `python3` command is mapped to the installed Python runtime.",
    )
  }
  if (filesFailed > 0 && python3.status !== 0) {
    caveats.push(
      `${formatNumber(filesFailed)} file(s) failed during ingestion on this Windows host, matching the missing \`python3\` runtime path for Python extraction. TypeScript/JavaScript indexing still completed.`,
    )
  } else if (filesFailed > 0) {
    caveats.push(
      `${formatNumber(filesFailed)} file(s) failed during ingestion. Treat this as a partial-language benchmark unless those failures are resolved.`,
    )
  }
  if (data.commands.some((command) => command.stderr_tail.includes("Failed to recover stale transaction"))) {
    caveats.push(
      "The test suite prints an error log from a transaction recovery test, but Jest still reports all suites and tests passing.",
    )
  }
  if (lineagesComputed === 0) {
    caveats.push(
      "Symbol lineage count was 0 in the ingestor result, so lineage-dependent benchmark dimensions should be treated as unavailable for this run.",
    )
  }
  caveats.push(
    "Ingestion wall time includes local PostgreSQL pool behavior and local disk/CPU limits on this Windows host.",
  )
  if ((data.corpus.by_extension[".js"]?.files || 0) > 0 || (data.corpus.by_extension[".mjs"]?.files || 0) > 0) {
    caveats.push(
      "This repo contains JavaScript/MJS utility and fixture files. The TypeScript program extractor can warn when those files are outside `tsconfig.json`; they are still included in corpus totals.",
    )
  }
  if ((data.corpus.by_extension[".sh"]?.files || 0) > 0) {
    caveats.push(
      "This repo contains shell scripts. Native filesystem query helpers may emit tree-sitter warnings for some shell fixtures while still completing the timed query.",
    )
  }
  if (data.mcp.stderr_tail) {
    caveats.push(
      "The MCP smoke-test stderr tail is captured in the MCP section, including runtime warnings from dependencies.",
    )
  }

  return caveats.length > 0 ? caveats : ["No benchmark caveats were detected by the script."]
}

async function writeReport(data: {
  repoMetadata: RepoMetadata
  corpus: CorpusStats
  commands: CommandResult[]
  ingest: Awaited<ReturnType<typeof ingestBenchmark>>
  queryMetrics: QueryMetric[]
  tokenRows: TokenTask[]
  mcp: Awaited<ReturnType<typeof mcpSmoke>>
}): Promise<void> {
  const tokenSummary = summarizeTokenRows(data.tokenRows)
  const caveats = collectBenchmarkCaveats(data)
  const now = new Date().toISOString()
  const host = `${os.hostname()} / ${os.platform()} ${os.release()} / ${os.cpus()[0]?.model || "unknown CPU"}`
  const lines: string[] = []

  lines.push("# ContextZero Benchmark Report")
  lines.push("")
  lines.push(`Generated: ${now}`)
  lines.push(`Target repository: \`${repoRoot}\``)
  lines.push(`Target remote: \`${data.repoMetadata.remote}\``)
  lines.push(`Target branch: \`${data.repoMetadata.branch}\``)
  lines.push(`Target commit: \`${data.repoMetadata.commit}\``)
  lines.push(`ContextZero engine root: \`${contextZeroRoot}\``)
  lines.push(`Host: \`${host}\``)
  lines.push(
    `Token estimate policy: \`ceil(bytes / ${tokenDivisor})\`. This is a deterministic approximation, not a provider tokenizer.`,
  )
  lines.push("")
  lines.push("## Benchmarks Included")
  lines.push("")
  lines.push("1. Corpus baseline: target repo files, source/document lines, bytes, and raw-read token estimate.")
  lines.push("2. Engine verification: ContextZero build/test/audit command timing and pass/fail status.")
  lines.push("3. Ingestion/indexing: end-to-end repo ingest timing and extracted graph counts.")
  lines.push(
    "4. Query latency and output size: native overview, native symbol search, native code search, health, blast radius.",
  )
  lines.push(
    "5. Token savings: whole source/document repo read and exact-symbol grep-and-read vs ContextZero strict context capsule for real symbols.",
  )
  lines.push("6. MCP readiness: stdio bridge startup and tool-list smoke test.")
  lines.push("")
  lines.push("## Executive Summary")
  lines.push("")
  lines.push(
    markdownTable(
      ["Metric", "Value"],
      [
        ["Corpus files scanned", formatNumber(data.corpus.files)],
        ["Source/document files counted", formatNumber(data.corpus.source_files)],
        ["Corpus lines", formatNumber(data.corpus.lines)],
        ["All corpus bytes", formatNumber(data.corpus.bytes)],
        ["Source/document bytes", formatNumber(data.corpus.source_bytes)],
        ["All corpus estimated tokens", formatNumber(data.corpus.estimated_tokens)],
        ["Source/document estimated tokens", formatNumber(data.corpus.source_estimated_tokens)],
        ["Ingestion wall time", `${formatNumber(data.ingest.elapsed_ms)} ms`],
        ["Files processed by ingestor", formatNumber(Number(data.ingest.result.files_processed || 0))],
        ["Files indexed in database", formatNumber(data.ingest.index_counts.files)],
        ["Symbols extracted", formatNumber(Number(data.ingest.result.symbols_extracted || 0))],
        ["Symbol versions indexed", formatNumber(data.ingest.index_counts.symbol_versions)],
        ["Relations extracted", formatNumber(Number(data.ingest.result.relations_extracted || 0))],
        ["Structural relations indexed", formatNumber(data.ingest.index_counts.structural_relations)],
        ["Token benchmark tasks", formatNumber(data.tokenRows.length)],
        ["Whole-source traditional estimated tokens", formatNumber(tokenSummary.full_repo_tokens)],
        ["Exact-symbol traditional estimated tokens", formatNumber(tokenSummary.traditional_tokens)],
        ["ContextZero estimated tokens", formatNumber(tokenSummary.contextzero_tokens)],
        ["Whole-source token reduction", `${tokenSummary.full_repo_reduction_ratio}x fewer`],
        ["Whole-source token savings", `${tokenSummary.full_repo_savings_percent}%`],
        ["Exact-symbol token reduction", `${tokenSummary.token_reduction_ratio}x fewer`],
        ["Exact-symbol token savings", `${tokenSummary.token_savings_percent}%`],
        [
          "MCP smoke test",
          data.mcp.ok
            ? `passed, ${data.mcp.tools} tools, ${data.mcp.elapsed_ms} ms`
            : `failed, ${data.mcp.elapsed_ms} ms`,
        ],
      ],
    ),
  )
  lines.push("")
  lines.push("## Corpus Baseline")
  lines.push("")
  lines.push(
    markdownTable(
      ["Extension", "Files", "Lines", "Bytes"],
      Object.entries(data.corpus.by_extension)
        .slice(0, 20)
        .map(([ext, stats]) => [ext, formatNumber(stats.files), formatNumber(stats.lines), formatNumber(stats.bytes)]),
    ),
  )
  lines.push("")
  lines.push("## ContextZero Engine Build, Test, Audit")
  lines.push("")
  lines.push(`Commands in this section ran from \`${contextZeroRoot}\`, not from the target repository.`)
  lines.push("")
  lines.push(
    markdownTable(
      ["Command", "Exit", "Time", "Stdout Tail", "Stderr Tail"],
      data.commands.map((cmd) => [
        `\`${cmd.command}\``,
        cmd.exit_code === 0 ? "pass" : `fail (${cmd.exit_code ?? "null"})`,
        `${formatNumber(cmd.elapsed_ms)} ms`,
        cmd.stdout_tail ? `\`${cmd.stdout_tail.replace(/\|/g, "\\|")}\`` : "",
        cmd.stderr_tail ? `\`${cmd.stderr_tail.replace(/\|/g, "\\|")}\`` : "",
      ]),
    ),
  )
  lines.push("")
  lines.push("## Ingestion And Indexing")
  lines.push("")
  lines.push(
    markdownTable(
      ["Field", "Value"],
      [
        ["Repository ID", data.ingest.repo_id || "[unknown]"],
        ["Snapshot ID", data.ingest.snapshot_id],
        ["Synthetic benchmark commit", data.ingest.commit_sha],
        ["Wall time", `${formatNumber(data.ingest.elapsed_ms)} ms`],
        ["Reported duration", `${formatNumber(Number(data.ingest.result.duration_ms || 0))} ms`],
        ["Files processed", formatNumber(Number(data.ingest.result.files_processed || 0))],
        ["Symbols extracted", formatNumber(Number(data.ingest.result.symbols_extracted || 0))],
        ["Relations extracted", formatNumber(Number(data.ingest.result.relations_extracted || 0))],
        ["Behavior hints extracted", formatNumber(Number(data.ingest.result.behavior_hints_extracted || 0))],
        ["Contract hints extracted", formatNumber(Number(data.ingest.result.contract_hints_extracted || 0))],
        ["Dispatch edges resolved", formatNumber(Number(data.ingest.result.dispatch_edges_resolved || 0))],
        ["Lineages computed", formatNumber(Number(data.ingest.result.lineages_computed || 0))],
        ["Effect signatures computed", formatNumber(Number(data.ingest.result.effect_signatures_computed || 0))],
        ["Deep contracts mined", formatNumber(Number(data.ingest.result.deep_contracts_mined || 0))],
        ["Concept families built", formatNumber(Number(data.ingest.result.concept_families_built || 0))],
        ["Temporal co-changes found", formatNumber(Number(data.ingest.result.temporal_co_changes_found || 0))],
        ["DB files indexed", formatNumber(data.ingest.index_counts.files)],
        ["DB symbol versions indexed", formatNumber(data.ingest.index_counts.symbol_versions)],
        ["DB structural relations indexed", formatNumber(data.ingest.index_counts.structural_relations)],
        ["DB behavioral profiles indexed", formatNumber(data.ingest.index_counts.behavioral_profiles)],
        ["DB contract profiles indexed", formatNumber(data.ingest.index_counts.contract_profiles)],
        ["DB effect signatures indexed", formatNumber(data.ingest.index_counts.effect_signatures)],
        ["DB invariants indexed", formatNumber(data.ingest.index_counts.invariants)],
        ["DB dispatch edges indexed", formatNumber(data.ingest.index_counts.dispatch_edges)],
        ["DB class hierarchy rows indexed", formatNumber(data.ingest.index_counts.class_hierarchy)],
        ["DB concept families indexed", formatNumber(data.ingest.index_counts.concept_families)],
        ["DB concept family members indexed", formatNumber(data.ingest.index_counts.concept_family_members)],
        ["DB temporal co-change rows for repo", formatNumber(data.ingest.index_counts.temporal_co_changes)],
        ["DB temporal risk scores indexed", formatNumber(data.ingest.index_counts.temporal_risk_scores)],
        ["DB runtime traces indexed", formatNumber(data.ingest.index_counts.runtime_traces)],
        ["DB runtime observed edges indexed", formatNumber(data.ingest.index_counts.runtime_observed_edges)],
      ],
    ),
  )
  lines.push("")
  lines.push("## Query Latency And Output Size")
  lines.push("")
  lines.push(
    markdownTable(
      ["Query", "Time", "Bytes", "Estimated Tokens", "Notes"],
      data.queryMetrics.map((metric) => [
        metric.name,
        `${formatNumber(metric.elapsed_ms)} ms`,
        formatNumber(metric.response_bytes),
        formatNumber(metric.estimated_tokens),
        metric.notes,
      ]),
    ),
  )
  lines.push("")
  lines.push("## Token Savings Tasks")
  lines.push("")
  lines.push(
    "Whole-source baseline means: read every source/document file in the target repository. Exact-symbol baseline means: find every source/document file containing the exact symbol name and read those files into context. ContextZero means: compile a strict context capsule for the same symbol.",
  )
  lines.push("")
  lines.push(
    markdownTable(
      [
        "Symbol",
        "File",
        "Full Source Tokens",
        "Full Source Reduction",
        "Exact Files",
        "Exact Tokens",
        "ContextZero Tokens",
        "Exact Reduction",
        "Exact Savings",
        "Exact Time",
        "ContextZero Time",
      ],
      data.tokenRows.map((row) => [
        row.symbol,
        row.file_path,
        formatNumber(row.full_source_estimated_tokens),
        `${row.full_repo_reduction_ratio}x`,
        row.traditional_files,
        formatNumber(row.traditional_estimated_tokens),
        formatNumber(row.contextzero_estimated_tokens),
        `${row.token_reduction_ratio}x`,
        `${row.token_savings_percent}%`,
        `${formatNumber(row.traditional_elapsed_ms)} ms`,
        `${formatNumber(row.contextzero_elapsed_ms)} ms`,
      ]),
    ),
  )
  lines.push("")
  lines.push("### Token Savings Totals")
  lines.push("")
  lines.push(
    markdownTable(
      [
        "Full Source Tokens",
        "Exact Files",
        "Exact Tokens",
        "ContextZero Tokens",
        "Full Source Reduction",
        "Full Source Savings",
        "Exact Reduction",
        "Exact Savings",
        "Exact Time",
        "ContextZero Time",
      ],
      [
        [
          formatNumber(tokenSummary.full_repo_tokens),
          formatNumber(tokenSummary.traditional_files),
          formatNumber(tokenSummary.traditional_tokens),
          formatNumber(tokenSummary.contextzero_tokens),
          `${tokenSummary.full_repo_reduction_ratio}x`,
          `${tokenSummary.full_repo_savings_percent}%`,
          `${tokenSummary.token_reduction_ratio}x`,
          `${tokenSummary.token_savings_percent}%`,
          `${formatNumber(tokenSummary.traditional_time_ms)} ms`,
          `${formatNumber(tokenSummary.contextzero_time_ms)} ms`,
        ],
      ],
    ),
  )
  lines.push("")
  lines.push("## MCP Readiness")
  lines.push("")
  lines.push(
    markdownTable(
      ["Check", "Result"],
      [
        ["Stdio bridge starts", data.mcp.ok ? "yes" : "no"],
        ["Tools listed", formatNumber(data.mcp.tools)],
        ["Handshake and tools/list time", `${formatNumber(data.mcp.elapsed_ms)} ms`],
        ["Stderr tail", data.mcp.stderr_tail ? `\`${data.mcp.stderr_tail.replace(/\|/g, "\\|")}\`` : ""],
      ],
    ),
  )
  lines.push("")
  lines.push("## Observed Caveats")
  lines.push("")
  for (const caveat of caveats) {
    lines.push(`- ${caveat}`)
  }
  lines.push("")
  lines.push("## Interpretation Notes")
  lines.push("")
  lines.push(
    "- These are local Windows measurements from this machine, so speed numbers include local disk, PostgreSQL, Node, and CPU behavior.",
  )
  lines.push(
    "- Token counts are deterministic byte-based estimates for repeatability. Exact Claude/OpenAI tokenizer counts will differ by model.",
  )
  lines.push(
    "- The token-saving comparison intentionally uses a simple, reproducible traditional baseline. A human or agent could read fewer files with more judgment, or far more files when tracing dependencies manually.",
  )
  lines.push(
    "- The current remote HTTP server is REST, not Streamable HTTP MCP. Local Codex/Claude integration is via stdio MCP.",
  )
  lines.push("")

  await fsp.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8")
}

async function main(): Promise<void> {
  await ensureDatabaseReady()
  if (isInsideRepo(outputPath) && path.basename(outputPath).toLowerCase() === "contextzero_benchmark_report.md") {
    await fsp.rm(outputPath, { force: true })
  }

  const repoMetadata = collectRepoMetadata()
  const corpus = await collectCorpusStats()
  const commands = [
    runCommand("npm.cmd", ["run", "build"], 180_000),
    runCommand("npm.cmd", ["test", "--", "--runInBand"], 240_000),
    runCommand("npm.cmd", ["audit"], 120_000),
  ]

  const ingest = await ingestBenchmark()
  const firstTarget = (await selectTargets(ingest.snapshot_id))[0]
  const queryMetrics = [
    await timedQuery("db.healthCheck", "Database connectivity and extension status.", () => db.healthCheck()),
    await timedQuery("native_codebase_overview", "Pre-index filesystem overview of the benchmark repository.", () =>
      buildNativeCodebaseOverview(repoRoot, { maxFiles: 2_000 }),
    ),
    await timedQuery("native_symbol_search", 'Pre-index symbol search for "config".', () =>
      searchWorkspaceSymbols(repoRoot, "config", { maxFiles: 1_500, maxResults: 20 }),
    ),
    await timedQuery("native_search_code", 'Pre-index code search for "SCG_ALLOWED_BASE_PATHS".', () =>
      searchWorkspaceCode(repoRoot, "SCG_ALLOWED_BASE_PATHS", { maxFiles: 1_500, maxResults: 20, contextLines: 2 }),
    ),
  ]

  if (firstTarget) {
    queryMetrics.push(
      await timedQuery("blast_radius_depth_2", `Blast radius for ${firstTarget.canonical_name}.`, () =>
        blastRadiusEngine.computeBlastRadius(ingest.snapshot_id, [firstTarget.symbol_version_id], 2),
      ),
    )
    queryMetrics.push(
      await timedQuery("capsule_strict", `Strict context capsule for ${firstTarget.canonical_name}.`, () =>
        capsuleCompiler.compile(firstTarget.symbol_version_id, ingest.snapshot_id, "strict"),
      ),
    )
  }

  const tokenRows = await tokenSavingsBenchmarks(ingest.snapshot_id, corpus)
  const mcp = await mcpSmoke()

  await writeReport({ repoMetadata, corpus, commands, ingest, queryMetrics, tokenRows, mcp })
  await db.close()
  process.stdout.write(`Benchmark report written to ${outputPath}\n`)
}

main().catch(async (error) => {
  await db.close().catch(() => undefined)
  console.error(error)
  process.exit(1)
})
