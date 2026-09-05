-- Migration 026: give semantic search a real inverted index.
--
-- Measured on REX (18.9 MB, 22k symbols): scg_semantic_search ran at 583ms p50,
-- and idx_semantic_vectors_band_keys — the largest index in the database at
-- 11.8 MB — showed 0 scans. The two facts are the same fact.
--
-- Search was built on the LSH band index, but LSH answers "is this document a
-- near-duplicate of that one", not "which documents contain these query terms".
-- A search query is a handful of tokens; a body is dozens. Their MinHash
-- signatures collide only when the sets are ~50% shared, so a 2-token query
-- against a 70-token body produced Jaccard ~0.03, zero band collisions, and the
-- query fell through every time to a linear scan that decoded every body vector
-- in the snapshot. The band index was maintained on every write and read by
-- nothing.
--
-- The correct structure is an inverted index: the set of token hashes each body
-- contains. Cosine similarity is a sum over shared terms, so a symbol sharing no
-- query term scores exactly zero — which means "symbols whose token-hash set
-- overlaps the query's" is not an approximation of the candidate set, it is
-- exactly the set of symbols that can score above zero. GIN over the array
-- answers `token_hashes && query` the same way the band index answered
-- `band_keys && query`, so the retrieval path and its NULL-fallback are already
-- proven by migration 019.
--
-- Only the body view carries this. Search tokenizes against the body view
-- alone; the four narrow views (name/signature/behavior/contract) are never the
-- search target, so indexing them would re-add storage this line of work spent
-- three migrations removing. token_hashes is derived from the same tokens as
-- sparse_vector, so re-ingesting a snapshot repopulates it, and rows written
-- before this migration read back NULL and take the existing linear fallback.

ALTER TABLE semantic_vectors ADD COLUMN IF NOT EXISTS token_hashes INTEGER[];

-- Partial index: only body rows ever hold token_hashes, so the index has no
-- reason to carry an entry for the other four views.
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_token_hashes
    ON semantic_vectors USING GIN (token_hashes)
    WHERE view_type = 'body';
