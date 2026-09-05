/**
 * ContextZero — Native Similarity Engine
 *
 * TF-IDF sparse vectors + MinHash signatures + Cosine similarity.
 * No external dependencies. Pure math.
 *
 * MinHash uses 128 random hash permutations for LSH candidate generation.
 * TF-IDF uses log-normalized term frequency with smooth IDF.
 */

/**
 * Sparse vector: maps token -> TF-IDF score.
 * After L2 normalization, the dot product of two sparse vectors equals cosine similarity.
 */
export type SparseVector = Record<string, number>

// --------------------------------------------------------------------------
// Hash function: FNV-1a 32-bit — fast, deterministic, no dependencies
// --------------------------------------------------------------------------

function fnv1a(input: string): number {
  let hash = 0x811c9dc5 // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // FNV prime: multiply by 16777619, keep within 32-bit unsigned range
    hash = Math.imul(hash, 0x01000193)
  }
  // Convert to unsigned 32-bit
  return hash >>> 0
}

// --------------------------------------------------------------------------
// MinHash permutation coefficients — deterministic from a fixed seed
// --------------------------------------------------------------------------

const LARGE_PRIME = 4294967291 // Largest prime < 2^32
const LARGE_PRIME_BIG = BigInt(LARGE_PRIME)
const MAX_PERMUTATIONS = 256

/**
 * Pre-computed permutation coefficients for MinHash.
 * Each permutation is defined by h_i(x) = (a_i * hash(x) + b_i) % LARGE_PRIME.
 * Coefficients are derived deterministically from a seed using a simple LCG.
 *
 * Stored as BigInt to prevent overflow in permutation computation:
 * a and h can each be up to ~2^32, so a*h can reach ~2^64, which exceeds
 * Number.MAX_SAFE_INTEGER (2^53). BigInt handles arbitrary precision.
 */
const PERM_A: bigint[] = []
const PERM_B: bigint[] = []

;(function initPermutations(): void {
  // Simple LCG for deterministic coefficient generation
  // seed = 42 (the answer to everything)
  let state = 42
  function nextRand(): number {
    // LCG: state = (state * 1664525 + 1013904223) mod 2^32
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }

  for (let i = 0; i < MAX_PERMUTATIONS; i++) {
    // a must be non-zero
    let a = nextRand() % (LARGE_PRIME - 1)
    if (a === 0) a = 1
    const b = nextRand() % LARGE_PRIME
    PERM_A.push(BigInt(a))
    PERM_B.push(BigInt(b))
  }
})()

// --------------------------------------------------------------------------
// TF-IDF functions
// --------------------------------------------------------------------------

/**
 * Compute log-normalized term frequency.
 * TF(t) = 1 + log(count(t)) for each token t in the document.
 */
export function computeTF(tokens: string[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  for (const token of tokens) {
    if (typeof token !== "string" || token.length === 0) continue
    counts[token] = (counts[token] ?? 0) + 1
  }

  const tf: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [token, count] of Object.entries(counts)) {
    tf[token] = 1 + Math.log(count)
  }
  return tf
}

/**
 * Compute smooth inverse document frequency.
 * IDF(t) = log(1 + totalDocs / (1 + docFreq(t)))
 *
 * @param documentTokenSets Array of token sets, one per document
 * @param totalDocs Total number of documents in the corpus
 */
export function computeIDF(documentTokenSets: Set<string>[], totalDocs: number): Record<string, number> {
  // Guard: no documents → no IDF scores
  if (!Number.isFinite(totalDocs) || totalDocs <= 0) return {}

  // Count how many documents contain each token
  const docFreq: Record<string, number> = Object.create(null) as Record<string, number>
  for (const tokenSet of documentTokenSets) {
    for (const token of tokenSet) {
      docFreq[token] = (docFreq[token] || 0) + 1
    }
  }

  const idf: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [token, freq] of Object.entries(docFreq)) {
    idf[token] = Math.log(1 + totalDocs / (1 + freq))
  }
  return idf
}

/**
 * Compute TF-IDF sparse vector, then L2-normalize the result.
 * If a token has no IDF entry, it is assigned a default IDF of 1.0.
 */
export function computeTFIDF(tf: Record<string, number>, idf: Record<string, number>): SparseVector {
  const raw: SparseVector = Object.create(null) as SparseVector

  for (const [token, tfValue] of Object.entries(tf)) {
    const idfValue = idf[token] ?? 1.0
    if (!Number.isFinite(tfValue) || tfValue < 0 || !Number.isFinite(idfValue) || idfValue < 0) continue
    raw[token] = tfValue * idfValue
  }

  // L2 normalize
  let magnitude = 0
  for (const value of Object.values(raw)) {
    magnitude += value * value
  }
  magnitude = Math.sqrt(magnitude)

  if (magnitude < 1e-10) {
    return raw
  }

  const normalized: SparseVector = Object.create(null) as SparseVector
  for (const [token, value] of Object.entries(raw)) {
    normalized[token] = value / magnitude
  }

  return normalized
}

// --------------------------------------------------------------------------
// Cosine similarity
// --------------------------------------------------------------------------

/**
 * Compute cosine similarity between two L2-normalized sparse vectors.
 * Since vectors are L2-normalized, dot product = cosine similarity.
 */
export function cosineSimilarity(a: SparseVector, b: SparseVector): number {
  // Iterate over the smaller vector for efficiency
  let dotProduct = 0
  const [smaller, larger] = Object.keys(a).length <= Object.keys(b).length ? [a, b] : [b, a]

  for (const [token, valueA] of Object.entries(smaller)) {
    const valueB = larger[token]
    if (Number.isFinite(valueA) && valueB !== undefined && Number.isFinite(valueB)) {
      dotProduct += valueA * valueB
    }
  }

  // Clamp to [0, 1] to handle floating-point noise
  return Number.isFinite(dotProduct) ? Math.max(0, Math.min(1, dotProduct)) : 0
}

// --------------------------------------------------------------------------
// MinHash
// --------------------------------------------------------------------------

/**
 * Generate a MinHash signature for a set of tokens.
 *
 * For each permutation i, computes:
 *   h_i(x) = (PERM_A[i] * fnv1a(x) + PERM_B[i]) % LARGE_PRIME
 * and takes the minimum across all tokens x in the set.
 *
 * Uses BigInt arithmetic to prevent overflow: a and h can each be up to ~2^32,
 * so a*h can reach ~2^64, which exceeds Number.MAX_SAFE_INTEGER (2^53).
 *
 * @param tokens Set of tokens to hash
 * @param numPermutations Number of hash permutations (default 128, max 256)
 * @returns Array of minimum hash values, one per permutation
 */
export function generateMinHash(tokens: Set<string>, numPermutations: number = 128): number[] {
  const requested = Number.isFinite(numPermutations) ? Math.trunc(numPermutations) : 128
  const nPerms = Math.max(1, Math.min(requested, MAX_PERMUTATIONS))
  const signature: number[] = new Array(nPerms).fill(0xffffffff)

  if (tokens.size === 0) {
    return signature
  }

  // Pre-hash all tokens once, store as BigInt for safe arithmetic
  const tokenHashes: bigint[] = []
  for (const token of tokens) {
    tokenHashes.push(BigInt(fnv1a(token)))
  }

  for (let i = 0; i < nPerms; i++) {
    const a = PERM_A[i]!
    const b = PERM_B[i]!
    let minHash = 0xffffffff

    for (const h of tokenHashes) {
      // h_i(x) = (a * hash(x) + b) % LARGE_PRIME
      // BigInt arithmetic prevents overflow when a*h exceeds 2^53
      const permuted = Number((a * h + b) % LARGE_PRIME_BIG)
      if (permuted < minHash) {
        minHash = permuted
      }
    }

    signature[i] = minHash
  }

  return signature
}

/**
 * Estimate Jaccard similarity from two MinHash signatures.
 * Counts the fraction of matching positions.
 */
export function estimateJaccardFromMinHash(sigA: number[], sigB: number[]): number {
  const length = Math.min(sigA.length, sigB.length)
  if (length === 0) return 0

  // Empty token sets produce all-0xFFFFFFFF signatures (sentinel).
  // Two empty sets matching is a sentinel collision, not real similarity.
  const EMPTY_SENTINEL = 0xffffffff
  const aIsEmpty = sigA.every((v) => v === EMPTY_SENTINEL)
  const bIsEmpty = sigB.every((v) => v === EMPTY_SENTINEL)
  if (aIsEmpty || bIsEmpty) return 0

  let matches = 0
  for (let i = 0; i < length; i++) {
    if (sigA[i] === sigB[i]) {
      matches++
    }
  }

  return matches / length
}

// --------------------------------------------------------------------------
// Sparse vector storage encoding
// --------------------------------------------------------------------------

/**
 * Bytes per stored term: a 32-bit token hash and a 16-bit quantized weight.
 *
 * As JSONB a sparse vector cost 28.2 bytes per term, measured across 98,924
 * terms. Almost none of that was the number: it was the token spelled out as an
 * object key, plus JSONB's per-key entry header and a variable-width numeric.
 * The same 98,924 terms drew on a vocabulary of 4,930 distinct tokens, so every
 * token was written out roughly twenty times over.
 *
 * Nothing downstream reads a token back. cosineSimilarity and jaccardFromSparse
 * ask only whether two vectors share a key, so the key can be any stable
 * identity — and a hash is a smaller one than the word. A collision merges two
 * rare terms into one dimension, which perturbs a score by the weight of the
 * rarer term and cannot make an unrelated symbol match.
 */
const TERM_BYTES = 6

/** Weights are L2-normalized into (0, 1], so 16 bits spans the whole range. */
const WEIGHT_SCALE = 0xffff

/**
 * Encode a sparse vector for storage: terms sorted by token hash, each written
 * as a big-endian uint32 hash followed by a uint16 weight.
 *
 * Sorted order is part of the format — it makes two stored vectors mergeable in
 * a single linear pass, and it makes the bytes deterministic for a given term
 * set, so an unchanged symbol re-encodes to an identical value.
 */
export function packSparseVector(vector: SparseVector): Buffer {
  // Collisions inside one vector mean two tokens landed on one dimension; their
  // weights belong to that dimension jointly.
  const byHash = new Map<number, number>()
  for (const [token, weight] of Object.entries(vector)) {
    if (!Number.isFinite(weight) || weight <= 0) continue
    const hash = fnv1a(token)
    byHash.set(hash, (byHash.get(hash) ?? 0) + weight)
  }

  const hashes = Array.from(byHash.keys()).sort((a, b) => a - b)
  const packed = Buffer.allocUnsafe(hashes.length * TERM_BYTES)
  let offset = 0
  for (const hash of hashes) {
    // Clamp to 1: a term that rounds to zero is still a term the key set
    // contains, and Jaccard is answered from the key set.
    const quantized = Math.max(1, Math.min(WEIGHT_SCALE, Math.round(byHash.get(hash)! * WEIGHT_SCALE)))
    packed.writeUInt32BE(hash, offset)
    packed.writeUInt16BE(quantized, offset + 4)
    offset += TERM_BYTES
  }
  return packed
}

/**
 * Decode a stored sparse vector. Keys are token hashes rendered in decimal, so
 * the result is the same shape every scoring function already consumes — two
 * decoded vectors agree on a key exactly when they shared a token.
 *
 * A query vector built from text must be put through `hashSparseKeys` before it
 * is compared against one of these.
 */
export function unpackSparseVector(stored: Buffer | Uint8Array | null | undefined): SparseVector {
  const vector: SparseVector = Object.create(null) as SparseVector
  if (!stored || stored.length < TERM_BYTES) return vector
  const view = Buffer.isBuffer(stored) ? stored : Buffer.from(stored)
  const terms = Math.floor(view.length / TERM_BYTES)
  for (let i = 0; i < terms; i++) {
    const offset = i * TERM_BYTES
    vector[String(view.readUInt32BE(offset))] = view.readUInt16BE(offset + 4) / WEIGHT_SCALE
  }
  return vector
}

/**
 * Re-key a token-keyed vector onto the hashes used in storage, so a freshly
 * tokenized query can be compared against decoded vectors.
 */
export function hashSparseKeys(vector: SparseVector): SparseVector {
  const hashed: SparseVector = Object.create(null) as SparseVector
  for (const [token, weight] of Object.entries(vector)) {
    const key = String(fnv1a(token))
    hashed[key] = (hashed[key] ?? 0) + weight
  }
  return hashed
}

/**
 * The distinct token hashes of a document, as signed 32-bit integers.
 *
 * This is the inverted-index key set: two documents can only have nonzero
 * cosine similarity if their token-hash sets overlap, so an index over this
 * array answers "which symbols could possibly match this query" directly,
 * without the linear scan that decodes every stored vector.
 *
 * `| 0` maps the unsigned FNV hash into PostgreSQL's signed int4 range, the
 * same coercion computeBandKeys uses, so the values live in an INTEGER[].
 */
export function tokenHashesInt32(tokens: Iterable<string>): number[] {
  const seen = new Set<number>()
  for (const token of tokens) seen.add(fnv1a(token) | 0)
  return [...seen]
}

/**
 * The most distinctive token hashes of an already-hashed query vector, for
 * probing the inverted index.
 *
 * A query vector is keyed by unsigned-hash strings (see hashSparseKeys) and
 * weighted by TF-IDF, so the highest weights are the rarest, most selective
 * terms. Probing with those rather than every term keeps a query like
 * "get the value" from dragging in every symbol that merely contains "get":
 * a near-ubiquitous token carries an IDF near zero, contributes almost nothing
 * to cosine, and so dropping it from the probe changes ranking negligibly while
 * removing the term that would otherwise blow the candidate set up to the whole
 * table. `keep` bounds the probe width for pathologically long queries.
 */
export function distinctiveQueryHashes(hashedVector: SparseVector, keep = 32): number[] {
  const entries = Object.entries(hashedVector)
  if (entries.length === 0) return []
  entries.sort((a, b) => b[1] - a[1])
  const kept = entries.length > keep ? entries.slice(0, keep) : entries
  return kept.map(([key]) => Number(key) | 0)
}

/**
 * Smallest token set that earns a stored MinHash signature.
 *
 * A signature over a set of size k holds at most k distinct values, so below
 * this width the estimator is mostly reporting sentinel collisions rather than
 * similarity. The sparse vector is already persisted and its key set is the
 * exact token set, so `jaccardFromSparse` answers the same question exactly,
 * for less work and no stored bytes. Ingest leaves `minhash_signature` NULL
 * under this threshold and every read path falls back to the exact form.
 */
export const MINHASH_MIN_TOKENS = 8

/** Bytes per packed permutation — MinHash values are 32-bit by construction. */
const MINHASH_BYTES_PER_PERM = 4

/**
 * Pack a signature into big-endian uint32s for storage.
 *
 * `bigint[]` cost 8 bytes per element plus ~24 bytes of array header, for
 * values that never exceed 0xFFFFFFFF. A fixed-width bytea halves the payload
 * and removes the per-element varlena bookkeeping.
 */
export function packMinHash(signature: number[]): Buffer {
  const packed = Buffer.allocUnsafe(signature.length * MINHASH_BYTES_PER_PERM)
  for (let i = 0; i < signature.length; i++) {
    packed.writeUInt32BE(signature[i]! >>> 0, i * MINHASH_BYTES_PER_PERM)
  }
  return packed
}

/**
 * Unpack a stored signature. Returns null for the NULL column written below
 * MINHASH_MIN_TOKENS, so callers can branch to the exact path.
 */
export function unpackMinHash(stored: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!stored || stored.length < MINHASH_BYTES_PER_PERM) return null
  const view = Buffer.isBuffer(stored) ? stored : Buffer.from(stored)
  const count = Math.floor(view.length / MINHASH_BYTES_PER_PERM)
  const signature: number[] = new Array(count)
  for (let i = 0; i < count; i++) {
    signature[i] = view.readUInt32BE(i * MINHASH_BYTES_PER_PERM)
  }
  return signature
}

/**
 * Exact Jaccard over two sparse vectors' key sets.
 *
 * The keys of a sparse vector are precisely the tokens that produced it, so
 * this is the ground truth that `estimateJaccardFromMinHash` approximates.
 * Used whenever either side stored no signature.
 */
export function jaccardFromSparse(a: SparseVector, b: SparseVector): number {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length === 0 || bKeys.length === 0) return 0

  // Probe the smaller set against the larger one.
  const [small, large] = aKeys.length <= bKeys.length ? [aKeys, b] : [bKeys, a]
  let intersection = 0
  for (const key of small) {
    if (Object.prototype.hasOwnProperty.call(large, key)) intersection++
  }

  const union = aKeys.length + bKeys.length - intersection
  return union === 0 ? 0 : intersection / union
}

// --------------------------------------------------------------------------
// LSH Banding — Locality-Sensitive Hashing for sub-linear candidate retrieval
// --------------------------------------------------------------------------

/** Number of consecutive MinHash rows per LSH band */
export const LSH_ROWS_PER_BAND = 8

/**
 * Compute LSH band hashes from a MinHash signature.
 *
 * Splits the signature into bands of `rowsPerBand` consecutive values.
 * Each band is hashed using FNV-1a over the raw 32-bit integer bytes,
 * producing a single 32-bit hash per band.
 *
 * With 128 permutations and rowsPerBand=8, this yields 16 bands.
 * Two signatures sharing at least one identical band are LSH candidates.
 *
 * @param signature MinHash signature array (e.g., length 128)
 * @param rowsPerBand Number of consecutive MinHash values per band (default: LSH_ROWS_PER_BAND)
 * @returns Array of band hash integers (length = floor(signature.length / rowsPerBand))
 */
export function computeBandHashes(signature: number[], rowsPerBand: number = LSH_ROWS_PER_BAND): number[] {
  if (signature.length === 0) return []
  const requestedRows = Number.isFinite(rowsPerBand) ? Math.trunc(rowsPerBand) : LSH_ROWS_PER_BAND
  const safeRowsPerBand = Math.max(1, Math.min(requestedRows, signature.length))
  const numBands = Math.floor(signature.length / safeRowsPerBand)
  const bandHashes: number[] = new Array(numBands)

  for (let band = 0; band < numBands; band++) {
    const offset = band * safeRowsPerBand

    // FNV-1a over the raw bytes of R consecutive 32-bit integers
    let hash = 0x811c9dc5 // FNV offset basis

    for (let r = 0; r < safeRowsPerBand; r++) {
      const value = signature[offset + r]!

      // Process each of the 4 bytes of the 32-bit integer (little-endian)
      hash ^= value & 0xff
      hash = Math.imul(hash, 0x01000193)

      hash ^= (value >>> 8) & 0xff
      hash = Math.imul(hash, 0x01000193)

      hash ^= (value >>> 16) & 0xff
      hash = Math.imul(hash, 0x01000193)

      hash ^= (value >>> 24) & 0xff
      hash = Math.imul(hash, 0x01000193)
    }

    // Convert to signed 32-bit integer for PostgreSQL INTEGER column compatibility
    bandHashes[band] = hash | 0
  }

  return bandHashes
}

/**
 * Fold a band's position into its hash, yielding one self-describing key.
 *
 * LSH requires band *i* of one signature to match band *i* of another — band 3
 * matching band 7 means nothing. That positional pairing used to be expressed
 * as a row per band, `(symbol_version_id, view_type, band_index, band_hash)`,
 * which cost 16 rows per symbol-view and turned candidate lookup into a join
 * against a table that grew to tens of millions of rows.
 *
 * Mixing the index into the hash carries the same information in a single
 * value, so a signature becomes one array and "shares a band" becomes an array
 * overlap that GIN answers directly.
 *
 * The mix multiplies the index by the 32-bit golden-ratio constant before
 * xoring, which decorrelates adjacent indices instead of merely offsetting
 * them. Two properties matter, and only one of them has to be exact:
 *
 *   - Determinism (required): identical (index, hash) pairs always produce
 *     identical keys, so LSH never loses a true candidate.
 *   - Distinctness (best-effort): distinct pairs collide with probability
 *     ~2^-32. A collision admits one extra candidate, which the exact cosine
 *     re-scoring downstream then discards. False positives cost a little work;
 *     false negatives would cost correctness, and cannot occur.
 */
export function computeBandKeys(signature: number[], rowsPerBand: number = LSH_ROWS_PER_BAND): number[] {
  const bandHashes = computeBandHashes(signature, rowsPerBand)
  const keys: number[] = new Array(bandHashes.length)
  for (let i = 0; i < bandHashes.length; i++) {
    keys[i] = (bandHashes[i]! ^ Math.imul(i + 1, 0x9e3779b1)) | 0
  }
  return keys
}

// --------------------------------------------------------------------------
// Multi-view similarity
// --------------------------------------------------------------------------

/**
 * Compute weighted combination of per-view cosine similarities.
 *
 * Only views present in BOTH symbols contribute to the score. This prevents
 * artificially deflated scores when one symbol has fewer views than the other
 * (e.g., a Ruby function with no type annotations vs. a TypeScript function
 * with full types). Missing views are excluded from both numerator AND denominator.
 *
 * @param viewsA Map of view_type -> sparse vector for symbol A
 * @param viewsB Map of view_type -> sparse vector for symbol B
 * @param weights Record of view_type -> weight (should sum to ~1.0 for interpretability)
 * @returns Weighted similarity score in [0, 1]
 */
export function multiViewSimilarity(
  viewsA: Map<string, SparseVector>,
  viewsB: Map<string, SparseVector>,
  weights: Record<string, number>,
): number {
  let totalSimilarity = 0
  let activeWeight = 0

  for (const [viewType, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight <= 0) continue
    const vecA = viewsA.get(viewType)
    const vecB = viewsB.get(viewType)

    // Only count views present in BOTH symbols
    if (vecA && vecB) {
      activeWeight += weight
      totalSimilarity += weight * cosineSimilarity(vecA, vecB)
    }
  }

  // Normalize by weight of views that were actually compared
  if (activeWeight === 0 || !isFinite(activeWeight)) return 0
  const similarity = totalSimilarity / activeWeight
  return Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0
}
