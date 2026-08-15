import * as fs from "fs"
import * as path from "path"

export interface ResolvedRepoPath {
  realBase: string
  resolvedPath: string
  realPath: string
  existed: boolean
}

/**
 * Reject paths containing characters that can bypass security checks:
 * - Null bytes (\0): truncate paths in C-based functions
 * - URL-encoded sequences that resolve to traversal: %2e, %2f, %5c
 * - Backslashes on POSIX (can confuse cross-platform path resolution)
 */
function assertSafePath(filePath: string): void {
  if (filePath.includes("\0")) {
    throw new Error("Path contains null byte — rejected")
  }
  // Reject URL-encoded path traversal sequences
  const lower = filePath.toLowerCase()
  if (lower.includes("%2e") || lower.includes("%2f") || lower.includes("%5c")) {
    throw new Error("Path contains URL-encoded characters — rejected")
  }
  // On POSIX systems, reject backslashes to prevent cross-platform confusion
  if (process.platform !== "win32" && filePath.includes("\\")) {
    throw new Error("Path contains backslash — rejected on POSIX")
  }
}

export function resolveExistingPath(targetPath: string): string {
  assertSafePath(targetPath)
  return fs.realpathSync(path.resolve(targetPath))
}

function normalizePathForContainment(targetPath: string): string {
  let normalized = path.normalize(targetPath).replace(/\\/g, "/")
  // Trailing separators are stripped by index rather than with /\/+$/, which
  // backtracks quadratically on a long run. normalize() collapses those runs
  // first so it was never reachable, but containment is not the place to keep
  // a sharp edge that only a second reading proves is blunt.
  let end = normalized.length
  while (end > 0 && normalized.charCodeAt(end - 1) === 47) end--
  normalized = normalized.slice(0, end)
  if (normalized.length === 0) normalized = "/"
  if (/^[A-Za-z]:$/.test(normalized)) normalized += "/"
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function isPathWithinBase(realBase: string, candidatePath: string): boolean {
  const base = normalizePathForContainment(realBase)
  const candidate = normalizePathForContainment(candidatePath)
  if (candidate === base) return true
  const baseWithSeparator = base.endsWith("/") ? base : `${base}/`
  return candidate.startsWith(baseWithSeparator)
}

/**
 * Existence test that does NOT follow symlinks.
 *
 * existsSync stats through the link, so a DANGLING symlink reads as absent.
 * The ancestor walk then stepped straight over it, returned the base as the
 * probe, and handed back a path whose link component was never resolved —
 * recreating the target afterwards turns that into a write outside the base.
 */
function pathExistsWithoutFollowing(candidate: string): boolean {
  try {
    fs.lstatSync(candidate)
    return true
  } catch {
    return false
  }
}

function findNearestExistingAncestor(targetPath: string): string {
  let current = targetPath
  for (;;) {
    if (pathExistsWithoutFollowing(current)) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`Path traversal attempt blocked: ${targetPath}`)
    }
    current = parent
  }
}

export function resolvePathWithinBase(
  basePath: string,
  filePath: string,
  options?: { allowMissing?: boolean },
): ResolvedRepoPath {
  assertSafePath(filePath)
  const realBase = resolveExistingPath(basePath)
  const resolvedPath = path.resolve(realBase, filePath)

  if (!isPathWithinBase(realBase, resolvedPath)) {
    throw new Error(`Path traversal attempt blocked: ${filePath}`)
  }

  const probePath = options?.allowMissing ? findNearestExistingAncestor(resolvedPath) : resolvedPath
  const realProbePath = fs.realpathSync(probePath)

  if (!isPathWithinBase(realBase, realProbePath)) {
    throw new Error(`Path traversal attempt blocked: ${filePath} (symlink escape)`)
  }

  const existed = fs.existsSync(resolvedPath)
  const realPath = existed ? fs.realpathSync(resolvedPath) : resolvedPath

  if (!isPathWithinBase(realBase, realPath)) {
    throw new Error(`Path traversal attempt blocked: ${filePath} (symlink escape)`)
  }

  return { realBase, resolvedPath, realPath, existed }
}
