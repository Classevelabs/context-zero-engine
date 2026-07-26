/**
 * ContextZero — Search Scan Core
 *
 * The file-walking, reading and line-matching half of code search, factored out
 * of search-service so it can run in either place:
 *
 *   • inside a worker thread, where a caller-supplied regex that backtracks
 *     catastrophically can be killed outright (see search-worker.ts); or
 *   • inline on the main thread, as the fallback when a worker is unavailable.
 *
 * Nothing here touches the database — the caller resolves the repository and
 * hands over an already-filtered file list.
 */

import * as fsp from "fs/promises"
import { resolvePathWithinBase } from "../path-security"

export interface SearchMatch {
  file: string
  line: number
  match: string
  context: string
}

export interface ScanParams {
  /** Symlink-resolved repository root; every file must resolve inside it. */
  realBase: string
  /** Repo-relative paths to scan, in order. */
  files: string[]
  /** Regex source and flags, passed as data so it survives a worker boundary. */
  patternSource: string
  patternFlags: string
  maxResults: number
  contextLines: number
  /** Wall-clock budget for the whole scan, checked between batches. */
  deadlineMs: number
}

export interface ScanResult {
  matches: SearchMatch[]
  timedOut: boolean
  filesScanned: number
}

/** Files are read and matched this many at a time. */
const BATCH_SIZE = 50

/**
 * Scan `files` for lines matching the pattern.
 *
 * `onUnreadable` is called for files that cannot be read (deleted since
 * indexing, permissions, binary) so the caller can log them; scanning
 * continues regardless.
 */
export async function scanFiles(
  params: ScanParams,
  onUnreadable?: (filePath: string, error: string) => void,
): Promise<ScanResult> {
  const { realBase, files, patternSource, patternFlags, maxResults, contextLines } = params
  const regex = new RegExp(patternSource, patternFlags)
  const matches: SearchMatch[] = []
  const deadline = Date.now() + params.deadlineMs
  let timedOut = false
  let filesScanned = 0

  for (let batchStart = 0; batchStart < files.length && matches.length < maxResults; batchStart += BATCH_SIZE) {
    if (Date.now() > deadline) {
      timedOut = true
      break
    }
    const batch = files.slice(batchStart, Math.min(batchStart + BATCH_SIZE, files.length))

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
          if (onUnreadable) {
            onUnreadable(filePath, error instanceof Error ? error.message : String(error))
          }
        }
        return fileMatches
      }),
    )

    filesScanned += batch.length

    for (const result of batchResults) {
      if (matches.length >= maxResults) break
      if (result.status === "fulfilled") {
        for (const m of result.value) {
          if (matches.length >= maxResults) break
          matches.push(m)
        }
      }
    }

    if (matches.length >= maxResults) break
  }

  return { matches, timedOut, filesScanned }
}
