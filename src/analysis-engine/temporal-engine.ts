/**
 * ContextZero — Temporal Intelligence Engine
 *
 * Mines git history to understand how code evolves over time.
 * Produces three outputs:
 *   1. Co-change pairs — symbols that change together (Jaccard similarity)
 *   2. Bug-fix hotspots — symbols that attract fixes, regressions, reverts
 *   3. Risk scores — composite per-symbol risk from change frequency,
 *      bug density, regression rate, churn, and ownership dispersion
 *
 * Security: all git commands use asynchronous execFile with argument arrays —
 * never shell-interpolated strings.
 */

import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)
import { v4 as uuidv4 } from "uuid"
import { db } from "../db-driver"
import { Logger } from "../logger"
import { resolveExistingPath } from "../path-security"
import { temporal as temporalConfig } from "../config"
import { blameFile, commitsPerSymbol, withinBudget, type SymbolHistory, type SymbolRange } from "./blame-co-change"
import { refinedParentOf } from "./deep-contracts"

const log = new Logger("temporal-engine")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parsed git commit with its metadata and changed files. */
export interface GitCommit {
  hash: string
  author_name: string
  author_email: string
  date: Date
  subject: string
  files: string[]
  is_bug_fix: boolean
  is_revert: boolean
  is_merge: boolean
}

/** Top-level result returned by computeTemporalIntelligence. */
export interface TemporalResult {
  commits_mined: number
  /** Symbol pairs whose lines were last touched by the same commits (from blame). */
  co_change_pairs: number
  /** File pairs that changed in the same commits (from the log). */
  file_co_change_pairs: number
  /** Files whose lines were attributed to commits; the rest keep file-level history. */
  files_blamed: number
  files_unblamed: number
  risk_scores_computed: number
  duration_ms: number
}

/** A row from temporal_risk_scores. */
export interface TemporalRiskScore {
  risk_id: string
  repo_id: string
  symbol_id: string
  snapshot_id: string
  change_frequency: number
  bug_fix_count: number
  regression_count: number
  recent_churn_30d: number
  distinct_authors: number
  composite_risk: number
  last_change_date: Date | null
  computed_at: Date
}

/** A co-change partner returned by getCoChangePartners. */
export interface CoChangePartner {
  symbol_id: string
  canonical_name: string
  co_change_count: number
  jaccard_coefficient: number
  last_co_change: Date | null
}

/** A file that changes together with one of a symbol's files. */
export interface FileCoChangePartner {
  file: string
  partner: string
  co_change_count: number
  jaccard_coefficient: number
  last_co_change: Date | null
}

/** Accumulator for one unordered pair while counting co-changes. */
interface PairStats {
  count: number
  firstDate: Date | null
  lastDate: Date | null
}

/** Per-symbol accumulator used during risk computation. */
interface SymbolStats {
  total_changes: number
  bug_fix_count: number
  /** Dates of bug-fix commits (for regression detection). */
  bug_fix_dates: Date[]
  revert_count: number
  regression_count: number
  recent_churn_30d: number
  authors: Set<string>
  last_change_date: Date | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex patterns that indicate a bug-fix commit. */
const BUG_FIX_PATTERNS = [
  /\bfix(?:e[sd])?\b/i,
  /\bbug\b/i,
  /\bpatch\b/i,
  /\bhotfix\b/i,
  /\bresolve[sd]?\b/i,
  /\bclose[sd]?\s+#\d+/i,
  /\bregression\b/i,
]

/** Regex pattern for revert commits. */
const REVERT_PATTERN = /^revert\b/i

/** Regex pattern for merge commits (subject line). */
const MERGE_PATTERN = /^Merge\s+(branch|pull\s+request|remote)/i

/**
 * Minimum Jaccard coefficient to create a co_changed_with inferred_relation.
 * Pairs below this threshold are still stored in temporal_co_changes but
 * do not pollute the inferred_relations table.
 */
const CO_CHANGE_RELATION_JACCARD_THRESHOLD = 0.25

/** Minimum co-change count to even consider a pair meaningful. */
const CO_CHANGE_MIN_COUNT = 2

/** Window in days for detecting regressions (same symbol fixed twice). */
const REGRESSION_WINDOW_DAYS = 30

/** Risk weight vector — sums to 1.0. */
const RISK_WEIGHTS = {
  change_frequency: 0.25,
  bug_fix_count: 0.3,
  regression_count: 0.2,
  recent_churn_30d: 0.15,
  distinct_authors: 0.1,
} as const

/** Maximum commits to mine by default (prevents unbounded git log). */
const DEFAULT_MAX_COMMITS = 5000

/** Batch size for DB inserts. */
const DB_BATCH_SIZE = 500

/**
 * Members of one commit that take part in pairing. A commit touching more
 * files or symbols than this is a sweep (a rename, a formatter run), and the
 * pairs it would produce say nothing about any two of them.
 */
const MAX_MEMBERS_PER_COMMIT = 50

/** Blame processes in flight at once. */
const BLAME_CONCURRENCY = 4

/** Wall-clock bound on one blame process. */
const BLAME_FILE_TIMEOUT_MS = 15_000

/**
 * Byte order of the UTF-8 encoding, which is what the database's "C"
 * collation compares. JavaScript's default sort orders UTF-16 code units,
 * and the database's locale collation orders "_" and case differently
 * again; a pair ordered by either of those failed the table's order check.
 */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
}

/** Count every unordered pair of `members` once for a commit dated `date`. `members` is in byte order. */
function countPairs(members: string[], date: Date | null, pairs: Map<string, PairStats>): void {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const key = `${members[i]}|${members[j]}`
      const existing = pairs.get(key)
      if (!existing) {
        pairs.set(key, { count: 1, firstDate: date, lastDate: date })
        continue
      }
      existing.count++
      if (date) {
        if (!existing.firstDate || date < existing.firstDate) existing.firstDate = date
        if (!existing.lastDate || date > existing.lastDate) existing.lastDate = date
      }
    }
  }
}

function splitPair(key: string): [string, string] {
  const pipe = key.indexOf("|")
  return [key.substring(0, pipe), key.substring(pipe + 1)]
}

function jaccard(shared: number, totalA: number, totalB: number): number {
  const union = totalA + totalB - shared
  return union > 0 ? shared / union : 0
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TemporalEngine {
  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Mine git history and compute all temporal intelligence for a repository.
   *
   * Orchestration:
   *   1. Mine git log -> GitCommit[]
   *   2. Blame the snapshot's files -> commits per symbol
   *   3. Compute co-change pairs -> temporal_file_co_changes, temporal_co_changes, inferred_relations
   *   4. Compute risk scores -> temporal_risk_scores
   */
  public async computeTemporalIntelligence(
    repoId: string,
    snapshotId: string,
    repoBasePath: string,
  ): Promise<TemporalResult> {
    const timer = log.startTimer("computeTemporalIntelligence", { repoId, snapshotId })
    const startMs = Date.now()

    const commits = await this.mineGitHistory(repoBasePath)

    if (commits.length === 0) {
      log.info("No commits found — skipping temporal analysis", { repoBasePath })
      const result: TemporalResult = {
        commits_mined: 0,
        co_change_pairs: 0,
        file_co_change_pairs: 0,
        files_blamed: 0,
        files_unblamed: 0,
        risk_scores_computed: 0,
        duration_ms: Date.now() - startMs,
      }
      timer({ ...result })
      return result
    }

    const history = await this.collectSymbolHistory(repoBasePath, snapshotId)

    const [coChanges, riskScores] = await Promise.all([
      this.computeCoChanges(repoId, snapshotId, commits, history),
      this.computeRiskScores(repoId, snapshotId, commits, history),
    ])

    const result: TemporalResult = {
      commits_mined: commits.length,
      co_change_pairs: coChanges.symbol_pairs,
      file_co_change_pairs: coChanges.file_pairs,
      files_blamed: history.blamedFiles.size,
      files_unblamed: history.filesSkipped,
      risk_scores_computed: riskScores,
      duration_ms: Date.now() - startMs,
    }

    timer({ ...result })
    return result
  }

  /**
   * Mine the git log of a repository into structured commit objects.
   *
   * Uses `git log --pretty=format:... --name-only` which outputs:
   *   <hash>|<author>|<email>|<date>|<subject>
   *   file1
   *   file2
   *   <blank line>
   *   <next commit header>
   *   ...
   */
  public async mineGitHistory(repoBasePath: string, maxCommits: number = DEFAULT_MAX_COMMITS): Promise<GitCommit[]> {
    if (typeof repoBasePath !== "string" || repoBasePath.length === 0 || repoBasePath.length > 4096) {
      throw new Error("Invalid repository path")
    }
    repoBasePath = resolveExistingPath(repoBasePath)
    maxCommits = Number.isFinite(maxCommits)
      ? Math.min(50_000, Math.max(1, Math.trunc(maxCommits)))
      : DEFAULT_MAX_COMMITS
    const timer = log.startTimer("mineGitHistory", { repoBasePath, maxCommits })

    let raw: string
    try {
      const result = await execFileAsync(
        "git",
        [
          "log",
          `--max-count=${maxCommits}`,
          // NUL-delimited metadata and file names avoid confusing pipes,
          // whitespace, or quoted path escapes with record structure.
          "--pretty=format:%x1e%H%x00%an%x00%ae%x00%aI%x00%s%x00",
          "-z",
          "--name-only",
          "--diff-filter=ACDMRT", // exclude renames-only noise
        ],
        {
          cwd: repoBasePath,
          encoding: "utf-8",
          maxBuffer: 100 * 1024 * 1024, // 100 MB
          timeout: 120_000, // 2 minutes
        },
      )
      raw = result.stdout
    } catch (err) {
      // Empty repo or not a git repo — return empty
      const message = err instanceof Error ? err.message : String(err)
      if (
        message.includes("does not have any commits") ||
        message.includes("not a git repository") ||
        message.includes("bad default revision")
      ) {
        log.warn("Git log returned no data", { repoBasePath, error: message })
        timer({ commits: 0 })
        return []
      }
      throw err
    }

    if (!raw || raw.trim().length === 0) {
      timer({ commits: 0 })
      return []
    }

    const commits = this.parseGitLog(raw)
    timer({ commits: commits.length })
    return commits
  }

  /**
   * Attribute the snapshot's symbols to the commits that last touched their
   * lines, within the configured blame budget.
   *
   * A commit's diff hunks cannot be mapped onto today's symbol ranges (the
   * lines have moved since), but blame names, for each current line, the
   * commit that last changed it. Files that cannot be blamed (untracked,
   * binary, past the size bound) or that the budget does not reach keep
   * file-level history, and are counted so the ingest log says so.
   */
  public async collectSymbolHistory(repoBasePath: string, snapshotId: string): Promise<SymbolHistory> {
    repoBasePath = resolveExistingPath(repoBasePath)
    const timer = log.startTimer("collectSymbolHistory", { snapshotId })

    const rows = (
      await db.query(
        `SELECT f.path, s.symbol_id, sv.symbol_version_id, sv.range_start_line, sv.range_end_line
           FROM symbol_versions sv
           JOIN symbols s ON s.symbol_id = sv.symbol_id
           JOIN files f ON f.file_id = sv.file_id
          WHERE sv.snapshot_id = $1 AND s.kind <> 'module'`,
        [snapshotId],
      )
    ).rows as {
      path: string
      symbol_id: string
      symbol_version_id: string
      range_start_line: number
      range_end_line: number
    }[]

    const rangesByFile = new Map<string, SymbolRange[]>()
    const symbolsByFile = new Map<string, string[]>()
    const versionBySymbol = new Map<string, string>()
    for (const row of rows) {
      const ranges = rangesByFile.get(row.path) ?? []
      ranges.push({ symbol_id: row.symbol_id, range_start_line: row.range_start_line, range_end_line: row.range_end_line })
      rangesByFile.set(row.path, ranges)
      const ids = symbolsByFile.get(row.path) ?? []
      if (!ids.includes(row.symbol_id)) ids.push(row.symbol_id)
      symbolsByFile.set(row.path, ids)
      versionBySymbol.set(row.symbol_id, row.symbol_version_id)
    }

    // A file with the same content as in the parent snapshot has the same
    // blame: each line's last commit is a property of the content. Its
    // symbols' commit sets are carried from the parent version's stored
    // history instead of being blamed again, as long as every symbol of the
    // file has one; a file where any symbol lacks a stored set is blamed.
    const commitsBySymbol = new Map<string, Set<string>>()
    const blamedFiles = new Set<string>()
    const carriedFiles = new Set<string>()
    const parent = await refinedParentOf(snapshotId)
    if (parent) {
      const carried = (
        await db.query(
          `SELECT f.path, sv.symbol_id, h.commit_shas
             FROM symbol_versions sv
             JOIN symbols s ON s.symbol_id = sv.symbol_id AND s.kind <> 'module'
             JOIN files f ON f.file_id = sv.file_id
             JOIN files pf ON pf.snapshot_id = $2 AND pf.path = f.path AND pf.content_hash = f.content_hash
             JOIN symbol_versions p ON p.snapshot_id = $2 AND p.symbol_id = sv.symbol_id AND p.file_id = pf.file_id
             JOIN symbol_history h ON h.symbol_version_id = p.symbol_version_id
            WHERE sv.snapshot_id = $1`,
          [snapshotId, parent],
        )
      ).rows as { path: string; symbol_id: string; commit_shas: string[] }[]
      const carriedByFile = new Map<string, Map<string, string[]>>()
      for (const row of carried) {
        const perFile = carriedByFile.get(row.path) ?? new Map<string, string[]>()
        perFile.set(row.symbol_id, row.commit_shas)
        carriedByFile.set(row.path, perFile)
      }
      for (const [path, perFile] of carriedByFile) {
        const wanted = symbolsByFile.get(path) ?? []
        if (wanted.length === 0 || !wanted.every((id) => perFile.has(id))) continue
        for (const id of wanted) commitsBySymbol.set(id, new Set(perFile.get(id)))
        carriedFiles.add(path)
      }
    }

    let unblamable = 0
    const toBlame = [...rangesByFile.entries()].filter(([path]) => !carriedFiles.has(path))
    const { skipped } = await withinBudget(toBlame, BLAME_CONCURRENCY, temporalConfig.blameBudgetMs, async ([path, ranges]) => {
      const shas = await blameFile(repoBasePath, path, BLAME_FILE_TIMEOUT_MS)
      if (!shas) {
        unblamable++
        return
      }
      blamedFiles.add(path)
      for (const [symbolId, commits] of commitsPerSymbol(shas, ranges)) commitsBySymbol.set(symbolId, commits)
    })

    // Store what was attributed, carried or blamed, for the next snapshot.
    const historyRows: unknown[][] = []
    for (const [symbolId, commits] of commitsBySymbol) {
      const versionId = versionBySymbol.get(symbolId)
      if (versionId) historyRows.push([versionId, [...commits]])
    }
    if (historyRows.length > 0) {
      await db.bulkInsert("symbol_history", ["symbol_version_id", "commit_shas"], historyRows, {
        conflict: "ON CONFLICT (symbol_version_id) DO UPDATE SET commit_shas = EXCLUDED.commit_shas",
      })
    }

    for (const path of carriedFiles) blamedFiles.add(path)
    timer({
      files: rangesByFile.size,
      blamed: blamedFiles.size - carriedFiles.size,
      carried: carriedFiles.size,
      unblamable,
      budget_skipped: skipped,
    })
    return { commitsBySymbol, blamedFiles, symbolsByFile, filesSkipped: unblamable + skipped }
  }

  /**
   * Persist file-level co-change from the commit log and symbol-level
   * co-change from blame, then refresh the co_changed_with relations.
   *
   * Symbol pairs used to be derived from files: every symbol in a changed
   * file paired with every other, which claimed things about symbols that
   * no line supported (28 MB of them on the local database, and whole files
   * reported as a symbol's partners). File pairs are exact and now live in
   * their own table; a symbol pair exists only where the same commit last
   * touched lines of both symbols. Both tables are rewritten per run, so a
   * pair that history no longer supports does not linger.
   */
  public async computeCoChanges(
    repoId: string,
    snapshotId: string,
    commits: GitCommit[],
    history: SymbolHistory,
  ): Promise<{ symbol_pairs: number; file_pairs: number }> {
    const timer = log.startTimer("computeCoChanges", { repoId, commitCount: commits.length })
    const commitBySha = new Map(commits.map((c) => [c.hash, c]))
    const now = new Date()

    // File pairs, from the log.
    const filePairs = new Map<string, PairStats>()
    const fileChangeCounts = new Map<string, number>()
    for (const commit of commits) {
      if (commit.is_merge) continue // a merge lists its children's files again
      const files = [...new Set(commit.files)].sort(byteOrder).slice(0, MAX_MEMBERS_PER_COMMIT)
      for (const file of files) fileChangeCounts.set(file, (fileChangeCounts.get(file) ?? 0) + 1)
      countPairs(files, commit.date, filePairs)
    }

    await db.query(`DELETE FROM temporal_file_co_changes WHERE repo_id = $1`, [repoId])
    let filePersisted = 0
    let batch: { text: string; params: unknown[] }[] = []
    for (const [key, data] of filePairs) {
      if (data.count < CO_CHANGE_MIN_COUNT) continue
      const [fileA, fileB] = splitPair(key)
      const changesA = fileChangeCounts.get(fileA) ?? 0
      const changesB = fileChangeCounts.get(fileB) ?? 0
      batch.push({
        text: `INSERT INTO temporal_file_co_changes
                    (repo_id, file_a, file_b, co_change_count, total_changes_a, total_changes_b,
                     jaccard_coefficient, first_co_change, last_co_change, computed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        params: [
          repoId,
          fileA,
          fileB,
          data.count,
          changesA,
          changesB,
          jaccard(data.count, changesA, changesB),
          data.firstDate,
          data.lastDate,
          now,
        ],
      })
      filePersisted++
      if (batch.length >= DB_BATCH_SIZE) {
        await db.batchInsert(batch)
        batch = []
      }
    }
    if (batch.length > 0) await db.batchInsert(batch)

    // Symbol pairs, from blame: the same commit last touched lines of both.
    const symbolsByCommit = new Map<string, string[]>()
    for (const [symbolId, shas] of history.commitsBySymbol) {
      for (const sha of shas) {
        const list = symbolsByCommit.get(sha) ?? []
        list.push(symbolId)
        symbolsByCommit.set(sha, list)
      }
    }
    const symbolPairs = new Map<string, PairStats>()
    for (const [sha, symbols] of symbolsByCommit) {
      const members = [...new Set(symbols)].sort(byteOrder).slice(0, MAX_MEMBERS_PER_COMMIT)
      countPairs(members, commitBySha.get(sha)?.date ?? null, symbolPairs)
    }

    await db.query(`DELETE FROM temporal_co_changes WHERE repo_id = $1`, [repoId])
    let symbolPersisted = 0
    batch = []
    for (const [key, data] of symbolPairs) {
      if (data.count < CO_CHANGE_MIN_COUNT) continue
      const [symbolA, symbolB] = splitPair(key)
      const changesA = history.commitsBySymbol.get(symbolA)?.size ?? 0
      const changesB = history.commitsBySymbol.get(symbolB)?.size ?? 0
      batch.push({
        text: `INSERT INTO temporal_co_changes
                    (co_change_id, repo_id, symbol_a_id, symbol_b_id,
                     co_change_count, total_changes_a, total_changes_b,
                     jaccard_coefficient, first_co_change, last_co_change, computed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        params: [
          uuidv4(),
          repoId,
          symbolA,
          symbolB,
          data.count,
          changesA,
          changesB,
          jaccard(data.count, changesA, changesB),
          data.firstDate,
          data.lastDate,
          now,
        ],
      })
      symbolPersisted++
      if (batch.length >= DB_BATCH_SIZE) {
        await db.batchInsert(batch)
        batch = []
      }
    }
    if (batch.length > 0) await db.batchInsert(batch)

    await this.createCoChangeRelations(repoId, snapshotId)

    timer({ symbol_pairs: symbolPersisted, file_pairs: filePersisted })
    return { symbol_pairs: symbolPersisted, file_pairs: filePersisted }
  }

  /**
   * Compute and persist per-symbol risk scores.
   * Returns the number of risk scores written.
   */
  public async computeRiskScores(
    repoId: string,
    snapshotId: string,
    commits: GitCommit[],
    history: SymbolHistory,
  ): Promise<number> {
    const timer = log.startTimer("computeRiskScores", { repoId, snapshotId, commitCount: commits.length })
    const commitBySha = new Map(commits.map((c) => [c.hash, c]))

    // Commits per symbol: blame where the file was blamed, the file's own
    // commits where it was not. Both counts are in the ingest log.
    const commitsBySymbol = new Map<string, Set<string>>(history.commitsBySymbol)
    for (const commit of commits) {
      if (commit.is_merge) continue
      for (const file of commit.files) {
        if (history.blamedFiles.has(file)) continue
        for (const symbolId of history.symbolsByFile.get(file) ?? []) {
          const set = commitsBySymbol.get(symbolId) ?? new Set<string>()
          set.add(commit.hash)
          commitsBySymbol.set(symbolId, set)
        }
      }
    }
    if (commitsBySymbol.size === 0) {
      log.warn("No symbol has change history — risk scoring skipped", { repoId })
      timer({ scores: 0 })
      return 0
    }

    // Accumulate per-symbol statistics
    const stats = new Map<string, SymbolStats>()
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    for (const [symbolId, shas] of commitsBySymbol) {
      const s: SymbolStats = {
        total_changes: 0,
        bug_fix_count: 0,
        bug_fix_dates: [],
        revert_count: 0,
        regression_count: 0,
        recent_churn_30d: 0,
        authors: new Set<string>(),
        last_change_date: null,
      }
      for (const sha of shas) {
        s.total_changes++
        // Blame can reach past the mined log window; such a change counts,
        // and its author and date are simply unknown.
        const commit = commitBySha.get(sha)
        if (!commit) continue
        s.authors.add(commit.author_email)
        if (commit.is_bug_fix) {
          s.bug_fix_count++
          s.bug_fix_dates.push(commit.date)
        }
        if (commit.is_revert) s.revert_count++
        if (commit.date >= thirtyDaysAgo) s.recent_churn_30d++
        if (!s.last_change_date || commit.date > s.last_change_date) s.last_change_date = commit.date
      }
      stats.set(symbolId, s)
    }

    // Detect regressions: same symbol fixed more than once within REGRESSION_WINDOW_DAYS
    for (const s of stats.values()) {
      s.bug_fix_dates.sort((a, b) => a.getTime() - b.getTime())
      let regressions = 0
      for (let i = 1; i < s.bug_fix_dates.length; i++) {
        const currentDate = s.bug_fix_dates[i]!
        const previousDate = s.bug_fix_dates[i - 1]!
        const daysBetween = (currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24)
        if (daysBetween <= REGRESSION_WINDOW_DAYS) {
          regressions++
        }
      }
      // Also count reverts as regressions
      s.regression_count = regressions + s.revert_count
    }

    // Compute normalized composite risk
    const allStats = Array.from(stats.entries())
    if (allStats.length === 0) {
      timer({ scores: 0 })
      return 0
    }

    // Find max values for normalization
    let maxFreq = 0,
      maxBug = 0,
      maxRegression = 0,
      maxChurn = 0,
      maxAuthors = 0
    for (const [, s] of allStats) {
      if (s.total_changes > maxFreq) maxFreq = s.total_changes
      if (s.bug_fix_count > maxBug) maxBug = s.bug_fix_count
      if (s.regression_count > maxRegression) maxRegression = s.regression_count
      if (s.recent_churn_30d > maxChurn) maxChurn = s.recent_churn_30d
      if (s.authors.size > maxAuthors) maxAuthors = s.authors.size
    }

    const normalize = (value: number, max: number): number => {
      if (max === 0) return 0
      return value / max
    }

    // Persist risk scores
    const now = new Date()
    let batch: { text: string; params: unknown[] }[] = []
    let scored = 0

    for (const [symbolId, s] of allStats) {
      const compositeRisk =
        RISK_WEIGHTS.change_frequency * normalize(s.total_changes, maxFreq) +
        RISK_WEIGHTS.bug_fix_count * normalize(s.bug_fix_count, maxBug) +
        RISK_WEIGHTS.regression_count * normalize(s.regression_count, maxRegression) +
        RISK_WEIGHTS.recent_churn_30d * normalize(s.recent_churn_30d, maxChurn) +
        RISK_WEIGHTS.distinct_authors * normalize(s.authors.size, maxAuthors)

      batch.push({
        text: `INSERT INTO temporal_risk_scores
                    (risk_id, repo_id, symbol_id, snapshot_id,
                     change_frequency, bug_fix_count, regression_count,
                     recent_churn_30d, distinct_authors, composite_risk,
                     last_change_date, computed_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (repo_id, symbol_id, snapshot_id)
                    DO UPDATE SET
                        change_frequency = EXCLUDED.change_frequency,
                        bug_fix_count = EXCLUDED.bug_fix_count,
                        regression_count = EXCLUDED.regression_count,
                        recent_churn_30d = EXCLUDED.recent_churn_30d,
                        distinct_authors = EXCLUDED.distinct_authors,
                        composite_risk = EXCLUDED.composite_risk,
                        last_change_date = EXCLUDED.last_change_date,
                        computed_at = EXCLUDED.computed_at`,
        params: [
          uuidv4(),
          repoId,
          symbolId,
          snapshotId,
          s.total_changes,
          s.bug_fix_count,
          s.regression_count,
          s.recent_churn_30d,
          s.authors.size,
          Math.round(compositeRisk * 10000) / 10000, // 4 decimal places
          s.last_change_date,
          now,
        ],
      })
      scored++

      if (batch.length >= DB_BATCH_SIZE) {
        await db.batchInsert(batch)
        batch = []
      }
    }

    if (batch.length > 0) {
      await db.batchInsert(batch)
    }

    timer({ scores: scored })
    return scored
  }

  /**
   * Get the risk score for a specific symbol in a given snapshot.
   */
  public async getRiskScore(symbolId: string, snapshotId: string): Promise<TemporalRiskScore | null> {
    const result = await db.query(
      `SELECT * FROM temporal_risk_scores
             WHERE symbol_id = $1 AND snapshot_id = $2`,
      [symbolId, snapshotId],
    )
    return (result.rows[0] as TemporalRiskScore | undefined) ?? null
  }

  /**
   * Get co-change partners for a symbol, ordered by Jaccard coefficient.
   */
  public async getCoChangePartners(
    symbolId: string,
    repoId: string,
    minJaccard: number = 0.1,
  ): Promise<CoChangePartner[]> {
    minJaccard = Number.isFinite(minJaccard) ? Math.min(1, Math.max(0, minJaccard)) : 0.1
    const result = await db.query(
      `
            SELECT
                CASE
                    WHEN tcc.symbol_a_id = $1 THEN tcc.symbol_b_id
                    ELSE tcc.symbol_a_id
                END AS symbol_id,
                s.canonical_name,
                tcc.co_change_count,
                tcc.jaccard_coefficient,
                tcc.last_co_change
            FROM temporal_co_changes tcc
            JOIN symbols s ON s.symbol_id = CASE
                WHEN tcc.symbol_a_id = $1 THEN tcc.symbol_b_id
                ELSE tcc.symbol_a_id
            END
            WHERE tcc.repo_id = $2
              AND (tcc.symbol_a_id = $1 OR tcc.symbol_b_id = $1)
              AND tcc.jaccard_coefficient >= $3
            ORDER BY tcc.jaccard_coefficient DESC
            LIMIT 500
        `,
      [symbolId, repoId, minJaccard],
    )

    return result.rows as CoChangePartner[]
  }

  /**
   * Files that change together with the files a symbol lives in. This is
   * the file-granular history, exact but coarse; symbol partners come from
   * getCoChangePartners.
   */
  public async getFileCoChangePartners(
    symbolId: string,
    repoId: string,
    minJaccard: number = 0.1,
  ): Promise<FileCoChangePartner[]> {
    minJaccard = Number.isFinite(minJaccard) ? Math.min(1, Math.max(0, minJaccard)) : 0.1
    const result = await db.query(
      `
            WITH own AS (
                SELECT DISTINCT f.path
                FROM symbol_versions sv
                JOIN files f ON f.file_id = sv.file_id
                WHERE sv.symbol_id = $1
            )
            SELECT own.path AS file,
                   CASE WHEN tfc.file_a = own.path THEN tfc.file_b ELSE tfc.file_a END AS partner,
                   tfc.co_change_count, tfc.jaccard_coefficient, tfc.last_co_change
            FROM own
            JOIN temporal_file_co_changes tfc
              ON tfc.repo_id = $2 AND (tfc.file_a = own.path OR tfc.file_b = own.path)
            WHERE tfc.jaccard_coefficient >= $3
            ORDER BY tfc.jaccard_coefficient DESC
            LIMIT 200
        `,
      [symbolId, repoId, minJaccard],
    )
    return result.rows as FileCoChangePartner[]
  }

  /**
   * Get the top N riskiest symbols for a snapshot.
   */
  public async getTopRisks(
    snapshotId: string,
    limit: number = 20,
  ): Promise<(TemporalRiskScore & { canonical_name: string })[]> {
    limit = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 20
    const result = await db.query(
      `
            SELECT trs.*, s.canonical_name
            FROM temporal_risk_scores trs
            JOIN symbols s ON s.symbol_id = trs.symbol_id
            WHERE trs.snapshot_id = $1
            ORDER BY trs.composite_risk DESC
            LIMIT $2
        `,
      [snapshotId, limit],
    )

    return result.rows as (TemporalRiskScore & { canonical_name: string })[]
  }

  /**
   * Get ownership information for a symbol — who commits to it the most.
   */
  public async getOwnershipProfile(
    repoId: string,
    symbolId: string,
    repoBasePath: string,
  ): Promise<{
    primary_owner: string | null
    ownership_type: "sole" | "shared" | "orphaned"
    contributors: { author: string; commit_count: number; percentage: number }[]
  }> {
    repoBasePath = resolveExistingPath(repoBasePath)
    // Get all file paths associated with this symbol
    const fileResult = await db.query(
      `
            SELECT DISTINCT f.path
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE s.symbol_id = $1 AND s.repo_id = $2
            LIMIT 10
        `,
      [symbolId, repoId],
    )

    const filePaths = (fileResult.rows as { path: string }[]).map((r) => r.path)

    if (filePaths.length === 0) {
      return {
        primary_owner: null,
        ownership_type: "orphaned",
        contributors: [],
      }
    }

    // Mine git log for these specific files
    const authorCounts = new Map<string, number>()
    let totalCommits = 0

    for (const filePath of filePaths) {
      let logOutput: string
      try {
        const result = await execFileAsync(
          "git",
          ["log", "--pretty=format:%ae", "--follow", "--max-count=500", "--", filePath],
          {
            cwd: repoBasePath,
            encoding: "utf-8",
            maxBuffer: 2 * 1024 * 1024,
            timeout: 5_000,
          },
        )
        logOutput = result.stdout
      } catch (err) {
        log.debug("Git log failed for symbol, skipping", {
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }

      if (!logOutput || logOutput.trim().length === 0) continue

      for (const rawLine of logOutput.split("\n")) {
        const email = rawLine.trim()
        if (email.length === 0) continue
        authorCounts.set(email, (authorCounts.get(email) || 0) + 1)
        totalCommits++
      }
    }

    if (totalCommits === 0) {
      return {
        primary_owner: null,
        ownership_type: "orphaned",
        contributors: [],
      }
    }

    // Sort by commit count descending
    const sorted = Array.from(authorCounts.entries())
      .map(([author, count]) => ({
        author,
        commit_count: count,
        percentage: Math.round((count / totalCommits) * 10000) / 100,
      }))
      .sort((a, b) => b.commit_count - a.commit_count)

    const topContributor = sorted[0]
    if (!topContributor) {
      return {
        primary_owner: null,
        ownership_type: "orphaned",
        contributors: [],
      }
    }

    const primaryOwner = topContributor.author
    const topPercentage = topContributor.percentage

    const ownershipType: "sole" | "shared" = sorted.length === 1 || topPercentage >= 80 ? "sole" : "shared"

    return {
      primary_owner: primaryOwner,
      ownership_type: ownershipType,
      contributors: sorted,
    }
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /**
   * Parse raw `git log` output into structured GitCommit objects.
   *
   * Format: each commit starts with a header line matching the
   * --pretty=format pattern, followed by zero or more file paths,
   * followed by a blank line before the next commit.
   */
  private parseGitLog(raw: string): GitCommit[] {
    if (raw.includes("\x1e")) return this.parseNullDelimitedGitLog(raw)

    const commits: GitCommit[] = []
    const lines = raw.split("\n")

    let current: GitCommit | null = null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!

      // Try to parse as a commit header: hash|name|email|date|subject
      // A commit hash is exactly 40 hex characters
      if (line.length > 40 && line[40] === "|") {
        // Flush the previous commit
        if (current) {
          commits.push(current)
        }

        const parts = line.split("|")
        const hash = parts[0]
        const authorName = parts[1]
        const authorEmail = parts[2]
        const dateStr = parts[3]

        if (!hash || !authorName || !authorEmail || !dateStr || parts.length < 5) {
          // Malformed header — skip
          current = null
          continue
        }

        // Subject may contain pipe characters — rejoin remaining parts
        const subject = parts.slice(4).join("|")

        const date = new Date(dateStr)
        if (isNaN(date.getTime())) {
          current = null
          continue
        }

        const isBugFix = BUG_FIX_PATTERNS.some((p) => p.test(subject))
        const isRevert = REVERT_PATTERN.test(subject)
        const isMerge = MERGE_PATTERN.test(subject)

        current = {
          hash,
          author_name: authorName,
          author_email: authorEmail,
          date,
          subject,
          files: [],
          is_bug_fix: isBugFix,
          is_revert: isRevert,
          is_merge: isMerge,
        }
      } else if (current && line.trim().length > 0) {
        // This is a file path line belonging to the current commit
        const filePath = line.trim()
        // Skip binary files and common non-code artifacts
        if (!this.isIgnoredPath(filePath)) {
          current.files.push(filePath)
        }
      }
      // Blank lines are commit separators — do nothing
    }

    // Flush the last commit
    if (current) {
      commits.push(current)
    }

    return commits
  }

  /** Parse the delimiter-safe format emitted by mineGitHistory. */
  private parseNullDelimitedGitLog(raw: string): GitCommit[] {
    const commits: GitCommit[] = []
    for (const record of raw.split("\x1e").slice(1)) {
      const fields = record.split("\0")
      const hash = (fields[0] ?? "").replace(/^[\r\n]+/, "")
      const authorName = fields[1] ?? ""
      const authorEmail = fields[2] ?? ""
      const date = new Date(fields[3] ?? "")
      const subject = fields[4] ?? ""
      if (!/^[0-9a-f]{40}$/i.test(hash) || !authorName || !authorEmail || Number.isNaN(date.getTime())) continue

      const files: string[] = []
      for (const rawPath of fields.slice(5)) {
        // Git may place one formatting newline between the pretty header and
        // the first NUL-delimited name. Do not trim other whitespace: it is
        // legal in a repository path and therefore semantically meaningful.
        const filePath = rawPath.replace(/^\r?\n/, "")
        if (filePath.length > 0 && !this.isIgnoredPath(filePath)) files.push(filePath)
      }

      commits.push({
        hash,
        author_name: authorName,
        author_email: authorEmail,
        date,
        subject,
        files,
        is_bug_fix: BUG_FIX_PATTERNS.some((pattern) => pattern.test(subject)),
        is_revert: REVERT_PATTERN.test(subject),
        is_merge: MERGE_PATTERN.test(subject),
      })
    }
    return commits
  }

  /**
   * Returns true if a file path should be excluded from temporal analysis.
   * Filters out binary files, lock files, generated files, and non-code assets.
   */
  private isIgnoredPath(filePath: string): boolean {
    const lower = filePath.toLowerCase()

    // Binary/media extensions
    const binaryExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".svg",
      ".webp",
      ".bmp",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".otf",
      ".zip",
      ".tar",
      ".gz",
      ".bz2",
      ".7z",
      ".rar",
      ".exe",
      ".dll",
      ".so",
      ".dylib",
      ".bin",
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".mp3",
      ".mp4",
      ".avi",
      ".mov",
      ".wav",
      ".pyc",
      ".pyo",
      ".class",
      ".o",
      ".obj",
    ]

    if (binaryExtensions.some((ext) => lower.endsWith(ext))) {
      return true
    }

    // Lock files and generated artifacts
    const ignoredNames = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "composer.lock",
      "Gemfile.lock",
      "Cargo.lock",
      "poetry.lock",
      "go.sum",
    ]

    const basename = filePath.split("/").pop() || ""
    if (ignoredNames.includes(basename)) {
      return true
    }

    // Generated directories
    const ignoredDirs = ["node_modules/", "dist/", "build/", ".git/", "__pycache__/", ".tox/"]
    if (ignoredDirs.some((dir) => filePath.includes(dir))) {
      return true
    }

    return false
  }

  /**
   * Create co_changed_with inferred_relations for high-Jaccard
   * co-change pairs. Looks up the current symbol_version_ids for
   * the latest complete snapshot, then upserts inferred_relations.
   */
  private async createCoChangeRelations(repoId: string, snapshotId: string): Promise<number> {
    // The pairs were just rewritten; relations from an earlier run of this
    // snapshot would otherwise outlive the history that produced them.
    await db.query(
      `DELETE FROM inferred_relations
        WHERE relation_type = 'co_changed_with' AND valid_from_snapshot_id = $1`,
      [snapshotId],
    )

    // Get high-Jaccard pairs
    const pairsResult = await db.query(
      `
            SELECT symbol_a_id, symbol_b_id, jaccard_coefficient, co_change_count
            FROM temporal_co_changes
            WHERE repo_id = $1
              AND jaccard_coefficient >= $2
              AND co_change_count >= $3
            ORDER BY jaccard_coefficient DESC
        `,
      [repoId, CO_CHANGE_RELATION_JACCARD_THRESHOLD, CO_CHANGE_MIN_COUNT],
    )

    if (pairsResult.rowCount === 0) return 0

    // Build symbol_id -> symbol_version_id map for the snapshot
    const svResult = await db.query(
      `
            SELECT sv.symbol_version_id, sv.symbol_id
            FROM symbol_versions sv
            WHERE sv.snapshot_id = $1
        `,
      [snapshotId],
    )

    const symbolToSv = new Map<string, string>()
    for (const row of svResult.rows as { symbol_version_id: string; symbol_id: string }[]) {
      symbolToSv.set(row.symbol_id, row.symbol_version_id)
    }

    // Reuse the co-change bundle rather than minting one per run. Its scores are
    // a constant tuple and uq_evidence_bundle_scores makes that tuple unique, so
    // a fresh uuid collided on the SCORES while the guard below watched the id:
    // every run after the first threw, the temporal engine was caught as
    // "non-fatal", and co-change relations silently stopped being written.
    const bundleResult = await db.query(
      `
            INSERT INTO evidence_bundles
                (evidence_bundle_id, semantic_score, structural_score,
                 behavioral_score, contract_score, test_score, history_score,
                 contradiction_flags, feature_payload)
            VALUES ($1, 0, 0, 0, 0, 0, 1.0, '{}', '{"source": "temporal_co_change"}')
            ON CONFLICT ON CONSTRAINT uq_evidence_bundle_scores
                DO UPDATE SET feature_payload = evidence_bundles.feature_payload
            RETURNING evidence_bundle_id
        `,
      [uuidv4()],
    )
    const evidenceBundleId = (bundleResult.rows[0] as { evidence_bundle_id: string }).evidence_bundle_id

    let created = 0
    let batch: { text: string; params: unknown[] }[] = []

    for (const row of pairsResult.rows as {
      symbol_a_id: string
      symbol_b_id: string
      jaccard_coefficient: number
      co_change_count: number
    }[]) {
      const svA = symbolToSv.get(row.symbol_a_id)
      const svB = symbolToSv.get(row.symbol_b_id)
      if (!svA || !svB) continue

      // Create bidirectional relations (A->B and B->A)
      const pairs: [string, string][] = [
        [svA, svB],
        [svB, svA],
      ]
      for (const [src, dst] of pairs) {
        batch.push({
          text: `INSERT INTO inferred_relations
                        (inferred_relation_id, src_symbol_version_id, dst_symbol_version_id,
                         relation_type, confidence, review_state, evidence_bundle_id,
                         valid_from_snapshot_id, valid_to_snapshot_id)
                        VALUES ($1, $2, $3, 'co_changed_with', $4, 'unreviewed', $5, $6, NULL)
                        ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
                        DO UPDATE SET
                            confidence = GREATEST(inferred_relations.confidence, EXCLUDED.confidence),
                            evidence_bundle_id = EXCLUDED.evidence_bundle_id`,
          params: [uuidv4(), src, dst, Math.round(row.jaccard_coefficient * 1000) / 1000, evidenceBundleId, snapshotId],
        })
        created++
      }

      if (batch.length >= DB_BATCH_SIZE) {
        await db.batchInsert(batch)
        batch = []
      }
    }

    if (batch.length > 0) {
      await db.batchInsert(batch)
    }

    log.info("Co-change inferred relations created", { repoId, relations: created })
    return created
  }
}

export const temporalEngine = new TemporalEngine()
