/**
 * Resolving "these files changed" into "this repo, this snapshot, these paths".
 *
 * Incremental indexing is the operation that keeps a graph current, but its
 * inputs were expressed in terms the trigger never has. A file watcher, an
 * editor hook, or a CI step knows one thing — an absolute path that just
 * changed. It does not know a repository UUID, it does not track which snapshot
 * is current, and it has no reason to compute repo-relative paths. Every caller
 * therefore had to rediscover all three, and each of those is a silent-failure
 * hazard: a stale snapshot_id re-indexes into a superseded graph and reports
 * success, and an absolute path is rejected outright by the ingestor's
 * repo-relative contract.
 *
 * Both entry points that start an incremental pass — the `scg_incremental_index`
 * MCP tool and the filesystem watcher — resolve through the functions here, so
 * the two cannot drift apart.
 */

import * as path from "path"
import { db } from "./db-driver"
import { toPortableRelativePath } from "./workspace-native"

export interface OwningRepository {
  repo_id: string
  base_path: string
}

/**
 * Find the registered repository that owns `targetPath` — either the repository
 * root itself or any path beneath it.
 *
 * The longest matching `base_path` wins, so a repository nested inside another
 * registered one resolves to the innermost, which is the only answer that keeps
 * its relative paths correct. Comparison is case-insensitive on Windows, where
 * the same directory is reachable under several casings and an exact match would
 * miss.
 */
export async function findRepositoryContainingPath(targetPath: string): Promise<OwningRepository | null> {
  const result = await db.query(`SELECT repo_id, base_path FROM repositories WHERE base_path IS NOT NULL`)

  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[/\\]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  const target = normalize(targetPath)

  let best: OwningRepository | null = null
  let bestLength = -1
  for (const row of result.rows as { repo_id: string; base_path: string }[]) {
    const base = normalize(row.base_path)
    if (target !== base && !target.startsWith(base + path.sep)) continue
    if (base.length > bestLength) {
      bestLength = base.length
      best = { repo_id: row.repo_id, base_path: row.base_path }
    }
  }
  return best
}

/**
 * The snapshot an incremental pass should write into: the repository's most
 * recent snapshot that actually holds a graph.
 *
 * 'partial' qualifies alongside 'complete' on purpose — a partial snapshot is
 * precisely the one that incremental indexing repairs, and excluding it would
 * send the repair at an older snapshot instead. 'pending', 'indexing' and
 * 'failed' are skipped: they have no baseline to update.
 */
export async function resolveLatestIndexedSnapshot(repoId: string): Promise<string | null> {
  const result = await db.query(
    `SELECT snapshot_id FROM snapshots
         WHERE repo_id = $1 AND index_status IN ('complete', 'partial')
         ORDER BY indexed_at DESC LIMIT 1`,
    [repoId],
  )
  const row = result.rows[0] as { snapshot_id?: string } | undefined
  return row?.snapshot_id ?? null
}

/**
 * Convert changed paths — absolute or already relative, in either slash style —
 * into the repo-relative, forward-slash form the ingestor and `files.path` use.
 *
 * Throws on a path outside the repository rather than dropping it. A silently
 * skipped path is the worst outcome available here: the file stays stale in the
 * graph while the run reports success.
 */
export function toRepoRelativePaths(basePath: string, changedPaths: string[]): string[] {
  return changedPaths.map((changedPath) => {
    if (!path.isAbsolute(changedPath) && !path.win32.isAbsolute(changedPath)) {
      return changedPath.replace(/\\/g, "/")
    }
    const relative = path.relative(basePath, changedPath)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`changed path is outside the repository (${basePath}): ${changedPath}`)
    }
    return toPortableRelativePath(relative)
  })
}
