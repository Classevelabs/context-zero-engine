/**
 * Keeping a repository's graph current, automatically.
 *
 * Indexing a codebase is not a one-time operation — the graph is only worth
 * consulting if it describes the code as it is right now. Left to manual
 * re-ingestion, an index is accurate for the few minutes after someone
 * remembers to refresh it and quietly wrong for the rest of the day, which is
 * the failure mode that makes a code graph untrustworthy rather than merely
 * out of date.
 *
 * This watches the registered repositories and folds each change into the
 * existing snapshot as it happens. Edits are batched over a short quiet period
 * rather than indexed per-keystroke, because the cost of a pass is dominated by
 * fixed setup rather than by the number of files in it, and because a save
 * storm — a formatter sweeping a directory, a branch switch — should cost one
 * pass, not hundreds.
 *
 * Two properties matter more than speed here:
 *
 *   One writer per repository. The watcher holds a PostgreSQL advisory lock for
 *   its lifetime, so starting a second one anywhere on the machine is a no-op
 *   rather than two processes racing to re-index the same snapshot.
 *
 *   Refinement settles itself. Fast passes leave repository-wide analyses
 *   (symbol lineage, concept families, dispatch edges, transitive effects, IDF
 *   weighting) progressively staler, and the engine records that debt. The
 *   watcher pays it down during an idle period instead of letting it accumulate
 *   until someone notices — which is the whole difference between an index that
 *   maintains itself and one that merely defers its maintenance.
 */

import * as fs from "fs"
import * as path from "path"
import crypto from "crypto"

import { db } from "../db-driver"
import { Logger } from "../logger"
import { ingestor, LANGUAGE_MAP, SKIP_DIRS } from "../ingestor"
import { resolveLatestIndexedSnapshot, toRepoRelativePaths } from "../incremental-target"
import { watcher as watcherConfig } from "../config"
import type { AdvisoryLock } from "../db-driver"

const log = new Logger("watcher")

/** Distinguishes watcher locks from the ingestion locks in the same namespace. */
const WATCH_LOCK_SALT = "contextzero:watch:"

export interface WatchedRepository {
  repo_id: string
  name: string
  base_path: string
}

export interface WatchBatchSummary {
  repo: string
  files: number
  symbols_updated: number
  relations_updated: number
  files_failed: number
  failed_paths: string[]
}

export interface WatcherOptions {
  /** Quiet period before a batch is indexed. */
  debounceMs?: number
  /** Idle time after which outstanding refinement debt is paid down. */
  refineAfterIdleMs?: number
  /** Called after each indexed batch — for CLI output and tests. */
  onBatch?: (summary: WatchBatchSummary) => void
}

/**
 * True if a path is worth indexing: inside no skipped directory, and carrying an
 * extension the engine has an adapter for.
 *
 * Shares SKIP_DIRS and LANGUAGE_MAP with the ingestor deliberately. A watcher
 * with its own copy drifts the moment either list changes, and the failure is
 * silent — files that ingestion covers stop being watched, or the watcher
 * queues paths ingestion will never parse.
 */
export function isIndexablePath(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]/)
  const fileName = segments[segments.length - 1] ?? ""
  for (const segment of segments.slice(0, -1)) {
    if (!segment || SKIP_DIRS.has(segment) || segment.startsWith(".")) return false
  }
  if (fileName.startsWith(".")) return false
  return LANGUAGE_MAP[path.extname(fileName).toLowerCase()] !== undefined
}

/** One watched repository: its fs.watch handle, pending edits, and timers. */
class RepositoryWatch {
  private readonly pending = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private refineTimer: NodeJS.Timeout | null = null
  private indexing = false
  private closed = false
  private watchHandle: fs.FSWatcher | null = null

  constructor(
    private readonly repo: WatchedRepository,
    private readonly lock: AdvisoryLock,
    private readonly options: Required<Omit<WatcherOptions, "onBatch">> & Pick<WatcherOptions, "onBatch">,
  ) {}

  public start(): void {
    // Recursive fs.watch rather than a polling scan: a repository of any size
    // costs one OS-level subscription instead of a periodic walk over tens of
    // thousands of files, and there is no interval during which a change is
    // invisible. Node supports it on Windows, macOS and Linux from v20.
    this.watchHandle = fs.watch(this.repo.base_path, { recursive: true }, (_event, filename) => {
      if (!filename || this.closed) return
      const relativePath = filename.toString().replace(/\\/g, "/")
      if (!isIndexablePath(relativePath)) return
      this.pending.add(relativePath)
      this.scheduleFlush()
    })

    this.watchHandle.on("error", (err) => {
      log.error("Watch failed for repository", err, { repo: this.repo.name })
    })

    this.scheduleRefine()
    log.info("Watching repository", { repo: this.repo.name, path: this.repo.base_path })
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), this.options.debounceMs)
    this.flushTimer.unref()
  }

  private scheduleRefine(): void {
    if (this.refineTimer) clearTimeout(this.refineTimer)
    if (this.options.refineAfterIdleMs <= 0) return
    this.refineTimer = setTimeout(() => void this.refineIfOwed(), this.options.refineAfterIdleMs)
    this.refineTimer.unref()
  }

  /** Index everything accumulated since the last pass. */
  private async flush(): Promise<void> {
    if (this.closed || this.indexing || this.pending.size === 0) return

    // Take the batch before awaiting anything. Edits that arrive during the pass
    // belong to the next one — leaving them in `pending` would either index them
    // against a snapshot that is mid-update or drop them when the set is cleared.
    const batch = [...this.pending]
    this.pending.clear()
    this.indexing = true

    try {
      const snapshotId = await resolveLatestIndexedSnapshot(this.repo.repo_id)
      if (!snapshotId) {
        log.warn("Skipping batch — repository has no indexed snapshot yet", { repo: this.repo.name })
        return
      }

      const relativePaths = toRepoRelativePaths(this.repo.base_path, batch)
      const result = await ingestor.ingestIncremental(this.repo.repo_id, snapshotId, relativePaths, {
        refine: "deferred",
      })

      if (result.error) {
        // Another pass holds the ingestion lock. These files are genuinely not
        // indexed, so put them back rather than reporting a batch that never ran.
        for (const p of batch) this.pending.add(p)
        this.scheduleFlush()
        log.warn("Batch deferred — ingestion busy, will retry", { repo: this.repo.name, files: batch.length })
        return
      }

      this.options.onBatch?.({
        repo: this.repo.name,
        files: relativePaths.length,
        symbols_updated: result.symbolsUpdated,
        relations_updated: result.relationsUpdated,
        files_failed: result.files_failed,
        failed_paths: result.failed_paths,
      })
    } catch (err) {
      // Never let one bad batch kill the watcher: it is a long-lived process and
      // the next edit must still be indexed.
      log.error("Batch failed", err instanceof Error ? err : new Error(String(err)), { repo: this.repo.name })
    } finally {
      this.indexing = false
      this.scheduleRefine()
      if (this.pending.size > 0) this.scheduleFlush()
    }
  }

  /**
   * Pay down refinement debt once the tree has been quiet.
   *
   * Deliberately idle-triggered rather than on a fixed schedule: a full pass is
   * minutes of work across the whole snapshot, and starting one while somebody
   * is typing competes with the fast passes that keep their edits current.
   */
  private async refineIfOwed(): Promise<void> {
    if (this.closed || this.indexing || this.pending.size > 0) {
      this.scheduleRefine()
      return
    }

    try {
      const owed = await db.query(
        `SELECT snapshot_id FROM snapshots
             WHERE repo_id = $1 AND refinement_pending_since IS NOT NULL
             ORDER BY indexed_at DESC LIMIT 1`,
        [this.repo.repo_id],
      )
      const snapshotId = (owed.rows[0] as { snapshot_id?: string } | undefined)?.snapshot_id
      if (!snapshotId) return

      this.indexing = true
      log.info("Settling refinement debt", { repo: this.repo.name })

      // A full pass needs a path to anchor on; the snapshot's own analyses are
      // what actually get recomputed, so any indexed file serves.
      const anyFile = await db.query(`SELECT path FROM files WHERE snapshot_id = $1 LIMIT 1`, [snapshotId])
      const anchor = (anyFile.rows[0] as { path?: string } | undefined)?.path
      if (!anchor) return

      await ingestor.ingestIncremental(this.repo.repo_id, snapshotId, [anchor], { refine: "full" })
      log.info("Refinement settled", { repo: this.repo.name })
    } catch (err) {
      log.warn("Refinement pass failed (non-fatal)", {
        repo: this.repo.name,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.indexing = false
      this.scheduleRefine()
    }
  }

  public async stop(): Promise<void> {
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.refineTimer) clearTimeout(this.refineTimer)
    this.watchHandle?.close()
    await this.lock.release()
  }
}

/**
 * Watches every registered repository whose files are reachable, and keeps their
 * graphs current until stopped.
 */
export class Watcher {
  private readonly watches: RepositoryWatch[] = []
  private readonly options: Required<Omit<WatcherOptions, "onBatch">> & Pick<WatcherOptions, "onBatch">

  constructor(options: WatcherOptions = {}) {
    this.options = {
      debounceMs: options.debounceMs ?? watcherConfig.debounceMs,
      refineAfterIdleMs: options.refineAfterIdleMs ?? watcherConfig.refineAfterIdleMs,
      onBatch: options.onBatch,
    }
  }

  /** Returns the repositories this process is watching. */
  public async start(): Promise<WatchedRepository[]> {
    const result = await db.query(
      `SELECT repo_id, name, base_path FROM repositories WHERE base_path IS NOT NULL ORDER BY name`,
    )
    const repos = result.rows as WatchedRepository[]
    const started: WatchedRepository[] = []

    for (const repo of repos) {
      if (!fs.existsSync(repo.base_path)) {
        log.warn("Skipping repository — path not present on this machine", {
          repo: repo.name,
          path: repo.base_path,
        })
        continue
      }

      // One writer per repository, enforced across processes rather than within
      // one. Two watchers indexing the same snapshot would each lose half their
      // batches to the other's ingestion lock.
      const lockKey = crypto
        .createHash("md5")
        .update(`${WATCH_LOCK_SALT}${repo.repo_id}`)
        .digest()
        .readInt32BE(0)
      const lock = await db.tryAdvisoryLock(lockKey)
      if (!lock) {
        log.info("Skipping repository — already watched by another process", { repo: repo.name })
        continue
      }

      const watch = new RepositoryWatch(repo, lock, this.options)
      watch.start()
      this.watches.push(watch)
      started.push(repo)
    }

    return started
  }

  public async stop(): Promise<void> {
    await Promise.all(this.watches.map((w) => w.stop()))
    this.watches.length = 0
  }
}
