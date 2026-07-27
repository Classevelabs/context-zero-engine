/**
 * Tests for the band-key encoding that replaced the lsh_bands table.
 *
 * LSH candidate retrieval used to be a join against one row per
 * (symbol_version, view, band) — 64 rows per symbol, 21 million rows on a
 * database holding 22 snapshots. Folding the band index into the band hash
 * lets a whole signature live in one INTEGER[] and turns "shares band i at
 * band i" into an array overlap.
 *
 * That substitution is only valid if the encoding preserves the matching
 * relation exactly. The property that must hold absolutely is the absence of
 * false negatives: two signatures that shared a band before must still overlap
 * now, or LSH silently loses real candidates. Extra collisions are tolerable —
 * they add a candidate that exact cosine re-scoring then discards.
 */

import { computeBandHashes, computeBandKeys, generateMinHash, LSH_ROWS_PER_BAND } from "../semantic-engine/similarity"

const MINHASH_PERMUTATIONS = 128
const EXPECTED_BANDS = MINHASH_PERMUTATIONS / LSH_ROWS_PER_BAND // 16

function sigFromTokens(tokens: string[]): number[] {
  return generateMinHash(new Set(tokens), MINHASH_PERMUTATIONS)
}

/** Do two key arrays share at least one element — the `&&` the SQL performs. */
function overlaps(a: number[], b: number[]): boolean {
  const set = new Set(a)
  return b.some((k) => set.has(k))
}

describe("computeBandKeys — shape and storage", () => {
  test("produces one key per band", () => {
    const sig = sigFromTokens(["alpha", "beta", "gamma"])
    expect(computeBandKeys(sig, LSH_ROWS_PER_BAND)).toHaveLength(EXPECTED_BANDS)
  })

  test("every key fits PostgreSQL INTEGER", () => {
    // The column is INTEGER[]; a value outside signed 32-bit would be rejected
    // at insert time, on some unlucky symbol, in production.
    for (const tokens of [["a"], ["parse", "buffer"], Array.from({ length: 200 }, (_, i) => `tok${i}`)]) {
      for (const key of computeBandKeys(sigFromTokens(tokens))) {
        expect(Number.isInteger(key)).toBe(true)
        expect(key).toBeGreaterThanOrEqual(-2147483648)
        expect(key).toBeLessThanOrEqual(2147483647)
      }
    }
  })

  test("is deterministic across calls", () => {
    const sig = sigFromTokens(["deterministic", "input", "set"])
    expect(computeBandKeys(sig)).toEqual(computeBandKeys(sig))
  })
})

describe("computeBandKeys — the property LSH depends on", () => {
  test("identical signatures overlap fully", () => {
    const sig = sigFromTokens(["read", "file", "buffer"])
    const a = computeBandKeys(sig)
    const b = computeBandKeys([...sig])
    expect(a).toEqual(b)
    expect(overlaps(a, b)).toBe(true)
  })

  test("NO FALSE NEGATIVES: sharing one band still overlaps", () => {
    // Construct two signatures that agree on exactly one band (the first 8
    // values) and differ everywhere else. Under the old table these shared a
    // (band_index, band_hash) row and were candidates; they must still be.
    const base = sigFromTokens(["shared", "prefix", "tokens"])
    const other = sigFromTokens(["completely", "different", "content", "here"])
    const hybrid = [...other]
    for (let i = 0; i < LSH_ROWS_PER_BAND; i++) hybrid[i] = base[i]!

    const baseHashes = computeBandHashes(base)
    const hybridHashes = computeBandHashes(hybrid)
    expect(hybridHashes[0]).toBe(baseHashes[0]) // precondition: band 0 matches

    expect(overlaps(computeBandKeys(base), computeBandKeys(hybrid))).toBe(true)
  })

  test("preserves positional matching: the same hash at a different band does not match", () => {
    // The whole reason the band index existed as a column. Band 0 of one
    // signature matching band 5 of another is meaningless for LSH, and folding
    // the index into the value has to keep it meaningless.
    const sig = sigFromTokens(["positional", "sensitivity", "matters"])
    const keys = computeBandKeys(sig)
    const hashes = computeBandHashes(sig)

    // Same underlying hash, different position => different key.
    const shifted = [...sig]
    for (let i = 0; i < LSH_ROWS_PER_BAND; i++) {
      shifted[LSH_ROWS_PER_BAND + i] = sig[i]!
    }
    const shiftedHashes = computeBandHashes(shifted)
    const shiftedKeys = computeBandKeys(shifted)

    // band 1 of `shifted` now hashes the same as band 0 of `sig` ...
    expect(shiftedHashes[1]).toBe(hashes[0])
    // ... but carries a different key, so it cannot cross-match.
    expect(shiftedKeys[1]).not.toBe(keys[0])
  })

  test("unrelated content does not overlap", () => {
    const a = computeBandKeys(sigFromTokens(["database", "connection", "pool", "postgres"]))
    const b = computeBandKeys(sigFromTokens(["render", "canvas", "sprite", "animation"]))
    expect(overlaps(a, b)).toBe(false)
  })

  test("distinct bands within one signature get distinct keys", () => {
    // A signature whose own keys collided would waste positions in the index.
    const keys = computeBandKeys(sigFromTokens(Array.from({ length: 120 }, (_, i) => `token_${i}`)))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("computeBandKeys — equivalence with the retired row-per-band scheme", () => {
  test("overlap agrees with the old (band_index, band_hash) tuple match on random pairs", () => {
    // Exhaustive agreement check: for many signature pairs, the array-overlap
    // answer must equal what a tuple join over (band_index, band_hash) gave.
    const vocab = ["read", "write", "parse", "render", "hash", "cache", "query", "flush", "encode", "decode"]
    const sigs: number[][] = []
    for (let i = 0; i < 40; i++) {
      const tokens = vocab.filter((_, j) => (i >> j % vocab.length) % 2 === 0).concat([`salt${i % 7}`])
      sigs.push(sigFromTokens(tokens.length ? tokens : ["fallback"]))
    }

    let compared = 0
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        const hi = computeBandHashes(sigs[i]!)
        const hj = computeBandHashes(sigs[j]!)
        // Old semantics: candidates iff some band index has an equal hash.
        const oldMatch = hi.some((h, idx) => h === hj[idx])
        const newMatch = overlaps(computeBandKeys(sigs[i]!), computeBandKeys(sigs[j]!))
        expect(newMatch).toBe(oldMatch)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(700)
  })
})
