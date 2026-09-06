/**
 * ContextZero — symbol-level change history from git blame.
 *
 * Co-change was computed per file: every symbol in a changed file "changed
 * together" with every other, so a fifty-symbol file produced 1,225 symbol
 * pairs per commit and blast radius listed whole files as historical partners
 * — 28 MB of a 285 MB database, all of it a claim about symbols that the data
 * could not support.
 *
 * A commit's diff hunks cannot be mapped to today's symbol ranges: the lines
 * have moved since. Blame can. For each current line it names the commit that
 * last changed it, exactly, so for each symbol the set of commits that last
 * touched its lines is known, and two symbols co-changed when they share one.
 * The cost is that only the last change to a line is visible; older history
 * stays at file granularity, where it is exact.
 *
 * Security: git is run with an argument array, never a shell, on a path the
 * caller has already resolved inside an allowed base.
 */

import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

/** Lines past which a file is not blamed: the cost grows with the file, the signal does not. */
export const MAX_BLAME_LINES = 20_000

/**
 * Parse `git blame --porcelain` into one commit hash per final line
 * (index 0 = line 1). Each group opens with `<sha> <orig> <final> [<n>]`,
 * followed by header lines on the commit's first appearance and one
 * tab-prefixed content line per source line.
 */
export function parseBlamePorcelain(raw: string): string[] {
  const shas: string[] = []
  let current: string | null = null
  let finalLine = 0
  for (const line of raw.split("\n")) {
    if (line.startsWith("\t")) {
      if (current && finalLine > 0) shas[finalLine - 1] = current
      continue
    }
    const header = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/)
    if (header) {
      current = header[1]!
      finalLine = Number(header[3])
    }
  }
  return shas
}

/**
 * Blame one file. Null when the file cannot be blamed — untracked, binary,
 * past the size bound, or git absent — which the caller counts and reports.
 */
export async function blameFile(repoPath: string, relativePath: string, timeoutMs: number): Promise<string[] | null> {
  try {
    const result = await execFileAsync("git", ["blame", "--porcelain", "--", relativePath], {
      cwd: repoPath,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    })
    const shas = parseBlamePorcelain(result.stdout)
    return shas.length > MAX_BLAME_LINES ? null : shas
  } catch {
    return null
  }
}

export interface SymbolRange {
  symbol_id: string
  range_start_line: number
  range_end_line: number
}

/** Blame's hash for a line that is not committed yet. */
const UNCOMMITTED_SHA = "0".repeat(40)

/**
 * The commits that last touched each symbol's lines. A line the working
 * tree changed since the last commit belongs to no commit yet and is left
 * out: counting it as one would pair every symbol edited today with every
 * other, and score an unsaved edit as churn.
 */
export function commitsPerSymbol(shas: string[], symbols: SymbolRange[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    const start = Math.max(1, symbol.range_start_line)
    const end = Math.min(shas.length, symbol.range_end_line)
    const commits = result.get(symbol.symbol_id) ?? new Set<string>()
    for (let line = start; line <= end; line++) {
      const sha = shas[line - 1]
      if (sha && sha !== UNCOMMITTED_SHA) commits.add(sha)
    }
    if (commits.size > 0) result.set(symbol.symbol_id, commits)
  }
  return result
}

/**
 * Run `work` over `items` with at most `concurrency` in flight and stop
 * starting new work once `budgetMs` has elapsed; a zero budget starts
 * nothing. Returns how many completed and how many were never started.
 */
export async function withinBudget<T>(
  items: T[],
  concurrency: number,
  budgetMs: number,
  work: (item: T) => Promise<void>,
): Promise<{ completed: number; skipped: number }> {
  const started = Date.now()
  let next = 0
  let completed = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() - started >= budgetMs) return
      const index = next++
      if (index >= items.length) return
      await work(items[index]!)
      completed++
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  return { completed, skipped: items.length - completed }
}

/** What blame knows about a snapshot's symbols. */
export interface SymbolHistory {
  /** The commits that last touched each symbol's lines, by symbol id. */
  commitsBySymbol: Map<string, Set<string>>
  /** Files whose lines were attributed; symbols in other files carry file-level history only. */
  blamedFiles: Set<string>
  /** Symbol ids per file path, for the file-level fallback. */
  symbolsByFile: Map<string, string[]>
  filesSkipped: number
}
