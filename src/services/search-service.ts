/**
 * ContextZero — Search Service
 *
 * Shared business logic for code search (grep across indexed files).
 * Handles regex construction, ReDoS protection, file filtering,
 * and context line extraction.
 * Used by both the REST API and MCP bridge handlers.
 */

import * as fs from "fs"
import * as path from "path"
import { Worker } from "worker_threads"
import { db } from "../db-driver"
import { coreDataService } from "../db-driver/core_data"
import { resolveExistingPath } from "../path-security"
import { UserFacingError } from "../types"
import { scanFiles, type ScanParams, type ScanResult, type SearchMatch } from "./search-scan"
import type { WorkerMessage } from "./search-worker"

// ────────── Result Types ──────────

export type { SearchMatch }

export interface SearchCodeResult {
  pattern: string
  /** 'regex' = pattern compiled as regex; 'literal' = fell back to escaped literal search (e.g. ReDoS-suspect input). */
  mode: "regex" | "literal"
  total_matches: number
  matches: SearchMatch[]
  /** True when the scan stopped early on the time budget — results are partial. */
  timed_out?: boolean
}

/**
 * Wall-clock budget for a whole search.
 *
 * In the worker path this is enforced by terminating the thread, so it is a
 * hard bound even mid-match. In the inline fallback it is checked between
 * batches, which bounds aggregate cost but cannot interrupt one pathological
 * line — there, buildSafeRegex is the load-bearing guard.
 */
const SEARCH_DEADLINE_MS = 10_000

/** Grace period for the worker to exit on its own before it is terminated. */
const WORKER_KILL_GRACE_MS = 250

export interface SearchCodeOptions {
  filePattern?: string
  maxResults?: number
  contextLines?: number
}

// ────────── Logger Interface ──────────

interface MinimalLogger {
  debug(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

// ────────── ReDoS Protection ──────────

/**
 * Detect patterns with catastrophic-backtracking potential.
 *
 * The whole classic family is "a quantified group whose body can match the same
 * input more than one way" — i.e. a group carrying +/*\/{n,} that contains
 * either an alternation or another quantifier. That covers (a+)+, (a*)*,
 * (a|aa)+, (a|a?)+, (\w|\w\w)+ and friends.
 *
 * The previous pattern-pair only caught an inner quantifier written directly
 * inside a flat group, so overlapping-alternation forms went straight through:
 * `(a|aa)+$` took ~900ms against a 30-character line, and `(a|a?)+$` never
 * returned at all. Node has no regex timeout and the engine is single-threaded,
 * so one such search hangs the whole process across every indexed file.
 *
 * This over-approximates: a non-overlapping pattern like `(foo|bar)+` is also
 * flagged. That is deliberate — the fallback is an escaped literal search, which
 * still returns useful results, and callers are told via the `mode` field.
 * Detecting genuine overlap needs full regex analysis; refusing to backtrack on
 * anything of this shape is the honest trade.
 *
 * Residual risk: this is a static heuristic, not a proof. A guaranteed bound
 * needs the match to run off-thread with a hard kill. SEARCH_DEADLINE_MS below
 * caps the aggregate damage in the meantime.
 */
function hasQuantifiedComplexGroup(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++ // skip the escaped character
      continue
    }
    if (pattern[i] !== "(") continue

    // Walk to this group's matching ')', tracking escapes, nesting and classes.
    let depth = 0
    let inClass = false
    let bodyHasAlternation = false
    let bodyHasQuantifier = false
    let end = -1
    for (let j = i; j < pattern.length; j++) {
      const ch = pattern[j]
      if (ch === "\\") {
        j++
        continue
      }
      if (inClass) {
        if (ch === "]") inClass = false
        continue
      }
      if (ch === "[") {
        inClass = true
        continue
      }
      if (ch === "(") {
        depth++
        continue
      }
      if (ch === ")") {
        depth--
        if (depth === 0) {
          end = j
          break
        }
        continue
      }
      if (depth === 1) {
        if (ch === "|") bodyHasAlternation = true
        if (ch === "+" || ch === "*" || ch === "?" || ch === "{") bodyHasQuantifier = true
      } else if (depth > 1) {
        // A nested group is itself a way for the body to match ambiguously.
        bodyHasQuantifier = true
      }
    }
    if (end === -1) continue // unbalanced — new RegExp() will reject it anyway

    const next = pattern[end + 1]
    const groupIsQuantified = next === "+" || next === "*" || next === "{"
    if (groupIsQuantified && (bodyHasAlternation || bodyHasQuantifier)) {
      return true
    }
  }
  return false
}

function buildSafeRegex(pattern: string, log?: MinimalLogger): { regex: RegExp; mode: "regex" | "literal" } {
  const useRegex = !hasQuantifiedComplexGroup(pattern)
  try {
    if (!useRegex) throw new Error("ReDoS-suspect pattern")
    return { regex: new RegExp(pattern, "gi"), mode: "regex" }
  } catch (error) {
    if (log) {
      log.debug("Falling back to literal search pattern", {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return {
      regex: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      mode: "literal",
    }
  }
}

// ────────── Bounded Execution ──────────

/**
 * A pattern with no quantifier, alternation or backreference cannot backtrack,
 * so it runs in time linear in the input and needs no containment. Skipping the
 * worker for these keeps plain substring searches — the common case — free of
 * thread-startup cost.
 */
function canBacktrack(patternSource: string): boolean {
  return /[+*?{}|()]|\\\d/.test(patternSource)
}

/**
 * Absolute path to the compiled worker, or null when it is not present.
 *
 * Worker threads can only load JavaScript. Under ts-node and jest the sibling
 * file is `search-worker.ts`, so there is nothing to spawn and the caller falls
 * back to the inline scan. In a built install (`dist/`) the `.js` is there and
 * the hard bound is active — which is the configuration that actually ships.
 */
function resolveWorkerPath(): string | null {
  const candidate = path.join(__dirname, "search-worker.js")
  return fs.existsSync(candidate) ? candidate : null
}

/**
 * Run a scan in a worker thread and kill it if it overruns the budget.
 *
 * Returns null when no worker could be started, so the caller can fall back.
 */
async function scanInWorker(params: ScanParams, log?: MinimalLogger): Promise<ScanResult | null> {
  const workerPath = resolveWorkerPath()
  if (!workerPath) return null

  let worker: Worker
  try {
    worker = new Worker(workerPath, { workerData: params })
  } catch (error) {
    if (log) {
      log.warn("Could not start the search worker — falling back to an inline scan", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return null
  }

  return new Promise<ScanResult | null>((resolve) => {
    let settled = false
    const finish = (value: ScanResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      void worker.terminate()
      resolve(value)
    }

    // The hard bound. A regex that backtracks catastrophically never yields to
    // the event loop, so nothing inside the worker can stop it — terminating
    // the thread is the only guaranteed way out.
    const killTimer = setTimeout(() => {
      if (settled) return
      if (log) {
        log.warn("Search worker exceeded its budget — terminating", {
          budget_ms: params.deadlineMs,
          files_total: params.files.length,
        })
      }
      settled = true
      void worker.terminate()
      resolve({ matches: [], timedOut: true, filesScanned: 0 })
    }, params.deadlineMs + WORKER_KILL_GRACE_MS)
    if (typeof killTimer.unref === "function") killTimer.unref()

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.type === "error") {
        if (log) log.warn("Search worker reported an error", { error: msg.message })
        finish(null)
        return
      }
      finish({ matches: msg.matches, timedOut: msg.timedOut, filesScanned: msg.filesScanned })
    })

    worker.on("error", (error: Error) => {
      if (log) {
        log.warn("Search worker failed — falling back to an inline scan", { error: error.message })
      }
      finish(null)
    })

    worker.on("exit", () => {
      // Exited without a message and without an error: treat as no result so
      // the caller retries inline rather than silently reporting zero matches.
      finish(null)
    })
  })
}

// ────────── Service Function ──────────

/**
 * Search across indexed files in a repository using regex or literal matching.
 * Returns matching lines with surrounding context.
 */
export async function searchCode(
  repoId: string,
  pattern: string,
  options: SearchCodeOptions = {},
  log?: MinimalLogger,
): Promise<SearchCodeResult> {
  const maxResults = options.maxResults ?? 30
  const contextLines = options.contextLines ?? 2

  // Resolve repo base path
  const repo = await coreDataService.getRepository(repoId)
  if (!repo) throw UserFacingError.notFound("Repository")
  const basePath = repo.base_path as string
  if (!basePath) throw UserFacingError.badRequest("Repository base path not configured")

  // Get indexed files
  const filesResult = await db.query(
    `
        SELECT DISTINCT f.path FROM files f
        JOIN snapshots snap ON snap.snapshot_id = f.snapshot_id
        WHERE snap.repo_id = $1 ORDER BY f.path
        LIMIT 10000
    `,
    [repoId],
  )

  const { regex, mode: searchMode } = buildSafeRegex(pattern, log)

  // Resolve base symlinks once before the loop
  let realBase: string
  try {
    realBase = resolveExistingPath(basePath)
  } catch (error) {
    if (log) {
      log.warn("Repository base path not accessible", {
        repo_id: repoId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw UserFacingError.badRequest("Repository base path not accessible")
  }

  // Pre-filter files by pattern before any I/O.
  // Separator-agnostic on both sides: snapshots ingested on Windows before the
  // portable-path fix stored backslash paths, and callers pass either style —
  // a mismatch used to return 0 results with no hint why.
  let files = (filesResult.rows as { path: string }[]).map((r) => r.path)
  if (options.filePattern) {
    const pat = options.filePattern.toLowerCase().replace(/\\/g, "/")
    files = files.filter((fp) => {
      const lower = fp.toLowerCase().replace(/\\/g, "/")
      return lower.includes(pat) || lower.endsWith(pat)
    })
  }

  const scanParams: ScanParams = {
    realBase,
    files,
    patternSource: regex.source,
    patternFlags: regex.flags,
    maxResults,
    contextLines,
    deadlineMs: SEARCH_DEADLINE_MS,
  }

  // Only a pattern that can backtrack needs containment; anything else is
  // linear and not worth a thread. When the worker is unavailable (ts-node,
  // jest, or a spawn failure) fall back to scanning inline — buildSafeRegex
  // has already rejected the known catastrophic shapes.
  let result: ScanResult | null = null
  if (canBacktrack(regex.source)) {
    result = await scanInWorker(scanParams, log)
  }
  if (!result) {
    result = await scanFiles(scanParams, (filePath, error) => {
      if (log) {
        log.debug("Skipping unreadable indexed file during search", {
          repo_id: repoId,
          file_path: filePath,
          error,
        })
      }
    })
  }

  const matches = result.matches
  const timedOut = result.timedOut
  if (timedOut && log) {
    log.warn("Search exceeded its time budget — returning partial results", {
      repo_id: repoId,
      pattern,
      mode: searchMode,
      budget_ms: SEARCH_DEADLINE_MS,
      files_scanned: result.filesScanned,
      files_total: files.length,
      matches: matches.length,
    })
  }

  return {
    pattern,
    mode: searchMode,
    total_matches: matches.length,
    matches,
    ...(timedOut ? { timed_out: true } : {}),
  }
}
