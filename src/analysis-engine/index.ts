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

    // Identity columns only, loaded once for the whole snapshot. This used
    // to run once per ingested file, rebuilding the index each time and
    // asking the database for every name the index did not hold: 3.8 s of
    // gin's 17.6 s ingest, 11.9 s of flask's 28.6 s, 19.0 s of this engine's
    // 56.8 s. Resolving after every file's symbols exist also lets a
    // relation reach a symbol in a file persisted after its own.
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
    //
    // Names are scoped, and the scopes are in the keys. A key is
    // `<file>::<Parent.name>` or `<file>#<Parent.name>`, so from it come the
    // file, the directory — which is the package in Go, Java, C# and Kotlin,
    // and the module directory in Python — and the member's owner. Resolution
    // walks outward: same file, same directory, whole repository, and only a
    // unique match at a scope counts. Before this ladder every tree-sitter
    // language matched call text against bare names or nothing: gin kept 19%
    // of the relations it extracted, flask 6.5%.
    const svByCanonical = new Map<string, string[]>()
    const byFileName = new Map<string, string[]>()
    const byDirName = new Map<string, string[]>()
    const byOwnerName = new Map<string, string[]>()
    const push = (map: Map<string, string[]>, key: string, id: string): void => {
      const bucket = map.get(key)
      if (bucket) bucket.push(id)
      else map.set(key, [id])
    }
    const keyParts = (stableKey: string): { file: string; dir: string; member: string } => {
      let sep = stableKey.indexOf("::")
      let sepLen = 2
      if (sep < 0) {
        sep = stableKey.indexOf("#")
        sepLen = 1
      }
      const file = sep >= 0 ? stableKey.slice(0, sep) : stableKey
      const member = sep >= 0 ? stableKey.slice(sep + sepLen) : ""
      const slash = file.lastIndexOf("/")
      return { file, dir: slash >= 0 ? file.slice(0, slash) : "", member }
    }

    for (const sv of svRows) {
      svByKey.set(sv.stable_key, sv.symbol_version_id)
      push(svByCanonical, sv.canonical_name, sv.symbol_version_id)
      const { file, dir, member } = keyParts(sv.stable_key)
      push(byFileName, `${file}\u0000${sv.canonical_name}`, sv.symbol_version_id)
      push(byDirName, `${dir}\u0000${sv.canonical_name}`, sv.symbol_version_id)
      // `Parent.name` from the key, so `Type.method` call text resolves to the
      // member of that type wherever it lives.
      if (member.includes(".")) push(byOwnerName, member, sv.symbol_version_id)
    }

    const unique = (bucket: string[] | undefined): string | undefined =>
      bucket && bucket.length === 1 ? bucket[0] : undefined

    /**
     * Resolve a target from the in-memory maps, from the source symbol's own
     * scopes outward. Undefined means "not uniquely known here".
     */
    const resolveInScope = (rel: ExtractedRelation): string | undefined => {
      const exact =
        (rel.target_key ? svByKey.get(rel.target_key) : undefined) ||
        svByKey.get(rel.target_name) ||
        unique(svByCanonical.get(rel.target_name))
      if (exact) return exact

      const segments = rel.target_name.split(/::|\./).filter(Boolean)
      const last = segments[segments.length - 1]
      if (!last) return undefined
      if (segments.length > 1) {
        // `Owner.member` — the owner named in the call, wherever it lives.
        const owned = unique(byOwnerName.get(`${segments[segments.length - 2]}.${last}`))
        if (owned) return owned
      }
      const { file, dir } = keyParts(rel.source_key)
      return (
        unique(byFileName.get(`${file}\u0000${last}`)) ||
        unique(byDirName.get(`${dir}\u0000${last}`)) ||
        unique(svByCanonical.get(last))
      )
    }

    // An ambiguous name at every scope is not a weaker signal, it is a
    // different fact: it says "one of these several", and picking one is a
    // guess presented as a measurement. Better to record no edge than a
    // confident wrong one; the adapter's exact declaration key is what
    // resolves those cases. The index holds every symbol of the snapshot, so
    // there is nothing left to ask the database for.
    let persisted = 0
    let sourceFailures = 0
    let targetFailures = 0
    const rows: unknown[][] = []
    const seenEdges = new Set<string>()

    for (const rel of rawRelations) {
      const srcSvId = svByKey.get(rel.source_key)
      if (!srcSvId) {
        sourceFailures++
        continue
      }

      // Exact declaration key first — it is the only source that can tell two
      // same-named symbols apart — then the scopes, and at every step only a
      // unique match counts.
      const dstSvId = resolveInScope(rel)
      if (!dstSvId) {
        targetFailures++
        continue
      }

      // One statement cannot update the same conflict target twice.
      const edgeKey = `${srcSvId}|${dstSvId}|${rel.relation_type}`
      if (seenEdges.has(edgeKey)) continue
      seenEdges.add(edgeKey)
      rows.push([uuidv4(), srcSvId, dstSvId, rel.relation_type, 1.0, "static_analysis", 0.9])
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

    // One multi-row statement per chunk, not one round-trip per edge.
    if (rows.length > 0) {
      await db.bulkInsert(
        "structural_relations",
        ["relation_id", "src_symbol_version_id", "dst_symbol_version_id", "relation_type", "strength", "source", "confidence"],
        rows,
        {
          conflict:
            "ON CONFLICT (src_symbol_version_id, dst_symbol_version_id, relation_type) DO UPDATE SET confidence = GREATEST(structural_relations.confidence, EXCLUDED.confidence)",
        },
      )
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
