/**
 * ContextZero — Semantic Engine
 *
 * Orchestrates multi-view embedding generation, IDF corpus computation,
 * MinHash indexing, and semantic similarity queries.
 *
 * This is the native replacement for external embedding APIs.
 * It powers Homolog Dimension 1 (semantic intent similarity) and
 * provides candidates for Dimension 2 (normalized logic similarity).
 */

import { v4 as uuidv4 } from "uuid"
import { db } from "../db-driver"
import { BatchLoader } from "../db-driver/batch-loader"
import { firstRow, jsonField } from "../db-driver/result"
import { Logger } from "../logger"
import { BehaviorHint, BehavioralProfile, ContractHint, ContractProfile } from "../types"
import { tokenizeName, tokenizeBody, tokenizeSignature, tokenizeBehavior, tokenizeContract } from "./tokenizer"
import {
  SparseVector,
  computeTF,
  computeTFIDF,
  cosineSimilarity,
  generateMinHash,
  estimateJaccardFromMinHash,
  multiViewSimilarity,
  computeBandKeys,
  LSH_ROWS_PER_BAND,
  MINHASH_MIN_TOKENS,
  packMinHash,
  unpackMinHash,
  jaccardFromSparse,
  packSparseVector,
  unpackSparseVector,
  hashSparseKeys,
  tokenHashesInt32,
  distinctiveQueryHashes,
} from "./similarity"

const log = new Logger("semantic-engine")

/** The five semantic view types used by the engine */
const VIEW_TYPES = ["name", "body", "signature", "behavior", "contract"] as const
type ViewType = (typeof VIEW_TYPES)[number]

/** Default weights for multi-view similarity (aligned with HOMOLOG_WEIGHTS dimension 1) */
const DEFAULT_VIEW_WEIGHTS: Record<string, number> = {
  name: 0.25,
  body: 0.3,
  signature: 0.2,
  behavior: 0.15,
  contract: 0.1,
}

/** Number of MinHash permutations for LSH */
const MINHASH_PERMUTATIONS = 128

/**
 * Max PostgreSQL parameters per query (~32K limit, stay well below).
 * Band keys now ride on the vector row, so this is the only insert shape.
 */
const MAX_PG_PARAMS = 30000
/** symbol_version_id, view_type, sparse_vector, minhash_signature, token_count, band_keys, token_hashes */
const SEMANTIC_VEC_COLS = 7
const MAX_VEC_ROWS_PER_INSERT = Math.floor(MAX_PG_PARAMS / SEMANTIC_VEC_COLS) // ~4285
const MAX_LSH_CANDIDATES = 1_000
const EMBEDDING_PAGE_SIZE = 250
const EMBEDDING_FLUSH_SYMBOLS = 200
/**
 * Bound IDF vocabulary retained per view. Tokens beyond this cap still receive
 * the documented default IDF of 1.0 during vector construction. Without this
 * bound, attacker-controlled identifiers can make batch ingestion consume
 * unbounded heap and create multi-megabyte JSON parameters.
 */
const MAX_IDF_VOCABULARY_PER_VIEW = 50_000
/**
 * One view's stored similarity data. `signature` is null for views narrower
 * than MINHASH_MIN_TOKENS and for rows written before migration 023; `sparse`
 * is always present and is the exact token set, so a comparison is always
 * answerable.
 */
type ViewVector = { signature: number[] | null; sparse: SparseVector }

/**
 * The columns every similarity read needs. Takes the table alias because
 * symbol_versions carries symbol_version_id too, so the joined reads would
 * otherwise be ambiguous.
 */
function viewVectorColumns(alias = ""): string {
  const prefix = alias ? `${alias}.` : ""
  return `${prefix}symbol_version_id, ${prefix}view_type, ${prefix}minhash_signature, ${prefix}sparse_vector`
}

/**
 * Group `viewVectorColumns` rows into per-symbol, per-view vectors.
 */
function groupViewVectors(rows: Record<string, unknown>[]): Map<string, Record<string, ViewVector>> {
  const grouped = new Map<string, Record<string, ViewVector>>()
  for (const row of rows) {
    const svId = row["symbol_version_id"] as string
    let views = grouped.get(svId)
    if (!views) {
      views = {}
      grouped.set(svId, views)
    }
    views[row["view_type"] as string] = {
      signature: unpackMinHash(row["minhash_signature"] as Buffer | null),
      sparse: unpackSparseVector(row["sparse_vector"] as Buffer | null),
    }
  }
  return grouped
}

/**
 * Jaccard between two views: the MinHash estimate when both sides stored a
 * signature, the exact value from the sparse key sets otherwise. Narrow views
 * take the exact path, which is what they were always approximating.
 */
function viewJaccard(a: ViewVector | undefined, b: ViewVector | undefined): number {
  if (!a || !b) return 0
  if (a.signature && b.signature) return estimateJaccardFromMinHash(a.signature, b.signature)
  return jaccardFromSparse(a.sparse, b.sparse)
}

/**
 * Weighted multi-view similarity across DEFAULT_VIEW_WEIGHTS. Shared by the
 * LSH and linear candidate paths so the two can never drift apart.
 */
function scoreViews(target: Record<string, ViewVector>, candidate: Record<string, ViewVector>): number {
  let totalSim = 0
  let totalWeight = 0
  for (const [viewType, weight] of Object.entries(DEFAULT_VIEW_WEIGHTS)) {
    totalWeight += weight
    totalSim += weight * viewJaccard(target[viewType], candidate[viewType])
  }
  return totalWeight > 0 ? totalSim / totalWeight : 0
}

/**
 * A snapshot's stored IDF corpus, and whether one was actually found.
 *
 * `present` is the part that matters. Every consumer previously treated a
 * missing corpus as an empty one and carried on: computeTFIDF falls back to a
 * default IDF of 1.0 per token, which silently turns TF-IDF into plain TF. A
 * frequent, undiscriminating token then weighs as much as a rare one, so
 * ranking quietly degrades with nothing logged and no way to tell from the
 * results that it happened.
 */
type SnapshotIdf = { idfByView: Record<string, Record<string, number>>; present: boolean }

/**
 * Load and reconstruct a snapshot's IDF weights from the stored document
 * counts. One query for all five views.
 */
async function loadSnapshotIdf(snapshotId: string | undefined): Promise<SnapshotIdf> {
  const idfByView: Record<string, Record<string, number>> = {}
  if (!snapshotId) return { idfByView, present: false }

  const result = await db.query(
    `SELECT view_type, document_count, token_document_counts
       FROM idf_corpus WHERE snapshot_id = $1`,
    [snapshotId],
  )

  for (const row of result.rows) {
    const docCounts: Record<string, number> =
      typeof row.token_document_counts === "string"
        ? JSON.parse(row.token_document_counts)
        : row.token_document_counts
    const totalDocs = row.document_count as number
    const idf: Record<string, number> = {}
    for (const [token, freq] of Object.entries(docCounts)) {
      idf[token] = Math.log(1 + totalDocs / (1 + freq))
    }
    idfByView[row.view_type as string] = idf
  }

  return { idfByView, present: result.rows.length > 0 }
}

/**
 * Signature and band keys for one view, or nulls when the view is too narrow
 * to earn them (see MINHASH_MIN_TOKENS). Keeping both decisions in one place
 * guarantees band_keys are never present without the signature they derive
 * from, which the candidate reader relies on.
 */
function buildLshFields(tokenSet: Set<string>): { minhash: Buffer | null; bandKeys: number[] | null } {
  if (tokenSet.size < MINHASH_MIN_TOKENS) return { minhash: null, bandKeys: null }
  const signature = generateMinHash(tokenSet, MINHASH_PERMUTATIONS)
  return { minhash: packMinHash(signature), bandKeys: computeBandKeys(signature, LSH_ROWS_PER_BAND) }
}

/**
 * Build a multi-row INSERT ... ON CONFLICT for semantic_vectors.
 * Returns one or more statements (chunked if row count exceeds PG param limit).
 */
function buildMultiRowVectorInsert(
  rows: {
    symbolVersionId: string
    viewType: string
    sparse: Buffer
    minhash: Buffer | null
    tokenCount: number
    bandKeys: number[] | null
    tokenHashes: number[] | null
  }[],
): { text: string; params: unknown[] }[] {
  const statements: { text: string; params: unknown[] }[] = []
  for (let offset = 0; offset < rows.length; offset += MAX_VEC_ROWS_PER_INSERT) {
    const chunk = rows.slice(offset, offset + MAX_VEC_ROWS_PER_INSERT)
    const valuesClauses: string[] = []
    const params: unknown[] = []
    let idx = 1
    for (const r of chunk) {
      valuesClauses.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6})`)
      params.push(r.symbolVersionId, r.viewType, r.sparse, r.minhash, r.tokenCount, r.bandKeys, r.tokenHashes)
      idx += SEMANTIC_VEC_COLS
    }
    statements.push({
      text: `INSERT INTO semantic_vectors
                   (symbol_version_id, view_type, sparse_vector, minhash_signature, token_count, band_keys, token_hashes)
                   VALUES ${valuesClauses.join(", ")}
                   ON CONFLICT (symbol_version_id, view_type)
                   DO UPDATE SET sparse_vector = EXCLUDED.sparse_vector,
                                 minhash_signature = EXCLUDED.minhash_signature,
                                 token_count = EXCLUDED.token_count,
                                 band_keys = EXCLUDED.band_keys,
                                 token_hashes = EXCLUDED.token_hashes,
                                 created_at = NOW()`,
      params,
    })
  }
  return statements
}

class SemanticEngine {
  /**
   * Convert pre-loaded behavioral and contract profiles into the BehaviorHint[]
   * and ContractHint used by the tokenizer.
   * Extracted to avoid duplication across batch embedding paths.
   */
  private _buildHintsFromProfiles(
    name: string,
    bp: BehavioralProfile | undefined,
    cp: ContractProfile | undefined,
  ): { behaviorHints: BehaviorHint[]; contractHint: ContractHint | null } {
    const behaviorHints: BehaviorHint[] = []
    if (bp) {
      const addHints = (items: string[], hintType: BehaviorHint["hint_type"]) => {
        const arr = Array.isArray(items) ? items : []
        for (const detail of arr) {
          behaviorHints.push({ symbol_key: name, hint_type: hintType, detail, line: 0 })
        }
      }
      addHints(bp.db_reads, "db_read")
      addHints(bp.db_writes, "db_write")
      addHints(bp.network_calls, "network_call")
      addHints(bp.file_io, "file_io")
      addHints(bp.cache_ops, "cache_op")
      addHints(bp.auth_operations, "auth_check")
      addHints(bp.validation_operations, "validation")
      addHints(bp.exception_profile, "throws")
    }

    let contractHint: ContractHint | null = null
    if (cp) {
      contractHint = {
        symbol_key: name,
        input_types: Array.isArray(cp.input_contract) ? cp.input_contract : [String(cp.input_contract || "")],
        output_type: String(cp.output_contract || ""),
        thrown_types: Array.isArray(cp.error_contract) ? cp.error_contract : [String(cp.error_contract || "")],
        decorators: Array.isArray(cp.schema_refs) ? cp.schema_refs : [],
      }
    }

    return { behaviorHints, contractHint }
  }

  /**
   * Compute the 5-view token streams for a symbol WITHOUT persisting to DB.
   * Returns the raw token arrays keyed by view type.
   * Used by single-pass batch embedding to build in-memory token maps
   * before IDF computation.
   */
  private computeTokenStreams(
    code: string,
    name: string,
    signature: string,
    behaviorHints: BehaviorHint[],
    contractHint: ContractHint | null,
  ): Record<ViewType, string[]> {
    return {
      name: tokenizeName(name),
      body: tokenizeBody(code),
      signature: tokenizeSignature(signature),
      behavior: tokenizeBehavior(behaviorHints.map((h) => ({ hint_type: h.hint_type, detail: h.detail }))),
      contract: contractHint
        ? tokenizeContract({
            input_types: contractHint.input_types,
            output_type: contractHint.output_type,
            thrown_types: contractHint.thrown_types,
            decorators: contractHint.decorators,
          })
        : [],
    }
  }


  /**
   * Embed a single symbol version: generate 5 view token streams,
   * compute TF-IDF vectors, generate MinHash signatures, persist to DB.
   */
  async embedSymbol(
    symbolVersionId: string,
    code: string,
    name: string,
    signature: string,
    behaviorHints: BehaviorHint[],
    contractHint: ContractHint | null,
    /**
     * The snapshot's IDF corpus, when the caller already holds it. Embedding a
     * set of symbols one at a time otherwise re-queried and re-parsed the whole
     * corpus for every symbol — two queries and up to five JSON documents of as
     * many as 50,000 tokens each, per symbol, on the path the watcher runs
     * after every edit.
     */
    preloadedIdf?: SnapshotIdf,
  ): Promise<void> {
    const done = log.startTimer("embedSymbol", { symbolVersionId })

    try {
      // Step 1: Generate token streams for all 5 views
      const viewTokens: Record<ViewType, string[]> = {
        name: tokenizeName(name),
        body: tokenizeBody(code),
        signature: tokenizeSignature(signature),
        behavior: tokenizeBehavior(behaviorHints.map((h) => ({ hint_type: h.hint_type, detail: h.detail }))),
        contract: contractHint
          ? tokenizeContract({
              input_types: contractHint.input_types,
              output_type: contractHint.output_type,
              thrown_types: contractHint.thrown_types,
              decorators: contractHint.decorators,
            })
          : [],
      }

      // Step 2: Load IDF for this symbol's snapshot, unless the caller supplied it.
      let corpus = preloadedIdf
      if (!corpus) {
        const snapshotResult = await db.query(`SELECT snapshot_id FROM symbol_versions WHERE symbol_version_id = $1`, [
          symbolVersionId,
        ])
        corpus = await loadSnapshotIdf(snapshotResult.rows[0]?.snapshot_id as string | undefined)
      }
      const idfByView = corpus.idfByView

      // Step 3: Compute TF-IDF and MinHash for each view, prepare multi-row inserts
      const vectorRows: {
        symbolVersionId: string
        viewType: string
        sparse: Buffer
        minhash: Buffer | null
        tokenCount: number
        bandKeys: number[] | null
        tokenHashes: number[] | null
      }[] = []

      for (const viewType of VIEW_TYPES) {
        const tokens = viewTokens[viewType]
        const tf = computeTF(tokens)
        const idf = idfByView[viewType] || {}
        const tfidf = computeTFIDF(tf, idf)

        // Band keys ride on the vector row — see migration 019 — and are only
        // minted for views wide enough to hold a signature, see migration 023.
        const tokenSet = new Set(tokens)
        const { minhash, bandKeys } = buildLshFields(tokenSet)

        vectorRows.push({
          symbolVersionId,
          viewType,
          sparse: packSparseVector(tfidf),
          minhash,
          tokenCount: tokens.length,
          bandKeys,
          // Only the body view is searched, so only it carries the inverted
          // index — see migration 026.
          tokenHashes: viewType === "body" ? tokenHashesInt32(tokenSet) : null,
        })
      }

      // Step 4: one statement for all five views
      await db.batchInsert(buildMultiRowVectorInsert(vectorRows))

      done({ views: VIEW_TYPES.length, totalTokens: Object.values(viewTokens).reduce((s, t) => s + t.length, 0) })
    } catch (error) {
      log.error("Failed to embed symbol", error, { symbolVersionId })
      throw error
    }
  }

  /**
   * Find semantic candidates for a symbol using LSH banding.
   * Computes band hashes from the target's MinHash signatures, queries the
   * band-key arrays for symbols sharing at least one band, then re-scores
   * matches with weighted Jaccard for accurate ranking.
   *
   * Falls back to linear scan if no LSH bands exist (graceful degradation).
   */
  async findSemanticCandidates(
    symbolVersionId: string,
    snapshotId: string,
    topK: number = 50,
  ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
    topK = Number.isFinite(topK) ? Math.min(200, Math.max(1, Math.trunc(topK))) : 50
    const done = log.startTimer("findSemanticCandidates", { symbolVersionId, snapshotId, topK })

    try {
      // Step 1: Load the target's stored vectors and band keys for every view.
      const targetResult = await db.query(
        `SELECT ${viewVectorColumns()}, band_keys
                 FROM semantic_vectors
                 WHERE symbol_version_id = $1`,
        [symbolVersionId],
      )

      if (targetResult.rows.length === 0) {
        log.warn("No semantic vectors found for target symbol", { symbolVersionId })
        done({ candidates: 0 })
        return []
      }

      const targetViews = groupViewVectors(targetResult.rows).get(symbolVersionId) ?? {}

      // Step 2: Band keys are persisted alongside the signature they derive
      // from, so the target's are read rather than recomputed. Views below
      // MINHASH_MIN_TOKENS store neither and simply contribute no candidates —
      // they still score, exactly, in step 6.
      const targetBandKeys: Record<string, number[]> = {}
      for (const row of targetResult.rows) {
        const keys = row.band_keys as number[] | null
        if (keys && keys.length > 0) targetBandKeys[row.view_type as string] = keys
      }

      if (Object.keys(targetBandKeys).length === 0) {
        done({ candidates: 0, mode: "empty-target" })
        return []
      }

      // Step 3: Snapshots embedded before migration 019 have no band keys.
      // They still resolve, via the linear scan that already covers un-embedded
      // snapshots — slower, but correct, and re-ingesting repopulates them.
      const lshCheck = await db.query(
        `SELECT 1 FROM semantic_vectors sem
                 JOIN symbol_versions sv ON sv.symbol_version_id = sem.symbol_version_id
                 WHERE sv.snapshot_id = $1 AND sem.band_keys IS NOT NULL
                 LIMIT 1`,
        [snapshotId],
      )

      if (lshCheck.rows.length === 0) {
        log.info("No LSH band keys for snapshot, falling back to linear scan", { snapshotId })
        const result = await this._findSemanticCandidatesLinear(symbolVersionId, snapshotId, topK, targetViews)
        done({ candidates: result.length, mode: "linear-fallback" })
        return result
      }

      // Step 4: candidates are rows whose band-key array overlaps the target's.
      // Because the band index is folded into each key, a plain array overlap
      // expresses "shares band i at band i" exactly, and GIN answers it without
      // the tuple-list join the separate band table required.
      const viewTypes = Object.keys(targetBandKeys)
      const candidateSvIds = new Set<string>()

      const bandQueries = viewTypes.map(async (viewType) => {
        const keys = targetBandKeys[viewType]!
        if (keys.length === 0) return

        const result = await db.query(
          `SELECT sem.symbol_version_id
                     FROM semantic_vectors sem
                     JOIN symbol_versions sv ON sv.symbol_version_id = sem.symbol_version_id
                     WHERE sv.snapshot_id = $1
                       AND sem.symbol_version_id != $2
                       AND sem.view_type = $3
                       AND sem.band_keys && $4::int[]
                     ORDER BY sem.symbol_version_id
                     LIMIT $5`,
          [snapshotId, symbolVersionId, viewType, keys, MAX_LSH_CANDIDATES],
        )
        for (const row of result.rows) {
          candidateSvIds.add(row.symbol_version_id as string)
        }
      })

      await Promise.all(bandQueries)

      if (candidateSvIds.size === 0) {
        log.debug("LSH banding found no candidates", { symbolVersionId, snapshotId })
        done({ candidates: 0, mode: "lsh" })
        return []
      }

      // Step 5: Load candidate vectors (chunked)
      const candidateIds = Array.from(candidateSvIds)
      const CHUNK_SIZE = 5000
      const candidateViews: Map<string, Record<string, ViewVector>> = new Map()

      for (let i = 0; i < candidateIds.length; i += CHUNK_SIZE) {
        const chunk = candidateIds.slice(i, i + CHUNK_SIZE)
        const placeholders = chunk.map((_, j) => `$${j + 1}`).join(", ")
        const vectorResult = await db.query(
          `SELECT ${viewVectorColumns()}
                     FROM semantic_vectors
                     WHERE symbol_version_id IN (${placeholders})`,
          chunk,
        )

        for (const [svId, views] of groupViewVectors(vectorResult.rows)) {
          candidateViews.set(svId, views)
        }
      }

      // Step 6: Re-score candidates with weighted Jaccard similarity
      const scores: { svId: string; estimatedSimilarity: number }[] = []

      for (const [svId, views] of candidateViews) {
        scores.push({ svId, estimatedSimilarity: scoreViews(targetViews, views) })
      }

      // Sort by similarity descending, take top-K
      scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity)
      const topCandidates = scores.slice(0, topK)

      done({
        candidates: topCandidates.length,
        lshMatches: candidateSvIds.size,
        mode: "lsh",
      })
      return topCandidates
    } catch (error) {
      log.error("Failed to find semantic candidates", error, { symbolVersionId, snapshotId })
      throw error
    }
  }

  /**
   * Linear fallback for findSemanticCandidates when LSH bands haven't been built.
   * Loads ALL MinHash signatures in the snapshot and compares O(N).
   * Kept as graceful degradation for snapshots without LSH band data.
   */
  private async _findSemanticCandidatesLinear(
    symbolVersionId: string,
    snapshotId: string,
    topK: number,
    targetViews: Record<string, ViewVector>,
  ): Promise<{ svId: string; estimatedSimilarity: number }[]> {
    // Load all other symbols' vectors in the same snapshot
    const candidatesResult = await db.query(
      `SELECT ${viewVectorColumns("sv")}
             FROM semantic_vectors sv
             JOIN symbol_versions symv ON symv.symbol_version_id = sv.symbol_version_id
             WHERE symv.snapshot_id = $1 AND sv.symbol_version_id != $2
             LIMIT 50000`,
      [snapshotId, symbolVersionId],
    )

    const scores: { svId: string; estimatedSimilarity: number }[] = []
    for (const [svId, views] of groupViewVectors(candidatesResult.rows)) {
      scores.push({ svId, estimatedSimilarity: scoreViews(targetViews, views) })
    }

    // Sort by similarity descending, take top-K
    scores.sort((a, b) => b.estimatedSimilarity - a.estimatedSimilarity)
    return scores.slice(0, topK)
  }

  /**
   * Compute precise semantic similarity between two symbol versions
   * using multi-view weighted cosine similarity on TF-IDF vectors.
   */
  async computeSemanticSimilarity(svIdA: string, svIdB: string): Promise<number> {
    try {
      // Load TF-IDF vectors for both symbols
      const [resultA, resultB] = await Promise.all([
        db.query(`SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`, [svIdA]),
        db.query(`SELECT view_type, sparse_vector FROM semantic_vectors WHERE symbol_version_id = $1`, [svIdB]),
      ])

      if (resultA.rows.length === 0 || resultB.rows.length === 0) {
        log.warn("Missing semantic vectors for similarity computation", {
          svIdA,
          svIdB,
          vectorsA: resultA.rows.length,
          vectorsB: resultB.rows.length,
        })
        return 0
      }

      // Decoding a packed vector is total — a truncated or empty value yields an
      // empty vector, which scores zero — so the per-row parse guards the JSONB
      // form needed are gone with it.
      const byView = (rows: Record<string, unknown>[]): Map<string, SparseVector> => {
        const views = new Map<string, SparseVector>()
        for (const row of rows) {
          views.set(row["view_type"] as string, unpackSparseVector(row["sparse_vector"] as Buffer | null))
        }
        return views
      }

      return multiViewSimilarity(byView(resultA.rows), byView(resultB.rows), DEFAULT_VIEW_WEIGHTS)
    } catch (error) {
      log.error("Failed to compute semantic similarity", error, { svIdA, svIdB })
      throw error
    }
  }

  /**
   * Compute body-only similarity between two symbols using MinHash Jaccard.
   * This gives graduated similarity (0.0–1.0) for function bodies that share
   * logic but aren't byte-identical — unlike hash comparison which is binary.
   */
  async computeBodySimilarity(svIdA: string, svIdB: string): Promise<number> {
    const bodyVector = (svId: string) =>
      db.query(
        `SELECT ${viewVectorColumns()} FROM semantic_vectors WHERE symbol_version_id = $1 AND view_type = 'body'`,
        [svId],
      )
    const [resultA, resultB] = await Promise.all([bodyVector(svIdA), bodyVector(svIdB)])

    if (resultA.rows.length === 0 || resultB.rows.length === 0) return 0

    // A body short enough to store no signature is still compared, exactly,
    // from its sparse vector — see viewJaccard.
    const viewsA = groupViewVectors(resultA.rows).get(svIdA)
    const viewsB = groupViewVectors(resultB.rows).get(svIdB)

    return viewJaccard(viewsA?.["body"], viewsB?.["body"])
  }

  /**
   * Embed a specific set of symbol versions against the snapshot's STORED IDF
   * corpus, instead of rebuilding the corpus from the whole snapshot.
   *
   * This is what makes an incremental re-index usable. `batchEmbedSnapshot`
   * re-tokenizes every symbol in the repository twice — on a 28k-symbol snapshot
   * that is over two minutes, and running it after a one-file edit meant a
   * single save cost minutes of work to recompute vectors that had not changed.
   * Skipping it instead is not an option: the edited symbols would have no
   * vectors at all, so semantic search would silently stop returning the code
   * the user just wrote.
   *
   * The tradeoff is explicit and bounded: IDF weights drift slightly as the
   * corpus changes underneath, because term frequencies from the last full pass
   * are reused. That affects ranking, never presence — an edited symbol is
   * always findable. A later full pass settles the drift.
   */
  async embedSymbolVersions(symbolVersionIds: string[]): Promise<number> {
    if (symbolVersionIds.length === 0) return 0
    const done = log.startTimer("embedSymbolVersions", { count: symbolVersionIds.length })

    try {
      const loader = new BatchLoader()
      const rows = await loader.loadSymbolVersionsByIds(symbolVersionIds)
      if (rows.length === 0) {
        done({ embedded: 0 })
        return 0
      }

      const ids = rows.map((row) => row.symbol_version_id)
      const [behavioral, contracts] = await Promise.all([
        loader.loadBehavioralProfiles(ids),
        loader.loadContractProfiles(ids),
      ])

      // Every symbol here belongs to the same snapshot, so its corpus is loaded
      // once for the whole set rather than once per symbol.
      const snapshotId = rows[0]?.snapshot_id as string | undefined
      const corpus = await loadSnapshotIdf(snapshotId)

      // Embedding against an absent corpus is not a degraded result, it is a
      // wrong one: every token would take the default IDF of 1.0 and the stored
      // vectors would be plain TF, scored later against vectors that are not.
      // Building the corpus is exactly what the full pass does, so defer to it
      // rather than writing vectors that quietly disagree with their neighbours.
      if (!corpus.present && snapshotId) {
        log.warn("No IDF corpus for snapshot — running a full embed to build one", {
          snapshotId,
          requested: symbolVersionIds.length,
        })
        const embeddedAll = await this.batchEmbedSnapshot(snapshotId)
        done({ embedded: embeddedAll, mode: "corpus-rebuild" })
        return embeddedAll
      }

      let embedded = 0
      for (const symbol of rows) {
        const { behaviorHints, contractHint } = this._buildHintsFromProfiles(
          symbol.canonical_name,
          behavioral.get(symbol.symbol_version_id),
          contracts.get(symbol.symbol_version_id),
        )
        await this.embedSymbol(
          symbol.symbol_version_id,
          symbol.body_source ?? symbol.summary ?? "",
          symbol.canonical_name,
          symbol.signature ?? "",
          behaviorHints,
          contractHint,
          corpus,
        )
        embedded++
      }

      done({ embedded })
      return embedded
    } catch (err) {
      done({ error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  /**
   * Batch-embed all symbols in a snapshot using two bounded, paginated passes.
   *
   * Pass 1 computes document frequencies without retaining source bodies or
   * per-symbol token streams. Pass 2 recomputes one page of token streams and
   * persists vectors with the resulting IDF. The second tokenization pass is a
   * deliberate CPU-for-memory tradeoff: repository size no longer determines
   * how many source bodies and token arrays are simultaneously resident.
   */
  async batchEmbedSnapshot(snapshotId: string): Promise<number> {
    const done = log.startTimer("batchEmbedSnapshot", { snapshotId })

    try {
      const loadPage = async (afterId?: string) => {
        // A fresh loader bounds profile caches to one page.
        const loader = new BatchLoader()
        const page = await loader.loadSymbolVersionsBySnapshotPaginated(snapshotId, {
          pageSize: EMBEDDING_PAGE_SIZE,
          afterId,
        })
        const ids = page.rows.map((row) => row.symbol_version_id)
        const [behavioral, contracts] = await Promise.all([
          loader.loadBehavioralProfiles(ids),
          loader.loadContractProfiles(ids),
        ])
        const streams = page.rows.map((symbol) => {
          const { behaviorHints, contractHint } = this._buildHintsFromProfiles(
            symbol.canonical_name,
            behavioral.get(symbol.symbol_version_id),
            contracts.get(symbol.symbol_version_id),
          )
          return {
            symbolVersionId: symbol.symbol_version_id,
            tokens: this.computeTokenStreams(
              symbol.body_source ?? symbol.summary,
              symbol.canonical_name,
              symbol.signature,
              behaviorHints,
              contractHint,
            ),
          }
        })
        return { streams, nextCursor: page.nextCursor }
      }

      log.info("Starting paginated batch embedding", { snapshotId, pageSize: EMBEDDING_PAGE_SIZE })

      // Pass 1: retain only bounded document-frequency maps, not source rows.
      const documentFrequencies = Object.fromEntries(VIEW_TYPES.map((view) => [view, new Map<string, number>()])) as Record<
        ViewType,
        Map<string, number>
      >
      const cappedViews = new Set<ViewType>()
      let totalDocs = 0
      let cursor: string | undefined
      let hasMore = true

      while (hasMore) {
        const page = await loadPage(cursor)
        for (const stream of page.streams) {
          totalDocs++
          for (const viewType of VIEW_TYPES) {
            const counts = documentFrequencies[viewType]
            for (const token of new Set(stream.tokens[viewType])) {
              const current = counts.get(token)
              if (current !== undefined) {
                counts.set(token, current + 1)
              } else if (counts.size < MAX_IDF_VOCABULARY_PER_VIEW) {
                counts.set(token, 1)
              } else {
                cappedViews.add(viewType)
              }
            }
          }
        }
        hasMore = page.nextCursor !== null
        cursor = page.nextCursor ?? undefined
      }

      if (totalDocs === 0) {
        await db.query(`DELETE FROM idf_corpus WHERE snapshot_id = $1`, [snapshotId])
        done({ embedded: 0 })
        return 0
      }

      const idfByView = Object.create(null) as Record<ViewType, Record<string, number>>
      for (const viewType of VIEW_TYPES) {
        const countsObject = Object.create(null) as Record<string, number>
        const scores = Object.create(null) as Record<string, number>
        for (const [token, frequency] of documentFrequencies[viewType]) {
          countsObject[token] = frequency
          scores[token] = Math.log(1 + totalDocs / (1 + frequency))
        }
        idfByView[viewType] = scores

        await db.query(
          `INSERT INTO idf_corpus (corpus_id, snapshot_id, view_type, document_count, token_document_counts)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (snapshot_id, view_type)
                     DO UPDATE SET document_count = $4, token_document_counts = $5, computed_at = NOW()`,
          [uuidv4(), snapshotId, viewType, totalDocs, JSON.stringify(countsObject)],
        )
      }

      if (cappedViews.size > 0) {
        log.warn("IDF vocabulary cap reached; excess tokens will use default IDF", {
          snapshotId,
          views: [...cappedViews],
          capPerView: MAX_IDF_VOCABULARY_PER_VIEW,
        })
      }

      log.info("Pass 1 complete: bounded IDF corpus computed", { snapshotId, symbolCount: totalDocs })

      // Pass 2: recompute one page at a time and persist real-IDF vectors.
      let embedded = 0
      let pendingVectorRows: {
        symbolVersionId: string
        viewType: string
        sparse: Buffer
        minhash: Buffer | null
        tokenCount: number
        bandKeys: number[] | null
        tokenHashes: number[] | null
      }[] = []

      const flushPending = async () => {
        if (pendingVectorRows.length === 0) return
        await db.batchInsert(buildMultiRowVectorInsert(pendingVectorRows))
        pendingVectorRows = []
      }

      // Phase 3 is the slowest part of ingestion by a wide margin, so its cost
      // is broken down rather than reported as one number — without this split
      // there is no way to tell CPU (tf-idf, minhash) from I/O (flush).
      let tfidfMs = 0
      let lshMs = 0
      let flushMs = 0

      cursor = undefined
      hasMore = true
      while (hasMore) {
        const page = await loadPage(cursor)
        for (const stream of page.streams) {
          for (const viewType of VIEW_TYPES) {
            const tokens = stream.tokens[viewType]
            let mark = Date.now()
            const tfidf = computeTFIDF(computeTF(tokens), idfByView[viewType])
            tfidfMs += Date.now() - mark

            mark = Date.now()
            const tokenSet = new Set(tokens)
            const { minhash, bandKeys } = buildLshFields(tokenSet)
            lshMs += Date.now() - mark

            pendingVectorRows.push({
              symbolVersionId: stream.symbolVersionId,
              viewType,
              sparse: packSparseVector(tfidf),
              minhash,
              tokenCount: tokens.length,
              bandKeys,
              tokenHashes: viewType === "body" ? tokenHashesInt32(tokenSet) : null,
            })
          }

          embedded++
          if (embedded % EMBEDDING_FLUSH_SYMBOLS === 0) {
            const mark = Date.now()
            await flushPending()
            flushMs += Date.now() - mark
            log.info("Batch embedding progress", { snapshotId, embedded, total: totalDocs })
          }
        }
        hasMore = page.nextCursor !== null
        cursor = page.nextCursor ?? undefined
      }

      // Final flush for remaining symbols
      const finalMark = Date.now()
      await flushPending()
      flushMs += Date.now() - finalMark

      log.info("Pass 2 complete: all vectors persisted with real IDF", {
        snapshotId,
        embedded,
        tfidf_ms: tfidfMs,
        lsh_ms: lshMs,
        db_flush_ms: flushMs,
      })

      done({ embedded })
      return embedded
    } catch (error) {
      log.error("Failed to batch embed snapshot", error, { snapshotId })
      throw error
    }
  }

  /**
   * Search symbols by a free-text query string using TF-IDF cosine similarity.
   *
   * Memory-efficient: instead of loading ALL vectors for the snapshot,
   * this method:
   *   1. Tokenizes the query and computes its TF-IDF vector + MinHash signature
   *   2. Uses LSH band lookup to find candidate symbols (sub-linear)
   *   3. Computes cosine similarity only against those candidates
   *   4. Falls back to batched scanning (500 at a time) if no LSH candidates
   *
   * Never loads more than ~1000 vectors into memory at once.
   */
  async searchByQuery(
    query: string,
    snapshotId: string,
    limit: number = 15,
  ): Promise<{ svId: string; similarity: number }[]> {
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 15
    const done = log.startTimer("searchByQuery", { snapshotId, limit })

    try {
      // Step 1: Tokenize the query using the body tokenizer
      const queryTokens = tokenizeBody(query)
      if (queryTokens.length === 0) {
        done({ candidates: 0, mode: "no-tokens" })
        return []
      }

      // Step 2: Compute query TF
      const queryTF = computeTF(queryTokens)

      // Step 3: Load IDF for body view from this snapshot
      const idfResult = await db.query(
        `SELECT document_count, token_document_counts FROM idf_corpus
                 WHERE snapshot_id = $1 AND view_type = 'body'`,
        [snapshotId],
      )

      const queryIDF: Record<string, number> = {}
      if (idfResult.rows.length === 0) {
        // Without weights the query is scored on raw term frequency, so a
        // common word counts for as much as a distinguishing one. Results still
        // come back, which is why this has to be said out loud.
        log.warn("No IDF corpus for snapshot — search is ranking on term frequency alone", { snapshotId })
      } else {
        const docCounts = jsonField<Record<string, number>>(firstRow(idfResult), "token_document_counts") ?? {}
        const totalDocs = idfResult.rows[0].document_count as number
        for (const [token, freq] of Object.entries(docCounts)) {
          queryIDF[token] = Math.log(1 + totalDocs / (1 + freq))
        }
        // OOV and vocabulary-capped terms use computeTFIDF's default 1.0,
        // matching the vectors produced by batch embedding.
      }

      // Step 4: Compute query TF-IDF vector
      // Stored vectors are keyed by token hash (migration 025), so the query
      // built from text has to be re-keyed onto the same identity before it can
      // be compared against them.
      const queryVector = hashSparseKeys(computeTFIDF(queryTF, queryIDF))

      // Step 5: Retrieve candidates from the body inverted index (migration 026).
      // Cosine is a sum over shared terms, so a symbol that shares no query token
      // scores exactly zero — which makes "bodies whose token_hashes overlap the
      // query" the exact set worth scoring, not an approximation. Probing with
      // the distinctive (high-IDF) query hashes keeps a ubiquitous word from
      // dragging in the whole table while changing the ranking of real matches
      // negligibly. Snapshots embedded before migration 026 have token_hashes
      // NULL, match nothing here, and fall through to the batched scan below —
      // the same graceful degradation migration 019 relied on.
      const queryHashes = distinctiveQueryHashes(queryVector)

      let candidateSvIds: string[] = []

      if (queryHashes.length > 0) {
        const invResult = await db.query(
          `SELECT sem.symbol_version_id
                     FROM semantic_vectors sem
                     JOIN symbol_versions sv ON sv.symbol_version_id = sem.symbol_version_id
                     WHERE sv.snapshot_id = $1
                       AND sem.view_type = 'body'
                       AND sem.token_hashes && $2::int[]
                     ORDER BY sem.symbol_version_id
                     LIMIT $3`,
          [snapshotId, queryHashes, MAX_LSH_CANDIDATES],
        )

        candidateSvIds = invResult.rows.map((r) => r.symbol_version_id as string)
        log.debug("Inverted-index candidates for query", { count: candidateSvIds.length, snapshotId })
      }

      // Step 6: Score candidates by cosine similarity
      if (candidateSvIds.length > 0) {
        // Load vectors only for LSH candidates (chunked to max 1000)
        const scores = await this._scoreCandidatesByVector(candidateSvIds, queryVector, limit)
        done({ candidates: scores.length, mode: "lsh", lshHits: candidateSvIds.length })
        return scores
      }

      // Step 7: Fallback — no LSH candidates. Scan in batches of 500.
      log.debug("No LSH candidates, falling back to batched scan", { snapshotId })
      const scores = await this._batchedVectorScan(snapshotId, queryVector, limit)
      done({ candidates: scores.length, mode: "batched-fallback" })
      return scores
    } catch (error) {
      log.error("Failed to search by query", error, { snapshotId })
      throw error
    }
  }

  /**
   * Load sparse vectors for a specific set of candidate symbol_version_ids
   * and compute cosine similarity against the query vector.
   * Processes in chunks of 500 to limit memory.
   */
  private async _scoreCandidatesByVector(
    candidateSvIds: string[],
    queryVector: SparseVector,
    limit: number,
  ): Promise<{ svId: string; similarity: number }[]> {
    const CHUNK_SIZE = 500
    const scores: { svId: string; similarity: number }[] = []

    for (let i = 0; i < candidateSvIds.length; i += CHUNK_SIZE) {
      const chunk = candidateSvIds.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(", ")

      // Join with symbols to get kind for relevance boosting
      const result = await db.query(
        `
                SELECT sev.symbol_version_id, sev.sparse_vector, s.kind,
                       sv.range_end_line - sv.range_start_line + 1 as line_span
                FROM semantic_vectors sev
                JOIN symbol_versions sv ON sv.symbol_version_id = sev.symbol_version_id
                JOIN symbols s ON s.symbol_id = sv.symbol_id
                WHERE sev.symbol_version_id IN (${placeholders})
                AND sev.view_type = 'body'
            `,
        chunk,
      )

      for (const row of result.rows) {
        const svVec = unpackSparseVector(row.sparse_vector as Buffer | null)

        let sim = cosineSimilarity(queryVector, svVec)

        // Kind-based relevance boosting: meaningful code units rank higher
        const kind = row.kind as string
        const lineSpan = typeof row.line_span === "number" ? row.line_span : 0
        if (kind === "function" || kind === "method" || kind === "class") {
          sim *= 1.15
        } else if (kind === "interface") {
          sim *= 0.9
        } else if ((kind === "variable" || kind === "constant") && lineSpan <= 2) {
          sim *= 0.2 // Single-line declarations are noise
        }

        if (sim > 0.01) {
          scores.push({ svId: row.symbol_version_id as string, similarity: Math.min(1.0, sim) })
        }
      }
    }

    scores.sort((a, b) => b.similarity - a.similarity)
    return scores.slice(0, limit)
  }

  /**
   * Batched fallback: scan ALL body vectors in the snapshot using keyset
   * (cursor-based) pagination in batches of 500, computing cosine similarity
   * per batch and keeping only the top-k results. Never holds more than
   * 500 vectors in memory at once.
   *
   * Uses keyset pagination (WHERE id > $lastSeen) instead of LIMIT/OFFSET
   * for stable performance regardless of how deep into the result set we are.
   */
  private async _batchedVectorScan(
    snapshotId: string,
    queryVector: SparseVector,
    limit: number,
  ): Promise<{ svId: string; similarity: number }[]> {
    const BATCH_SIZE = 500
    let lastSeenId: string | null = null
    let topScores: { svId: string; similarity: number }[] = []
    let hasMore = true

    while (hasMore) {
      // Join with symbols for kind-based relevance boosting
      const result =
        lastSeenId === null
          ? await db.query(
              `
                    SELECT sv2.symbol_version_id, sv2.sparse_vector, s.kind,
                           symv.range_end_line - symv.range_start_line + 1 as line_span
                    FROM semantic_vectors sv2
                    JOIN symbol_versions symv ON symv.symbol_version_id = sv2.symbol_version_id
                    JOIN symbols s ON s.symbol_id = symv.symbol_id
                    WHERE symv.snapshot_id = $1 AND sv2.view_type = 'body'
                    ORDER BY sv2.symbol_version_id
                    LIMIT $2
                `,
              [snapshotId, BATCH_SIZE],
            )
          : await db.query(
              `
                    SELECT sv2.symbol_version_id, sv2.sparse_vector, s.kind,
                           symv.range_end_line - symv.range_start_line + 1 as line_span
                    FROM semantic_vectors sv2
                    JOIN symbol_versions symv ON symv.symbol_version_id = sv2.symbol_version_id
                    JOIN symbols s ON s.symbol_id = symv.symbol_id
                    WHERE symv.snapshot_id = $1 AND sv2.view_type = 'body'
                      AND sv2.symbol_version_id > $3
                    ORDER BY sv2.symbol_version_id
                    LIMIT $2
                `,
              [snapshotId, BATCH_SIZE, lastSeenId],
            )

      if (result.rows.length === 0) break

      for (const row of result.rows) {
        const svVec = unpackSparseVector(row.sparse_vector as Buffer | null)

        let sim = cosineSimilarity(queryVector, svVec)

        // Kind-based relevance boosting (same as _scoreCandidatesByVector)
        const kind = row.kind as string
        const lineSpan = typeof row.line_span === "number" ? row.line_span : 0
        if (kind === "function" || kind === "method" || kind === "class") {
          sim *= 1.15
        } else if (kind === "interface") {
          sim *= 0.9
        } else if ((kind === "variable" || kind === "constant") && lineSpan <= 2) {
          sim *= 0.2
        }

        if (sim > 0.01) {
          topScores.push({ svId: row.symbol_version_id as string, similarity: Math.min(1.0, sim) })
        }
      }

      // Track the last seen ID for keyset cursor
      lastSeenId = result.rows[result.rows.length - 1].symbol_version_id as string

      // After each batch, trim to top-k to keep memory bounded
      if (topScores.length > limit * 2) {
        topScores.sort((a, b) => b.similarity - a.similarity)
        topScores = topScores.slice(0, limit)
      }

      // If we got fewer rows than BATCH_SIZE, we've reached the end
      hasMore = result.rows.length >= BATCH_SIZE
    }

    topScores.sort((a, b) => b.similarity - a.similarity)
    return topScores.slice(0, limit)
  }
}

export const semanticEngine = new SemanticEngine()
