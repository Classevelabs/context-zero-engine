-- Migration 023: store MinHash signatures as packed bytea, and only where they
-- carry signal.
--
-- Measured on a database holding 20 snapshots and 584,411 symbol versions,
-- semantic_vectors reached 2,914,430 rows / 5,857 MB. The sparse vectors that
-- do the actual scoring accounted for 403 MB of that. The minhash_signature
-- column accounted for 2,928 MB.
--
-- Two separate defects produced that number.
--
-- First, representation. A signature is 128 values that are 32-bit by
-- construction (generateMinHash caps at 0xFFFFFFFF). Stored as bigint[] each
-- one cost 8 bytes plus array overhead — 1,048 bytes for 512 bytes of data.
--
-- Second, and larger: the signature was stored for every view regardless of
-- how many tokens the view produced. Per-view averages on that database:
--
--     view       avg tokens   sparse_vector   minhash_signature
--     behavior            0          6.5 MB              590 MB
--     contract            1           19 MB              590 MB
--     name                2           45 MB              590 MB
--     signature           5           81 MB              590 MB
--     body               49          252 MB              568 MB
--
-- A signature over a k-token set holds at most k distinct values, so the four
-- narrow views were spending 2,360 MB to describe sets that the sparse vector
-- already describes exactly. For behavior the stored bytes were literally the
-- all-0xFFFFFFFF empty sentinel, 590 MB of one repeated constant.
--
-- The narrow views also poisoned candidate generation. band_keys are derived
-- from the signature, so a one-token contract view yields band keys determined
-- entirely by that single token: every symbol sharing it lands in the same GIN
-- bucket, and the overlap probe walks a bucket holding a large fraction of the
-- table before MAX_LSH_CANDIDATES truncates it.
--
-- Both are fixed by one rule, MINHASH_MIN_TOKENS in similarity.ts: a view
-- narrower than the threshold stores neither a signature nor band keys, and
-- comparisons against it use jaccardFromSparse — the exact Jaccard over the
-- sparse vector's key set, which is the value the signature was estimating.
-- The fallback is cheaper and strictly more accurate than the estimate it
-- replaces; only the wide views keep LSH, which is where LSH pays.
--
-- Signatures are derived from stored token data, so converting by drop-and-add
-- loses nothing recoverable. Rows written before this migration read back NULL
-- and take the exact path, exactly as migration 019 left pre-019 rows taking
-- the linear candidate scan. Re-ingesting repopulates them in packed form.

ALTER TABLE semantic_vectors DROP COLUMN IF EXISTS minhash_signature;
ALTER TABLE semantic_vectors ADD COLUMN IF NOT EXISTS minhash_signature BYTEA;

-- The surrogate primary key was never read: (symbol_version_id, view_type) is
-- the natural key and already carries a unique index, which every query used.
-- On the measured database semantic_vectors_pkey held 143 MB at 0 scans.
ALTER TABLE semantic_vectors DROP CONSTRAINT IF EXISTS semantic_vectors_pkey;
ALTER TABLE semantic_vectors DROP COLUMN IF EXISTS vector_id;
ALTER TABLE semantic_vectors DROP CONSTRAINT IF EXISTS semantic_vectors_symbol_version_id_view_type_key;
ALTER TABLE semantic_vectors ADD PRIMARY KEY (symbol_version_id, view_type);

-- Redundant once the natural key is the primary key: idx_semantic_vectors_sv
-- was a prefix of it, and the planner has no reason to prefer the narrower one.
DROP INDEX IF EXISTS idx_semantic_vectors_sv;
