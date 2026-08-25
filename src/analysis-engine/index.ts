/**
 * ContextZero — Structural Graph Engine
 *
 * Resolves raw adapter-extracted relations into persisted structural graph edges.
 * Links symbol versions via calls, references, imports, inheritance, etc.
 */

import { v4 as uuidv4 } from "uuid"
import { db } from "../db-driver"
import { validateRows, validateStructuralRelation } from "../db-driver/result"
import { coreDataService } from "../db-driver/core_data"
import { Logger } from "../logger"
import type { ExtractedRelation, StructuralRelation } from "../types"

const log = new Logger("structural-graph")

export class StructuralGraphEngine {
  private boundedLimit(limit: number): number {
    return Number.isFinite(limit) ? Math.min(1_000, Math.max(1, Math.trunc(limit))) : 500
  }
  /**
   * Resolve raw adapter relations into DB structural_relations.
   * Maps source_key → symbol_id via symbols table, then creates edges.
   */
  public async computeRelationsFromRaw(
    snapshotId: string,
    repoId: string,
    rawRelations: ExtractedRelation[],
  ): Promise<number> {
    const timer = log.startTimer("computeRelationsFromRaw", {
      snapshotId,
      rawCount: rawRelations.length,
    })

    if (rawRelations.length === 0) {
      timer({ persisted: 0 })
      return 0
    }

    // Identity columns only. This runs once per ingested file, and the full
    // row set carries body_source for every symbol in the snapshot — 21 MB
    // against 2.4 MB on a real snapshot, all of it discarded right after the
    // two maps below are built.
    const svRows = await coreDataService.getSymbolIdentitiesForSnapshot(snapshotId)
    const svByKey = new Map<string, string>()
    // Canonical names map to EVERY symbol carrying them, not to one.
    //
    // This was a Map<name, id>, so the last symbol indexed under a given name
    // replaced all the others. A repository of any size has many `query`,
    // `run`, `handle`, `createSnapshot` — and a monorepo that vendors a
    // dependency has two of everything. Every call to any of them was
    // therefore attributed to one arbitrary symbol: that symbol accumulated
    // callers it never had, and all the genuine targets showed none at all,
    // which is why most of the graph looked uncalled.
    const svByCanonical = new Map<string, string[]>()

    for (const sv of svRows) {
      svByKey.set(sv.stable_key, sv.symbol_version_id)
      const bucket = svByCanonical.get(sv.canonical_name)
      if (bucket) bucket.push(sv.symbol_version_id)
      else svByCanonical.set(sv.canonical_name, [sv.symbol_version_id])
    }

    /**
     * Resolve a name when — and only when — it identifies one symbol.
     *
     * An ambiguous name is not a weaker signal, it is a different fact: it says
     * "one of these several", and picking one is a guess presented as a
     * measurement. Better to record no edge than a confident wrong one; the
     * adapter's exact declaration key is what resolves these cases.
     */
    const resolveUnique = (name: string): string | undefined => {
      const bucket = svByCanonical.get(name)
      return bucket && bucket.length === 1 ? bucket[0] : undefined
    }

    // First pass: collect all target names that can't be resolved from in-memory maps
    const unresolvedTargets = new Set<string>()
    for (const rel of rawRelations) {
      const srcSvId = svByKey.get(rel.source_key)
      if (!srcSvId) continue
      const dstSvId =
        (rel.target_key ? svByKey.get(rel.target_key) : undefined) ||
        svByKey.get(rel.target_name) ||
        resolveUnique(rel.target_name)
      if (!dstSvId) {
        unresolvedTargets.add(rel.target_name)
      }
    }

    // Batch-resolve all unresolved targets in chunked queries (avoids N+1)
    const CHUNK_SIZE = 5000
    const resolvedFromDb = new Map<string, string | null>()
    if (unresolvedTargets.size > 0) {
      const targetNames = Array.from(unresolvedTargets)
      for (let i = 0; i < targetNames.length; i += CHUNK_SIZE) {
        const chunk = targetNames.slice(i, i + CHUNK_SIZE)
        const placeholders = chunk.map((_, j) => `$${j + 3}`).join(",")
        const dbResult = await db.query(
          `
                    SELECT sv.symbol_version_id, s.canonical_name
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE s.repo_id = $1 AND sv.snapshot_id = $2
                    AND s.canonical_name IN (${placeholders})
                    ORDER BY s.canonical_name, sv.symbol_version_id
                `,
          [repoId, snapshotId, ...chunk],
        )
        // Count candidates per name; a name matching several symbols stays
        // unresolved rather than being pinned to whichever row sorted first.
        for (const row of dbResult.rows as { symbol_version_id: string; canonical_name: string }[]) {
          const seen = resolvedFromDb.get(row.canonical_name)
          if (seen === undefined) resolvedFromDb.set(row.canonical_name, row.symbol_version_id)
          else if (seen !== null && seen !== row.symbol_version_id) resolvedFromDb.set(row.canonical_name, null)
        }
      }
      log.debug("Batch-resolved unresolved relation targets", {
        unresolved: unresolvedTargets.size,
        resolved: resolvedFromDb.size,
      })
    }

    // Second pass: build relation insert statements using all resolution sources
    let persisted = 0
    let sourceFailures = 0
    let targetFailures = 0
    const statements: { text: string; params: unknown[] }[] = []

    for (const rel of rawRelations) {
      const srcSvId = svByKey.get(rel.source_key)
      if (!srcSvId) {
        sourceFailures++
        continue
      }

      // Exact declaration key first — it is the only source that can tell two
      // same-named symbols apart. Name matching remains as a fallback for
      // adapters that cannot resolve declarations, and only when unambiguous.
      const dstSvId =
        (rel.target_key ? svByKey.get(rel.target_key) : undefined) ||
        svByKey.get(rel.target_name) ||
        resolveUnique(rel.target_name) ||
        resolvedFromDb.get(rel.target_name) ||
        undefined

      if (!dstSvId) {
        targetFailures++
        continue
      }

      statements.push({
        text: `INSERT INTO structural_relations (relation_id, src_symbol_version_id, dst_symbol_version_id, relation_type, strength, source, confidence)
                       VALUES ($1, $2, $3, $4, $5, $6, $7)
                       ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type)
                       DO UPDATE SET confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence)`,
        params: [uuidv4(), srcSvId, dstSvId, rel.relation_type, 1.0, "static_analysis", 0.9],
      })
      persisted++
    }

    if (sourceFailures > 0 || targetFailures > 0) {
      log.info("Relation resolution summary", {
        total: rawRelations.length,
        persisted,
        sourceFailures,
        targetFailures,
      })
    }

    // Batch insert all relation statements in a single transaction
    if (statements.length > 0) {
      await db.batchInsert(statements)
    }

    timer({ persisted, sourceFailures, targetFailures })
    return persisted
  }

  /**
   * Get all structural relations for a given symbol version (both directions).
   */
  public async getRelationsForSymbol(symbolVersionId: string, limit = 500): Promise<StructuralRelation[]> {
    limit = this.boundedLimit(limit)
    const result = await db.query(
      `
            SELECT relation_id, src_symbol_version_id, dst_symbol_version_id,
                   relation_type, strength, source, confidence, provenance
            FROM structural_relations
            WHERE src_symbol_version_id = $1 OR dst_symbol_version_id = $1
            ORDER BY confidence DESC
            LIMIT $2
        `,
      [symbolVersionId, limit],
    )
    return validateRows(result.rows, validateStructuralRelation, "getRelationsForSymbol")
  }

  /**
   * Get direct callers of a symbol.
   */
  public async getCallers(symbolVersionId: string, limit = 500): Promise<StructuralRelation[]> {
    limit = this.boundedLimit(limit)
    const result = await db.query(
      `
            SELECT relation_id, src_symbol_version_id, dst_symbol_version_id,
                   relation_type, strength, source, confidence, provenance
            FROM structural_relations
            WHERE dst_symbol_version_id = $1 AND relation_type IN ('calls', 'references')
            ORDER BY confidence DESC
            LIMIT $2
        `,
      [symbolVersionId, limit],
    )
    return validateRows(result.rows, validateStructuralRelation, "getCallers")
  }

  /**
   * Get direct callees of a symbol.
   */
  public async getCallees(symbolVersionId: string, limit = 500): Promise<StructuralRelation[]> {
    limit = this.boundedLimit(limit)
    const result = await db.query(
      `
            SELECT relation_id, src_symbol_version_id, dst_symbol_version_id,
                   relation_type, strength, source, confidence, provenance
            FROM structural_relations
            WHERE src_symbol_version_id = $1 AND relation_type IN ('calls', 'references')
            ORDER BY confidence DESC
            LIMIT $2
        `,
      [symbolVersionId, limit],
    )
    return validateRows(result.rows, validateStructuralRelation, "getCallees")
  }
}

export const structuralGraphEngine = new StructuralGraphEngine()
