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
import { buildSafeRegex, literalRegex } from "../regex-safety"

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
  /** True when the repository has more indexed files than a search will scan — results are partial. */
  files_truncated?: boolean
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
const MAX_SEARCH_PATTERN_LENGTH = 2_000
const MAX_FILE_PATTERN_LENGTH = 2_000
const MAX_SEARCH_RESULTS = 100
const MAX_CONTEXT_LINES = 5
/** Files a search will scan. Past this the result says so instead of silently stopping short. */
const MAX_SEARCH_FILES = 10_000

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback
}

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
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    throw UserFacingError.badRequest(`Search pattern must contain 1-${MAX_SEARCH_PATTERN_LENGTH} characters`)
  }
  if (options.filePattern !== undefined &&
      (typeof options.filePattern !== "string" || options.filePattern.length > MAX_FILE_PATTERN_LENGTH)) {
    throw UserFacingError.badRequest(`File pattern must be at most ${MAX_FILE_PATTERN_LENGTH} characters`)
  }
  const maxResults = boundedInteger(options.maxResults, 30, 1, MAX_SEARCH_RESULTS)
  const contextLines = boundedInteger(options.contextLines, 2, 0, MAX_CONTEXT_LINES)

  // Resolve repo base path
  const repo = await coreDataService.getRepository(repoId)
  if (!repo) throw UserFacingError.notFound("Repository")
  const basePath = repo.base_path as string
  if (!basePath) throw UserFacingError.badRequest("Repository base path not configured")

  // The files of the repository's latest indexed snapshot. The union of every
  // snapshot kept a file deleted since the earliest one searchable, and the
  // cap truncated a large repository's list with nothing to say so.
  const filesResult = await db.query(
    `
        SELECT f.path FROM files f
        WHERE f.snapshot_id = (
            SELECT snap.snapshot_id FROM snapshots snap
            WHERE snap.repo_id = $1 AND snap.index_status IN ('complete', 'partial')
            ORDER BY snap.created_at DESC LIMIT 1)
        ORDER BY f.path
        LIMIT $2
    `,
    [repoId, MAX_SEARCH_FILES + 1],
  )
  const filesTruncated = filesResult.rows.length > MAX_SEARCH_FILES
  if (filesTruncated) filesResult.rows.length = MAX_SEARCH_FILES

  let { regex, mode: searchMode } = buildSafeRegex(pattern, log)

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

  if (files.length === 0) {
    return { pattern, mode: searchMode, total_matches: 0, matches: [], ...(filesTruncated ? { files_truncated: true } : {}) }
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
    if (!result) {
      // A worker spawn/load failure must not move a potentially exponential
      // regex back onto the main event loop. Literal degradation is safe and
      // is reported honestly through `mode`.
      regex = literalRegex(pattern)
      searchMode = "literal"
      scanParams.patternSource = regex.source
      scanParams.patternFlags = regex.flags
    }
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
    ...(filesTruncated ? { files_truncated: true } : {}),
  }
}
