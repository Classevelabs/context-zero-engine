/**
 * ContextZero — Transactional Change Engine
 *
 * 9-state lifecycle for managing code changes with full validation.
 * State machine:
 *   planned → prepared → patched → reindexed → validated →
 *   propagation_pending → committed | rolled_back | failed
 *
 * 6-level progressive validation:
 *   1. Syntax check (per-file parse)
 *   2. Type check (tsc --noEmit / mypy)
 *   3. Contract delta (before/after contract comparison)
 *   4. Behavioral delta (before/after purity/resource comparison)
 *   5. Invariant check (re-verify affected invariants)
 *   6. Test execution (run affected test suites)
 *
 * Uses sandbox.ts for all subprocess execution (no raw execSync).
 */

import * as fsp from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"
import { db } from "../db-driver"
import { v4 as uuidv4 } from "uuid"
import { Logger } from "../logger"
import { sandboxExec, sandboxTypeCheck, sandboxRunTests, resolveNodeCli } from "./sandbox"
import { behavioralEngine } from "../analysis-engine/behavioral"
import { contractEngine } from "../analysis-engine/contracts"
import { ingestor } from "../ingestor"
import {
  firstRow,
  optionalStringField,
  parseCountField,
  requireFirstRow,
  requireStringField,
} from "../db-driver/result"
import { resolvePathWithinBase } from "../path-security"
import type { PoolClient } from "pg"
import { UserFacingError } from "../types"
import type {
  TransactionState,
  PatchSet,
  ValidationReport,
  ValidationMode,
  PropagationCandidate,
  ChangeTransaction,
  TransactionRecoverySummary,
} from "../types"

const log = new Logger("transactional-editor")
const RECOVERABLE_STATES: TransactionState[] = [
  "prepared",
  "patched",
  "reindexed",
  "validated",
  "propagation_pending",
  "failed",
]
const DEFAULT_STALE_TRANSACTION_MS = readPositiveIntEnv("SCG_STALE_TRANSACTION_MS", 6 * 60 * 60 * 1000)
const DEFAULT_RECOVERY_BATCH_SIZE = readPositiveIntEnv("SCG_STALE_TRANSACTION_BATCH_SIZE", 100)

/** Maximum file size allowed for backup during applyPatch (5 MB) */
const MAX_BACKUP_FILE_SIZE = 5 * 1024 * 1024
const MAX_PATCH_TOTAL_BYTES = 20 * 1024 * 1024
const FILE_TRANSACTION_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PATCH_COUNT = 100

interface FileBackup {
  file_path: string
  original_content: string | null
  original_mode: number | null
}

interface PreparedPatch {
  filePath: string
  fullPath: string
  newContent: string
  originalContent: string | null
  originalMode: number
}

class PatchConflictError extends Error {}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

interface ValidationSymbolPair {
  base_symbol_version_id: string
  validation_symbol_version_id: string | null
  symbol_id: string
  canonical_name: string
}

/** Valid state transitions */
const VALID_TRANSITIONS: Record<TransactionState, TransactionState[]> = {
  planned: ["prepared", "failed", "rolled_back"],
  prepared: ["patched", "failed", "rolled_back"],
  patched: ["reindexed", "failed", "rolled_back"],
  reindexed: ["validated", "failed", "rolled_back"],
  validated: ["propagation_pending", "committed", "failed", "rolled_back"],
  propagation_pending: ["committed", "failed", "rolled_back"],
  committed: [],
  rolled_back: [],
  failed: ["rolled_back"],
}

export class TransactionalChangeEngine {
  /**
   * Create a new change transaction.
   */
  public async createTransaction(
    repoId: string,
    baseSnapshotId: string,
    createdBy: string,
    targetSymbolVersionIds: string[],
  ): Promise<string> {
    const txnId = uuidv4()
    const timer = log.startTimer("createTransaction", { txnId, repoId })

    await db.query(
      `
            INSERT INTO change_transactions (
                txn_id, repo_id, base_snapshot_id, created_by,
                state, target_symbol_versions, patches
            ) VALUES ($1, $2, $3, $4, 'planned', $5, '[]'::jsonb)
        `,
      [txnId, repoId, baseSnapshotId, createdBy, targetSymbolVersionIds],
    )

    timer()
    return txnId
  }

  /**
   * Resolve the repository base path from the DB for a given transaction.
   */
  private async getRepoBasePath(txnId: string): Promise<string> {
    const result = await db.query(
      `SELECT r.base_path FROM change_transactions ct
             JOIN repositories r ON r.repo_id = ct.repo_id
             WHERE ct.txn_id = $1`,
      [txnId],
    )
    const basePath = optionalStringField(firstRow(result), "base_path")
    if (!basePath) {
      throw new Error(`Repository base path not configured for transaction: ${txnId}`)
    }
    return basePath
  }

  /**
   * Apply a patch to the transaction.
   *
   * State machine flow: planned → prepared (backup done) → patched (files written).
   * Only callable from 'planned' state. If any step fails, transaction
   * rolls back to 'planned' (backup) or 'prepared' (write failure).
   */
  public async applyPatch(txnId: string, patches: PatchSet, repoBasePath?: string): Promise<void> {
    const timer = log.startTimer("applyPatch", { txnId, patchCount: patches.length })
    const txn = await this.loadTransaction(txnId)
    if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`)

    // applyPatch is only valid from 'planned' state — ensures idempotency
    if (txn.state !== "planned") {
      throw UserFacingError.badRequest(`applyPatch requires transaction in 'planned' state, got '${txn.state}'`)
    }

    // Resolve base path from DB if not provided
    const basePath = repoBasePath || (await this.getRepoBasePath(txnId))
    const prepared = await this.preparePatches(basePath, patches)
    const lockOrder = [...new Set(prepared.map((patch) => patch.fullPath))].sort()

    // Phase 1: Backup original files to database (planned → prepared)
    // Wrapped in a DB transaction with advisory locks for concurrent file isolation.
    // Advisory locks are automatically released on COMMIT/ROLLBACK.
    await db.transaction(async (client: PoolClient) => {
      const locked = await db.queryWithClient(
        client,
        `SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
        [txnId],
      )
      const row = firstRow(locked)
      if (!row) throw UserFacingError.notFound(`Transaction ${txnId}`)
      const state = requireStringField(row, "state", `Transaction ${txnId}`) as TransactionState
      if (state !== "planned") {
        throw UserFacingError.badRequest(`applyPatch requires transaction in 'planned' state, got '${state}'`)
      }

      await this.acquireFileLocks(client, lockOrder)
      await this.extendFilesystemTransactionTimeout(client)

      for (const patch of prepared) {
        const original = await this.readFileSnapshot(patch.fullPath, patch.filePath)
        await db.queryWithClient(
          client,
          `
                    INSERT INTO transaction_file_backups
                        (backup_id, txn_id, file_path, original_content, original_mode)
                    VALUES ($1, $2, $3, $4, $5)
                `,
          [uuidv4(), txnId, patch.filePath, original.content, original.mode],
        )
        patch.originalContent = original.content
        patch.originalMode = original.mode
      }

      // Transition state inside the transaction
      const preparedUpdate = await db.queryWithClient(
        client,
        `UPDATE change_transactions SET state = $1, patches = $3, updated_at = NOW()
         WHERE txn_id = $2 AND state = 'planned'`,
        ["prepared", txnId, JSON.stringify(patches)],
      )
      if (preparedUpdate.rowCount !== 1) throw new Error(`Transaction ${txnId} changed state during backup`)
    })
    log.info("Transaction state changed", { txnId, newState: "prepared" })

    // Phase 2: Write patched files (prepared → patched)
    // Stage every file first. Each rename is atomic, while a multi-file batch
    // uses compensating restores because filesystems have no atomic rename-all.
    let conflictError: PatchConflictError | null = null
    try {
      await db.transaction(async (client: PoolClient) => {
        const locked = await db.queryWithClient(
          client,
          `SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
          [txnId],
        )
        const row = firstRow(locked)
        if (!row) throw UserFacingError.notFound(`Transaction ${txnId}`)
        const state = requireStringField(row, "state", `Transaction ${txnId}`) as TransactionState
        if (state !== "prepared") {
          throw UserFacingError.badRequest(`applyPatch requires transaction in 'prepared' state, got '${state}'`)
        }

        await this.acquireFileLocks(client, lockOrder)
        await this.extendFilesystemTransactionTimeout(client)
        for (const patch of prepared) {
          const current = await this.readOriginalFile(patch.fullPath, patch.filePath)
          if (current !== patch.originalContent) {
            const abandoned = await db.queryWithClient(
              client,
              `UPDATE change_transactions SET state = 'rolled_back', updated_at = NOW()
               WHERE txn_id = $1 AND state = 'prepared'`,
              [txnId],
            )
            if (abandoned.rowCount !== 1) throw new Error(`Transaction ${txnId} changed state during conflict cleanup`)
            await db.queryWithClient(client, `DELETE FROM transaction_file_backups WHERE txn_id = $1`, [txnId])
            conflictError = new PatchConflictError(
              `Patch conflict: ${patch.filePath} changed after it was backed up`,
            )
            return
          }
        }

        const staged = new Map<string, string>()
        const landed: PreparedPatch[] = []
        try {
          for (const patch of prepared) {
            await this.ensureSafeParent(basePath, patch.filePath, patch.fullPath)
            staged.set(
              patch.fullPath,
              await this.stageFile(txnId, patch.fullPath, patch.newContent, patch.originalMode),
            )
          }

          for (const patch of prepared) {
            await this.ensureSafeParent(basePath, patch.filePath, patch.fullPath)
            const tmpPath = staged.get(patch.fullPath)
            if (!tmpPath) throw new Error(`Missing staged file for ${patch.filePath}`)
            await fsp.rename(tmpPath, patch.fullPath)
            staged.delete(patch.fullPath)
            landed.push(patch)
          }

          const updated = await db.queryWithClient(
            client,
            `UPDATE change_transactions
             SET patches = $1, state = 'patched', updated_at = NOW()
             WHERE txn_id = $2 AND state = 'prepared'`,
            [JSON.stringify(patches), txnId],
          )
          if (updated.rowCount !== 1) {
            throw new Error(`Transaction ${txnId} changed state while applying patches`)
          }
        } catch (writeErr) {
          await this.cleanupTempFiles(staged.values())
          const restorationErrors = await this.restoreLandedFiles(basePath, txnId, landed)
          if (restorationErrors.length > 0) {
            log.error("Patch compensation incomplete; durable backups were preserved", writeErr, {
              txnId,
              failedFiles: restorationErrors,
            })
          }
          throw writeErr
        }
      })
      if (conflictError) throw conflictError
    } catch (writeErr) {
      // Clean up any remaining temp files before failing
      log.error("Phase 2 file write failed; preserving safe transaction state", writeErr, { txnId })
      try {
        if (!(writeErr instanceof PatchConflictError)) {
          await this.transitionState(txnId, "failed")
        }
      } catch (stateErr) {
        log.error("Could not mark failed patch transaction; backups remain recoverable", stateErr, { txnId })
      }
      throw writeErr
    }

    // Store patches and advance to 'patched'
    log.info("Transaction state changed", { txnId, newState: "patched" })
    timer()
  }

  /**
   * Run 6-level progressive validation.
   */
  public async validate(
    txnId: string,
    repoBasePath: string,
    mode: ValidationMode = "standard",
  ): Promise<ValidationReport> {
    const timer = log.startTimer("validate", { txnId, mode })
    const txn = await this.loadTransaction(txnId)
    if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`)

    // Must be at least patched to validate
    if (!["patched", "reindexed"].includes(txn.state)) {
      throw UserFacingError.badRequest(`Cannot validate transaction in state: ${txn.state}`)
    }

    const levels: ValidationReport["levels"] = []
    let allPassed = true

    // Level 1: Syntax check
    const syntaxResult = await this.runSyntaxCheck(repoBasePath, txn.patches as PatchSet)
    levels.push({
      level: 1,
      name: "syntax_check",
      passed: syntaxResult.passed,
      details: syntaxResult.details,
      failures: syntaxResult.failures,
    })
    if (!syntaxResult.passed) allPassed = false

    // Level 2: Type check
    if (allPassed || mode === "strict") {
      const typeResult = await this.runTypeCheck(repoBasePath)
      levels.push({
        level: 2,
        name: "type_check",
        passed: typeResult.passed,
        details: typeResult.details,
        failures: typeResult.failures,
      })
      if (!typeResult.passed) allPassed = false
    }

    let validationSnapshotId: string | undefined
    let validationPairs: ValidationSymbolPair[] = []

    if ((allPassed || mode === "strict") && mode !== "quick") {
      validationSnapshotId = await this.ensureValidationSnapshot(txn, repoBasePath)
      validationPairs = await this.loadValidationSymbolPairs(txn, validationSnapshotId)
    }

    if (txn.state === "patched") {
      await this.transitionState(txnId, "reindexed")
    }

    // Level 3: Contract delta (standard + strict)
    if ((allPassed || mode === "strict") && mode !== "quick") {
      const contractResult = await this.runContractDelta(validationPairs)
      levels.push({
        level: 3,
        name: "contract_delta",
        passed: contractResult.passed,
        details: contractResult.details,
        failures: contractResult.failures,
      })
      if (!contractResult.passed) allPassed = false
    }

    // Level 4: Behavioral delta (standard + strict)
    if ((allPassed || mode === "strict") && mode !== "quick") {
      const behaviorResult = await this.runBehavioralDelta(validationPairs)
      levels.push({
        level: 4,
        name: "behavioral_delta",
        passed: behaviorResult.passed,
        details: behaviorResult.details,
        failures: behaviorResult.failures,
      })
      if (!behaviorResult.passed) allPassed = false
    }

    // Level 5: Invariant check (standard + strict; non-blocking in standard)
    if ((allPassed || mode === "strict") && mode !== "quick") {
      const invariantResult = await this.runInvariantCheck(validationPairs)
      levels.push({
        level: 5,
        name: "invariant_check",
        passed: invariantResult.passed,
        details: invariantResult.details,
        failures: invariantResult.failures,
      })
      if (!invariantResult.passed) {
        if (mode === "strict") {
          allPassed = false
        } else {
          log.warn("Invariant check failed (non-blocking in standard mode)", {
            failures: invariantResult.failures,
          })
        }
      }
    }

    // Level 6: Test execution (standard + strict)
    if ((allPassed || mode === "strict") && mode !== "quick") {
      const testResult = await this.runTestExecution(repoBasePath, validationPairs)
      levels.push({
        level: 6,
        name: "test_execution",
        passed: testResult.passed,
        details: testResult.details,
        failures: testResult.failures,
      })
      if (!testResult.passed) allPassed = false
    }

    await this.transitionState(txnId, allPassed ? "validated" : "failed")

    const report: ValidationReport = {
      transaction_id: txnId,
      mode,
      overall_passed: allPassed,
      levels,
      executed_at: new Date(),
      validation_snapshot_id: validationSnapshotId,
    }

    // Store report reference
    await db.query(
      `
            UPDATE change_transactions
            SET validation_report_ref = $1, updated_at = NOW()
            WHERE txn_id = $2
        `,
      [JSON.stringify(report), txnId],
    )

    timer({ passed: allPassed, levels_run: levels.length })
    return report
  }

  /**
   * Commit a validated transaction.
   *
   * Uses a single DB transaction with FOR UPDATE to prevent double-commit
   * race conditions and ensure atomic state transition + backup deletion.
   */
  public async commit(txnId: string): Promise<void> {
    await db.transaction(async (client: PoolClient) => {
      // Lock the transaction row to prevent concurrent commit/rollback
      const lockResult = await db.queryWithClient(
        client,
        `SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
        [txnId],
      )
      const row = firstRow(lockResult)
      if (!row) throw UserFacingError.notFound(`Transaction ${txnId}`)
      const currentState = requireStringField(row, "state", `Transaction ${txnId}`) as TransactionState
      this.assertTransition(currentState, "committed")

      // Atomic: transition state AND delete backups in one transaction
      await db.queryWithClient(
        client,
        `UPDATE change_transactions SET state = 'committed', updated_at = NOW() WHERE txn_id = $1`,
        [txnId],
      )
      await db.queryWithClient(client, `DELETE FROM transaction_file_backups WHERE txn_id = $1`, [txnId])
    })
    log.info("Transaction committed", { txnId })
  }

  /**
   * Rollback a transaction — restore original files.
   * Validates state transition BEFORE performing any file restoration
   * to prevent corrupting committed transactions.
   */
  public async rollback(txnId: string): Promise<void> {
    const timer = log.startTimer("rollback", { txnId })
    const txn = await this.loadTransaction(txnId)
    if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`)

    // CRITICAL: Validate state transition BEFORE any file operations.
    // Without this check, rollback on a 'committed' transaction would restore
    // files before discovering the state transition is invalid.
    const allowedTargets = VALID_TRANSITIONS[txn.state] ?? []
    if (!allowedTargets.includes("rolled_back") && !allowedTargets.includes("failed")) {
      throw UserFacingError.badRequest(
        `Cannot rollback transaction in state '${txn.state}' — only non-terminal states can be rolled back`,
      )
    }

    // Resolve repo base path for path validation during rollback
    // CRITICAL: if we cannot resolve the base path, we MUST abort the rollback entirely.
    // Silently skipping file restoration while deleting backups causes irreversible data loss.
    let realBase: string
    try {
      const repoBasePath = await this.getRepoBasePath(txnId)
      realBase = await fsp.realpath(path.resolve(repoBasePath))
    } catch (err) {
      log.error("Cannot resolve repo base path for rollback — aborting to preserve backup data", err, { txnId })
      throw new Error(
        `Rollback aborted: cannot resolve repository base path for transaction ${txnId}. Backup data is preserved — retry after fixing the repository path.`,
      )
    }

    // Restore file backups from database
    await db.transaction(async (client: PoolClient) => {
      const locked = await db.queryWithClient(
        client,
        `SELECT state, patches FROM change_transactions WHERE txn_id = $1 FOR UPDATE`,
        [txnId],
      )
      const lockedRow = firstRow(locked)
      if (!lockedRow) throw UserFacingError.notFound(`Transaction ${txnId}`)
      const lockedState = requireStringField(lockedRow, "state", `Transaction ${txnId}`) as TransactionState
      const storedPatches = Array.isArray(lockedRow["patches"])
        ? (lockedRow["patches"] as Array<{ file_path?: unknown; new_content?: unknown }>)
        : []
      const desiredContent = new Map<string, string>()
      for (const patch of storedPatches) {
        if (typeof patch.file_path === "string" && typeof patch.new_content === "string") {
          desiredContent.set(patch.file_path, patch.new_content)
        }
      }
      const lockedTargets = VALID_TRANSITIONS[lockedState] ?? []
      if (!lockedTargets.includes("rolled_back")) {
        throw UserFacingError.badRequest(
          `Cannot rollback transaction in state '${lockedState}' â€” only non-terminal states can be rolled back`,
        )
      }

      const backupResult = await db.queryWithClient(
        client,
        `SELECT file_path, original_content, original_mode
         FROM transaction_file_backups WHERE txn_id = $1 ORDER BY file_path`,
        [txnId],
      )
      const backups = backupResult.rows as FileBackup[]
      const resolvedBackups = backups.map((backup) => ({
        backup,
        fullPath: this.resolveBackupPath(realBase, backup.file_path),
      }))
      await this.acquireFileLocks(
        client,
        [...new Set(resolvedBackups.map((entry) => entry.fullPath))].sort(),
      )
      await this.extendFilesystemTransactionTimeout(client)

      const failedFiles: string[] = []

      for (const { backup, fullPath: lockedBackupPath } of resolvedBackups) {
        try {
          const backupPath = path.isAbsolute(backup.file_path)
            ? path.relative(realBase, backup.file_path)
            : backup.file_path
          const safePath = resolvePathWithinBase(realBase, backupPath, { allowMissing: true })
          const resolvedBackupPath = safePath.existed ? safePath.realPath : safePath.resolvedPath
          if (!this.pathsEqual(resolvedBackupPath, lockedBackupPath)) {
            throw new Error(`Rollback path changed during validation: ${backup.file_path}`)
          }
          await this.cleanupTransactionTempFiles(txnId, resolvedBackupPath)
          const desired = desiredContent.get(backup.file_path)
          if (desired !== undefined) {
            const current = await this.readOriginalFile(resolvedBackupPath, backup.file_path)
            if (current !== backup.original_content && current !== desired) {
              throw new Error(`Rollback conflict: ${backup.file_path} was modified outside this transaction`)
            }
          }

          if (backup.original_content === null) {
            await this.ensureResolvedPathUnchanged(realBase, backupPath, resolvedBackupPath)
            // File was newly created — remove it
            try {
              await fsp.access(resolvedBackupPath)
              await fsp.unlink(resolvedBackupPath)
            } catch (err) {
              if (!this.isMissingPathError(err)) throw err
              // File already absent — nothing to remove
            }
          } else {
            await this.ensureSafeParent(realBase, backupPath, resolvedBackupPath)
            await this.atomicWriteFile(txnId, resolvedBackupPath, backup.original_content, backup.original_mode ?? 0o600)
          }
        } catch (err) {
          log.error("Failed to restore backup", err, { filePath: backup.file_path })
          failedFiles.push(backup.file_path)
        }
      }

      // Any restoration failure aborts the DB transaction and retains every backup.
      if (failedFiles.length > 0) {
        log.error("Rollback incomplete: failed to restore files", null, {
          txnId,
          failedCount: failedFiles.length,
          failedFiles,
        })
        throw new Error(`Rollback incomplete: failed to restore ${failedFiles.length} file(s)`)
      }

      const updated = await db.queryWithClient(
        client,
        `UPDATE change_transactions SET state = 'rolled_back', updated_at = NOW()
         WHERE txn_id = $1 AND state = $2`,
        [txnId, lockedState],
      )
      if (updated.rowCount !== 1) throw new Error(`Transaction ${txnId} changed state during rollback`)
      await db.queryWithClient(client, `DELETE FROM transaction_file_backups WHERE txn_id = $1`, [txnId])
    })
    log.info("Transaction rolled back", { txnId })
    timer()
  }

  /**
   * Recover stale non-terminal transactions left behind by crashes or interrupted runs.
   * Rolls them back when possible, and defensively removes lingering backups for
   * already-terminal transactions.
   */
  public async recoverStaleTransactions(
    olderThanMs: number = DEFAULT_STALE_TRANSACTION_MS,
    limit: number = DEFAULT_RECOVERY_BATCH_SIZE,
  ): Promise<TransactionRecoverySummary> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) {
      throw new RangeError("olderThanMs must be a positive safe integer")
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new RangeError("limit must be a positive safe integer no greater than 10000")
    }
    const timer = log.startTimer("recoverStaleTransactions", { olderThanMs, limit })
    const cutoff = new Date(Date.now() - olderThanMs)
    const staleResult = await db.query(
      `SELECT ct.txn_id, ct.state, COUNT(tfb.backup_id) AS backup_count
             FROM change_transactions ct
             LEFT JOIN transaction_file_backups tfb ON tfb.txn_id = ct.txn_id
             WHERE ct.state = ANY($1::text[])
               AND ct.updated_at < $2
             GROUP BY ct.txn_id, ct.state, ct.updated_at
             ORDER BY ct.updated_at ASC
             LIMIT $3`,
      [RECOVERABLE_STATES, cutoff.toISOString(), limit],
    )

    let recovered = 0
    let recoveryFailed = 0

    for (const row of staleResult.rows as Array<{
      txn_id: string
      state: TransactionState
      backup_count: string | number
    }>) {
      const backupCount = parseCountField(row as Record<string, unknown>, "backup_count")
      try {
        if (backupCount === 0 && row.state === "failed") {
          await this.transitionState(row.txn_id, "rolled_back")
        } else {
          await this.rollback(row.txn_id)
        }
        recovered++
      } catch (error) {
        // Another recovery worker may have won the row lock and completed the
        // same transaction. Treat that terminal state as recovered, not as an
        // operational failure.
        let completedElsewhere = false
        try {
          const current = await this.loadTransaction(row.txn_id)
          completedElsewhere = current !== null && ["committed", "rolled_back"].includes(current.state)
        } catch (reloadError) {
          log.error("Failed to re-check transaction after recovery error", reloadError, { txnId: row.txn_id })
        }
        if (completedElsewhere) {
          recovered++
          continue
        }
        recoveryFailed++
        log.error("Failed to recover stale transaction", error, {
          txnId: row.txn_id,
          state: row.state,
          backup_count: backupCount,
        })
      }
    }

    const cleanupResult = await db.query(
      `DELETE FROM transaction_file_backups tfb
             USING change_transactions ct
             WHERE tfb.txn_id = ct.txn_id
               AND ct.state IN ('committed', 'rolled_back')
             RETURNING tfb.backup_id`,
    )

    const summary: TransactionRecoverySummary = {
      scanned: staleResult.rows.length,
      recovered,
      recovery_failed: recoveryFailed,
      cleaned_terminal_backups: cleanupResult.rowCount ?? 0,
    }

    timer({ ...summary })
    return summary
  }

  /**
   * Get transaction state.
   */
  public async getTransaction(txnId: string): Promise<ChangeTransaction | null> {
    return this.loadTransaction(txnId)
  }

  /**
   * Compute propagation proposals for homologs of changed symbols.
   */
  public async computePropagationProposals(txnId: string, _snapshotId: string): Promise<PropagationCandidate[]> {
    const txn = await this.loadTransaction(txnId)
    if (!txn) throw UserFacingError.notFound(`Transaction ${txnId}`)

    const proposals: PropagationCandidate[] = []

    for (const svId of txn.target_symbol_versions) {
      // Find homologs via inferred_relations
      const result = await db.query(
        `
                SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                       s.canonical_name, eb.contradiction_flags
                FROM inferred_relations ir
                JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                JOIN evidence_bundles eb ON eb.evidence_bundle_id = ir.evidence_bundle_id
                WHERE ir.src_symbol_version_id = $1
                AND ir.confidence >= 0.70
                AND ir.review_state != 'rejected'
            `,
        [svId],
      )

      for (const row of result.rows as {
        dst_symbol_version_id: string
        relation_type: string
        confidence: number
        canonical_name: string
        contradiction_flags: string[]
      }[]) {
        const hasContradictions = Array.isArray(row.contradiction_flags) && row.contradiction_flags.length > 0
        proposals.push({
          homolog_symbol_id: row.dst_symbol_version_id,
          homolog_name: row.canonical_name,
          relation_type: row.relation_type as PropagationCandidate["relation_type"],
          confidence: row.confidence,
          is_safe: !hasContradictions && row.confidence >= 0.85,
          patch_proposal: null,
          risk_notes: hasContradictions
            ? [`Contradictions detected: ${(row.contradiction_flags || []).join(", ")}`]
            : [],
        })
      }
    }

    // Store propagation report
    if (proposals.length > 0 && txn.state === "validated") {
      await this.transitionState(txnId, "propagation_pending")
      await db.query(
        `
                UPDATE change_transactions
                SET propagation_report_ref = $1, updated_at = NOW()
                WHERE txn_id = $2
            `,
        [JSON.stringify(proposals), txnId],
      )
    }

    return proposals
  }

  // ────────── Validation Level Implementations ──────────

  private async runSyntaxCheck(
    repoBasePath: string,
    patches: PatchSet,
  ): Promise<{ passed: boolean; details: string; failures: string[] }> {
    const failures: string[] = []

    for (const patch of patches) {
      if (patch.file_path.endsWith(".ts") || patch.file_path.endsWith(".tsx")) {
        const fullPath = this.resolveSafePath(repoBasePath, patch.file_path)
        const tscJs = resolveNodeCli("typescript/lib/tsc.js", repoBasePath)
        if (!tscJs) {
          failures.push(`${patch.file_path}: TypeScript compiler not found for syntax check`)
          continue
        }
        const result = await sandboxExec(process.execPath, [tscJs, "--noEmit", "--allowJs", fullPath], {
          cwd: repoBasePath,
          timeoutMs: 30_000,
          maxOutputBytes: 256_000,
        })
        if (result.exitCode !== 0) {
          const output = this.captureDiagnostics(result.stdout, result.stderr)
          failures.push(`${patch.file_path}: ${output.substring(0, 500)}`)
        }
      } else if (patch.file_path.endsWith(".py")) {
        const fullPath = this.resolveSafePath(repoBasePath, patch.file_path)
        const result = await sandboxExec(process.platform === "win32" ? "python" : "python3", ["-m", "py_compile", fullPath], {
          cwd: repoBasePath,
          timeoutMs: 15_000,
          maxOutputBytes: 64_000,
        })
        if (result.exitCode !== 0) {
          const output = this.captureDiagnostics(result.stdout, result.stderr)
          failures.push(`${patch.file_path}: ${output.substring(0, 500)}`)
        }
      }
    }

    return {
      passed: failures.length === 0,
      details: failures.length === 0 ? "All patched files pass syntax check" : `${failures.length} syntax errors`,
      failures,
    }
  }

  private async runTypeCheck(repoBasePath: string): Promise<{ passed: boolean; details: string; failures: string[] }> {
    const result = await sandboxTypeCheck(repoBasePath)
    const combinedOutput = this.captureDiagnostics(result.stdout, result.stderr)
    const failures =
      result.exitCode !== 0
        ? combinedOutput
            .split("\n")
            .filter((l) => l.includes("error TS"))
            .slice(0, 20)
        : []

    return {
      passed: result.exitCode === 0,
      details: result.exitCode === 0 ? "Type check passed" : `Type check failed (exit ${result.exitCode})`,
      failures,
    }
  }

  private async runContractDelta(
    validationPairs: ValidationSymbolPair[],
  ): Promise<{ passed: boolean; details: string; failures: string[] }> {
    const failures: string[] = []

    for (const pair of validationPairs) {
      const validationSymbolVersionId = this.requireValidationSymbol(pair, failures)
      if (!validationSymbolVersionId) continue

      // Load before/after contract profiles
      const before = await contractEngine.getProfile(pair.base_symbol_version_id)
      const after = await contractEngine.getProfile(validationSymbolVersionId)
      if (!before || !after) {
        failures.push(`Contract profiles unavailable for ${pair.canonical_name}`)
        continue
      }

      // Compare contracts using the real engine
      const delta = contractEngine.compareContracts(before, after)

      if (delta.outputChanged) {
        failures.push(
          `Output contract changed for ${pair.canonical_name}: '${before.output_contract}' → '${after.output_contract}'`,
        )
      }
      if (delta.errorChanged) {
        failures.push(
          `Error contract changed for ${pair.canonical_name}: '${before.error_contract}' → '${after.error_contract}'`,
        )
      }
      if (delta.securityChanged) {
        failures.push(
          `Security contract changed for ${pair.canonical_name}: '${before.security_contract}' → '${after.security_contract}'`,
        )
      }
      if (delta.inputChanged) {
        failures.push(
          `Input contract changed for ${pair.canonical_name}: '${before.input_contract}' → '${after.input_contract}'`,
        )
      }
    }

    return {
      passed: failures.length === 0,
      details:
        failures.length === 0 ? "No contract violations detected" : `${failures.length} contract regressions detected`,
      failures,
    }
  }

  private async runBehavioralDelta(
    validationPairs: ValidationSymbolPair[],
  ): Promise<{ passed: boolean; details: string; failures: string[] }> {
    const failures: string[] = []

    for (const pair of validationPairs) {
      const validationSymbolVersionId = this.requireValidationSymbol(pair, failures)
      if (!validationSymbolVersionId) continue

      // Load before/after behavioral profiles
      const before = await behavioralEngine.getProfile(pair.base_symbol_version_id)
      const after = await behavioralEngine.getProfile(validationSymbolVersionId)
      if (!before || !after) {
        failures.push(`Behavioral profiles unavailable for ${pair.canonical_name}`)
        continue
      }

      // Compare behavior using the real engine
      const delta = behavioralEngine.compareBehavior(before, after)

      if (delta.purityDirection === "escalated") {
        failures.push(`Purity escalated for ${pair.canonical_name}: '${before.purity_class}' → '${after.purity_class}'`)
      }
      if (delta.newResourceTouches.length > 0) {
        failures.push(`New resource touches for ${pair.canonical_name}: ${delta.newResourceTouches.join(", ")}`)
      }
      if (delta.sideEffectsChanged) {
        failures.push(`Side effects changed for ${pair.canonical_name}`)
      }
    }

    return {
      passed: failures.length === 0,
      details:
        failures.length === 0 ? "No behavioral regressions" : `${failures.length} behavioral regressions detected`,
      failures,
    }
  }

  private async runInvariantCheck(
    validationPairs: ValidationSymbolPair[],
  ): Promise<{ passed: boolean; details: string; failures: string[] }> {
    const failures: string[] = []

    // Check invariants scoped to affected symbols
    for (const pair of validationPairs) {
      const validationSymbolVersionId = this.requireValidationSymbol(pair, failures)
      if (!validationSymbolVersionId) continue
      const result = await db.query(
        `
                SELECT i.expression, i.strength, i.source_type
                FROM invariants i
                JOIN symbol_versions sv ON sv.symbol_id = i.scope_symbol_id
                WHERE sv.symbol_version_id = $1
                AND i.strength >= 0.80
            `,
        [validationSymbolVersionId],
      )

      for (const row of result.rows as { expression: string; strength: number; source_type: string }[]) {
        if (row.strength >= 0.9) {
          failures.push(`High-strength invariant needs re-verification for ${pair.canonical_name}: ${row.expression}`)
        }
      }
    }

    return {
      passed: failures.length === 0,
      details: failures.length === 0 ? "All invariants verified" : `${failures.length} invariants need re-verification`,
      failures,
    }
  }

  private async runTestExecution(
    repoBasePath: string,
    validationPairs: ValidationSymbolPair[],
  ): Promise<{ passed: boolean; details: string; failures: string[] }> {
    // Find test files related to changed symbols
    const testPaths: string[] = []
    const failures: string[] = []

    for (const pair of validationPairs) {
      const validationSymbolVersionId = this.requireValidationSymbol(pair, failures)
      if (!validationSymbolVersionId) continue
      const result = await db.query(
        `
                SELECT DISTINCT f.path
                FROM test_artifacts ta
                JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
                JOIN files f ON f.file_id = sv.file_id
                WHERE $1 = ANY(ta.related_symbols)
            `,
        [validationSymbolVersionId],
      )

      for (const row of result.rows as { path: string }[]) {
        if (!testPaths.includes(row.path)) {
          testPaths.push(row.path)
        }
      }
    }

    if (testPaths.length === 0) {
      return {
        passed: failures.length === 0,
        details:
          failures.length === 0
            ? "No test files found for affected symbols"
            : "Unable to map all affected symbols into the validation snapshot",
        failures,
      }
    }

    const result = await sandboxRunTests(repoBasePath, testPaths)
    const combinedOutput = this.captureDiagnostics(result.stdout, result.stderr)
    if (result.exitCode !== 0) {
      failures.push(
        ...combinedOutput
          .split("\n")
          .filter((l) => /FAIL|Error|✕|×/.test(l))
          .slice(0, 20),
      )
    }

    return {
      passed: result.exitCode === 0 && failures.length === 0,
      details:
        result.exitCode === 0 ? `${testPaths.length} test files passed` : `Tests failed (exit ${result.exitCode})`,
      failures,
    }
  }

  // ────────── Helpers ──────────

  private captureDiagnostics(stdout: string, stderr: string): string {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    return output || "No diagnostics captured"
  }

  private buildValidationCommitSha(txn: ChangeTransaction): string {
    const hash = crypto
      .createHash("sha256")
      .update(`${txn.txn_id}:${JSON.stringify(txn.patches)}:${Date.now()}`)
      .digest("hex")
      .slice(0, 24)
    return `txnval-${txn.txn_id.slice(0, 8)}-${hash}`
  }

  private async ensureValidationSnapshot(txn: ChangeTransaction, repoBasePath: string): Promise<string> {
    const existingSnapshotId = txn.validation_report_ref?.validation_snapshot_id
    if (existingSnapshotId) {
      const existing = await db.query(
        `SELECT snapshot_id, index_status FROM snapshots WHERE snapshot_id = $1 AND repo_id = $2`,
        [existingSnapshotId, txn.repo_id],
      )
      const row = firstRow(existing)
      const snapshotId = optionalStringField(row, "snapshot_id")
      if (snapshotId && optionalStringField(row, "index_status") === "complete") {
        return snapshotId
      }
    }

    const repoResult = await db.query(`SELECT name, default_branch FROM repositories WHERE repo_id = $1`, [txn.repo_id])
    const repoRow = requireFirstRow(repoResult, `Repository not found for transaction: ${txn.txn_id}`)
    const repoName = requireStringField(repoRow, "name", `Repository not found for transaction: ${txn.txn_id}`)
    const defaultBranch = optionalStringField(repoRow, "default_branch")

    const snapshotResult = await db.query(`SELECT branch FROM snapshots WHERE snapshot_id = $1`, [txn.base_snapshot_id])
    const branch = optionalStringField(firstRow(snapshotResult), "branch") || defaultBranch || "main"

    const ingestionResult = await ingestor.ingestRepo(
      repoBasePath,
      repoName,
      this.buildValidationCommitSha(txn),
      branch,
      txn.base_snapshot_id,
    )

    if (!ingestionResult.snapshot_id) {
      throw new Error(`Validation snapshot ingestion failed for transaction: ${txn.txn_id}`)
    }

    // Verify the snapshot completed successfully — a partial snapshot would
    // produce incomplete validation results (false negatives).
    const statusResult = await db.query(`SELECT index_status FROM snapshots WHERE snapshot_id = $1`, [
      ingestionResult.snapshot_id,
    ])
    const status = optionalStringField(firstRow(statusResult), "index_status")
    if (status !== "complete") {
      throw new Error(
        `Validation snapshot is ${status ?? "unknown"} (not complete) for transaction: ${txn.txn_id}. ` +
          `Re-ingestion may be required.`,
      )
    }

    return ingestionResult.snapshot_id
  }

  private async loadValidationSymbolPairs(
    txn: ChangeTransaction,
    validationSnapshotId: string,
  ): Promise<ValidationSymbolPair[]> {
    const result = await db.query(
      `
            SELECT base.symbol_version_id AS base_symbol_version_id,
                   current.symbol_version_id AS validation_symbol_version_id,
                   base.symbol_id,
                   s.canonical_name
            FROM symbol_versions base
            JOIN symbols s ON s.symbol_id = base.symbol_id
            LEFT JOIN symbol_versions current
                ON current.symbol_id = base.symbol_id
               AND current.snapshot_id = $2
            WHERE base.symbol_version_id = ANY($1::uuid[])
        `,
      [txn.target_symbol_versions, validationSnapshotId],
    )

    const pairs = result.rows as ValidationSymbolPair[]
    const seen = new Set(pairs.map((pair) => pair.base_symbol_version_id))
    const failures = txn.target_symbol_versions
      .filter((svId) => !seen.has(svId))
      .map((svId) => `Target symbol missing from base snapshot: ${svId}`)

    if (failures.length > 0) {
      throw new Error(`Validation snapshot mapping failed: ${failures.join("; ")}`)
    }

    return pairs
  }

  private requireValidationSymbol(pair: ValidationSymbolPair, failures: string[]): string | null {
    if (!pair.validation_symbol_version_id) {
      failures.push(
        `Validation snapshot missing target symbol: ${pair.canonical_name} (${pair.base_symbol_version_id})`,
      )
      return null
    }
    return pair.validation_symbol_version_id
  }

  private async loadTransaction(txnId: string): Promise<ChangeTransaction | null> {
    const result = await db.query(
      `SELECT txn_id, repo_id, base_snapshot_id, created_by, state,
                    target_symbol_versions, patches, impact_report_ref,
                    validation_report_ref, propagation_report_ref,
                    created_at, updated_at
             FROM change_transactions WHERE txn_id = $1`,
      [txnId],
    )
    return (result.rows[0] as ChangeTransaction | undefined) ?? null
  }

  private assertTransition(currentState: TransactionState, targetState: TransactionState): void {
    const valid = VALID_TRANSITIONS[currentState]
    if (!valid || !valid.includes(targetState)) {
      throw new Error(
        `Invalid state transition: ${currentState} → ${targetState}. ` +
          `Valid transitions: ${valid?.join(", ") || "none"}`,
      )
    }
  }

  private async preparePatches(basePath: string, patches: PatchSet): Promise<PreparedPatch[]> {
    if (!Array.isArray(patches) || patches.length === 0) {
      throw UserFacingError.badRequest("patches must be a non-empty array")
    }
    if (patches.length > MAX_PATCH_COUNT) {
      throw UserFacingError.badRequest(`patches must contain at most ${MAX_PATCH_COUNT} entries`)
    }

    const seen = new Set<string>()
    const prepared: PreparedPatch[] = []
    let totalBytes = 0
    for (let index = 0; index < patches.length; index++) {
      const patch = patches[index]
      if (!patch || typeof patch.file_path !== "string" || patch.file_path.length === 0) {
        throw UserFacingError.badRequest(`patches[${index}].file_path must be a non-empty string`)
      }
      if (patch.file_path.length > 4096) {
        throw UserFacingError.badRequest(`patches[${index}].file_path exceeds 4096 characters`)
      }
      if (typeof patch.new_content !== "string") {
        throw UserFacingError.badRequest(`patches[${index}].new_content must be a string`)
      }
      const contentBytes = Buffer.byteLength(patch.new_content, "utf8")
      if (contentBytes > MAX_BACKUP_FILE_SIZE) {
        throw UserFacingError.badRequest(`patches[${index}].new_content exceeds the 5 MB byte limit`)
      }
      totalBytes += contentBytes
      if (totalBytes > MAX_PATCH_TOTAL_BYTES) {
        throw UserFacingError.badRequest("combined patch content exceeds the 20 MB byte limit")
      }

      const fullPath = this.resolveSafePath(basePath, patch.file_path)
      const dedupeKey = process.platform === "win32" ? fullPath.toLowerCase() : fullPath
      if (seen.has(dedupeKey)) {
        throw UserFacingError.badRequest(`Duplicate patch target: ${patch.file_path}`)
      }
      seen.add(dedupeKey)
      prepared.push({
        filePath: patch.file_path,
        fullPath,
        newContent: patch.new_content,
        originalContent: null,
        originalMode: 0o600,
      })
    }
    return prepared
  }

  private async acquireFileLocks(client: PoolClient, fullPaths: string[]): Promise<void> {
    const canonicalPaths = fullPaths.map((fullPath) =>
      process.platform === "win32" ? path.normalize(fullPath).toLowerCase() : path.normalize(fullPath),
    )
    for (const fullPath of [...new Set(canonicalPaths)].sort()) {
      const digest = crypto.createHash("sha256").update(fullPath).digest()
      await db.queryWithClient(client, "SELECT pg_advisory_xact_lock($1, $2)", [
        digest.readInt32BE(0),
        digest.readInt32BE(4),
      ])
    }
  }

  private async extendFilesystemTransactionTimeout(client: PoolClient): Promise<void> {
    await db.queryWithClient(client, "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
      String(FILE_TRANSACTION_IDLE_TIMEOUT_MS),
    ])
  }

  private async readOriginalFile(fullPath: string, displayPath: string): Promise<string | null> {
    return (await this.readFileSnapshot(fullPath, displayPath)).content
  }

  private async readFileSnapshot(
    fullPath: string,
    displayPath: string,
  ): Promise<{ content: string | null; mode: number }> {
    let fileStat
    try {
      fileStat = await fsp.stat(fullPath)
    } catch (err) {
      if (this.isMissingPathError(err)) return { content: null, mode: 0o600 }
      throw err
    }
    if (!fileStat.isFile()) {
      throw new Error(`Patch target is not a regular file: ${displayPath}`)
    }
    if (fileStat.size > MAX_BACKUP_FILE_SIZE) {
      throw new Error(`File too large for backup: ${displayPath}`)
    }
    return { content: await fsp.readFile(fullPath, "utf-8"), mode: fileStat.mode & 0o777 }
  }

  private async ensureSafeParent(basePath: string, filePath: string, expectedFullPath: string): Promise<void> {
    // Validate before creating anything. Then create one component at a time
    // (never recursive mkdir) and realpath-check each component immediately.
    // This is the strongest portable Node design available without dirfd/openat2.
    await this.ensureResolvedPathUnchanged(basePath, filePath, expectedFullPath)
    const base = resolvePathWithinBase(basePath, ".", { allowMissing: false }).realBase
    const parent = path.dirname(expectedFullPath)
    const relativeParent = path.relative(base, parent)
    if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
      throw new Error(`Patch parent escapes repository: ${filePath}`)
    }

    let current = base
    for (const component of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, component)
      try {
        await fsp.mkdir(current)
      } catch (err) {
        if (!this.isAlreadyExistsError(err)) throw err
      }
      const verified = resolvePathWithinBase(base, path.relative(base, current), { allowMissing: false })
      if (!this.pathsEqual(verified.realPath, current)) {
        throw new Error(`Patch parent path changed during validation: ${filePath}`)
      }
    }
    await this.ensureResolvedPathUnchanged(basePath, filePath, expectedFullPath)
  }

  private async ensureResolvedPathUnchanged(
    basePath: string,
    filePath: string,
    expectedFullPath: string,
  ): Promise<void> {
    const resolved = resolvePathWithinBase(basePath, filePath, { allowMissing: true })
    const currentFullPath = resolved.existed ? resolved.realPath : resolved.resolvedPath
    if (!this.pathsEqual(currentFullPath, expectedFullPath)) {
      throw new Error(`Patch path changed during validation: ${filePath}`)
    }
  }

  private async stageFile(txnId: string, fullPath: string, content: string, mode: number = 0o600): Promise<string> {
    const tmpPath = path.join(path.dirname(fullPath), `.${path.basename(fullPath)}.scg-${txnId}-${uuidv4()}.tmp`)
    const safeMode = Number.isInteger(mode) && mode >= 0 && mode <= 0o777 ? mode : 0o600
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
    try {
      handle = await fsp.open(tmpPath, "wx", safeMode)
      await handle.writeFile(content, { encoding: "utf-8" })
      await handle.sync()
      await handle.close()
      handle = null
      return tmpPath
    } catch (err) {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // Preserve the original staging error.
        }
      }
      try {
        await fsp.unlink(tmpPath)
      } catch (cleanupErr) {
        if (!this.isMissingPathError(cleanupErr)) {
          log.error("Failed to clean up staged patch file", cleanupErr, { tmpPath })
        }
      }
      throw err
    }
  }

  private async cleanupTempFiles(paths: Iterable<string>): Promise<void> {
    for (const tmpPath of paths) {
      try {
        await fsp.unlink(tmpPath)
      } catch (err) {
        if (!this.isMissingPathError(err)) {
          log.error("Failed to clean up staged patch file", err, { tmpPath })
        }
      }
    }
  }

  private async cleanupTransactionTempFiles(txnId: string, fullPath: string): Promise<void> {
    const directory = path.dirname(fullPath)
    const prefix = `.${path.basename(fullPath)}.scg-${txnId}-`
    let names: string[]
    try {
      names = await fsp.readdir(directory)
    } catch (err) {
      if (this.isMissingPathError(err)) return
      throw err
    }
    const tempPaths = names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
      .map((name) => path.join(directory, name))
    await this.cleanupTempFiles(tempPaths)
  }

  private async restoreLandedFiles(
    basePath: string,
    txnId: string,
    landed: PreparedPatch[],
  ): Promise<string[]> {
    const failures: string[] = []
    for (const patch of [...landed].reverse()) {
      try {
        const current = await this.readOriginalFile(patch.fullPath, patch.filePath)
        if (current !== patch.newContent) {
          throw new Error(`Refusing to overwrite an externally modified file during compensation: ${patch.filePath}`)
        }
        if (patch.originalContent === null) {
          try {
            await fsp.unlink(patch.fullPath)
          } catch (err) {
            if (!this.isMissingPathError(err)) throw err
          }
        } else {
          await this.ensureSafeParent(basePath, patch.filePath, patch.fullPath)
          await this.atomicWriteFile(txnId, patch.fullPath, patch.originalContent, patch.originalMode)
        }
      } catch (err) {
        failures.push(patch.filePath)
        log.error("Failed to compensate landed patch", err, { filePath: patch.filePath })
      }
    }
    return failures
  }

  private resolveBackupPath(realBase: string, filePath: string): string {
    const backupPath = path.isAbsolute(filePath) ? path.relative(realBase, filePath) : filePath
    const safePath = resolvePathWithinBase(realBase, backupPath, { allowMissing: true })
    return safePath.existed ? safePath.realPath : safePath.resolvedPath
  }

  private async atomicWriteFile(txnId: string, fullPath: string, content: string, mode: number = 0o600): Promise<void> {
    const tmpPath = await this.stageFile(txnId, fullPath, content, mode)
    try {
      await fsp.rename(tmpPath, fullPath)
    } catch (err) {
      await this.cleanupTempFiles([tmpPath])
      throw err
    }
  }

  private pathsEqual(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left)
    const normalizedRight = path.normalize(right)
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight
  }

  private isMissingPathError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
  }

  private async transitionState(txnId: string, newState: TransactionState): Promise<void> {
    // Wrap SELECT + validation + UPDATE in a single transaction with
    // FOR UPDATE row lock to eliminate the TOCTOU race condition.
    await db.transaction(async (client: PoolClient) => {
      const current = await client.query(`SELECT state FROM change_transactions WHERE txn_id = $1 FOR UPDATE`, [txnId])
      const stateValue = current.rows[0]?.["state"]
      const currentState = typeof stateValue === "string" ? (stateValue as TransactionState) : undefined
      if (!currentState) throw UserFacingError.notFound(`Transaction ${txnId}`)
      this.assertTransition(currentState, newState)

      const updated = await client.query(`UPDATE change_transactions SET state = $1, updated_at = NOW() WHERE txn_id = $2`, [
        newState,
        txnId,
      ])
      if (updated.rowCount !== 1) throw new Error(`Failed to update transaction state: ${txnId}`)
    })
    log.info("Transaction state changed", { txnId, newState })
  }

  /**
   * Resolve a file path safely, preventing path traversal.
   * Uses fsp.realpath on the base to resolve symlinks before
   * checking containment — prevents symlink-based escapes.
   */
  private resolveSafePath(basePath: string, filePath: string): string {
    const safePath = resolvePathWithinBase(basePath, filePath, { allowMissing: true })
    return safePath.existed ? safePath.realPath : safePath.resolvedPath
  }
}

export const transactionalChangeEngine = new TransactionalChangeEngine()
