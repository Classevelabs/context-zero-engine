/**
 * ContextZero — Search Service
 *
 * Shared business logic for code search (grep across indexed files).
 * Handles regex construction, ReDoS protection, file filtering,
 * and context line extraction.
 * Used by both the REST API and MCP bridge handlers.
 */

import * as fsp from "fs/promises"
import { db } from "../db-driver"
import { coreDataService } from "../db-driver/core_data"
import { resolveExistingPath, resolvePathWithinBase } from "../path-security"
import { UserFacingError } from "../types"

// ────────── Result Types ──────────

export interface SearchMatch {
  file: string
  line: number
  match: string
  context: string
}

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
 * Wall-clock budget for a whole search. Bounds the aggregate cost of a slow
 * (but not provably catastrophic) pattern over thousands of files, so the
 * single-threaded process stays responsive. Checked between files, so it cannot
 * interrupt one pathological line — that is what buildSafeRegex guards.
 */
const SEARCH_DEADLINE_MS = 10_000

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

  const matches: SearchMatch[] = []

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

  // Process files in parallel batches for better throughput
  const BATCH_SIZE = 50
  const deadline = Date.now() + SEARCH_DEADLINE_MS
  let timedOut = false
  for (let batchStart = 0; batchStart < files.length && matches.length < maxResults; batchStart += BATCH_SIZE) {
    if (Date.now() > deadline) {
      timedOut = true
      if (log) {
        log.warn("Search exceeded its time budget — returning partial results", {
          repo_id: repoId,
          pattern,
          mode: searchMode,
          budget_ms: SEARCH_DEADLINE_MS,
          files_scanned: batchStart,
          files_total: files.length,
          matches: matches.length,
        })
      }
      break
    }
    const batchEnd = Math.min(batchStart + BATCH_SIZE, files.length)
    const batch = files.slice(batchStart, batchEnd)

    const batchResults = await Promise.allSettled(
      batch.map(async (filePath) => {
        const fileMatches: SearchMatch[] = []
        try {
          const safePath = resolvePathWithinBase(realBase, filePath)
          const content = await fsp.readFile(safePath.realPath, "utf-8")
          const lines = content.split("\n")

          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i]!)) {
              const ctxStart = Math.max(0, i - contextLines)
              const ctxEnd = Math.min(lines.length - 1, i + contextLines)
              const contextArr: string[] = []
              for (let c = ctxStart; c <= ctxEnd; c++) {
                const prefix = c === i ? ">" : " "
                contextArr.push(`${prefix} ${c + 1}: ${lines[c]}`)
              }
              fileMatches.push({
                file: filePath,
                line: i + 1,
                match: (lines[i] ?? "").trim(),
                context: contextArr.join("\n"),
              })
            }
          }
        } catch (error) {
          if (log) {
            log.debug("Skipping unreadable indexed file during search", {
              repo_id: repoId,
              file_path: filePath,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        return fileMatches
      }),
    )

    // Collect results from this batch, respecting remaining quota
    for (const result of batchResults) {
      if (matches.length >= maxResults) break
      if (result.status === "fulfilled") {
        for (const m of result.value) {
          if (matches.length >= maxResults) break
          matches.push(m)
        }
      }
    }

    // Early termination: if we've hit maxResults, skip remaining batches
    if (matches.length >= maxResults) break
  }

  return {
    pattern,
    mode: searchMode,
    total_matches: matches.length,
    matches,
    ...(timedOut ? { timed_out: true } : {}),
  }
}
