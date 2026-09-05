-- Migration 025: store sparse vectors as packed binary terms instead of JSONB.
--
-- Measured on a freshly indexed 2.91 MB source tree: 98,924 stored terms
-- occupying 2,794 kB of sparse_vector, or 28.2 bytes per term. The weight in
-- each term is one number. The rest was the token — written out as a JSONB
-- object key, with a per-key entry header and a variable-width numeric beside
-- it — and those 98,924 terms were drawn from a vocabulary of just 4,930
-- distinct tokens, so the average token was spelled out twenty times across the
-- table. The index is not large because code is large; it is large because it
-- stores the same few thousand words over and over.
--
-- The packed form is six bytes per term: a 32-bit token hash and a 16-bit
-- weight, terms sorted by hash. See packSparseVector in similarity.ts.
--
-- The token itself is not stored because nothing reads it back. Every consumer
-- — cosineSimilarity, jaccardFromSparse, multiViewSimilarity — asks only
-- whether two vectors share a key, never what the key spells. A hash answers
-- that in four bytes. Two tokens colliding share a dimension, which shifts a
-- score by the weight of the rarer of them; it cannot introduce a match between
-- unrelated symbols, because a match still requires agreement across many terms
-- and across five weighted views.
--
-- Weights are L2-normalized by computeTFIDF, so they occupy (0, 1] — measured
-- min 0.0058, max 1.0 — and 16 bits resolves that to about one part in 65,535,
-- four orders of magnitude finer than any ranking decision made from it.
--
-- Sorting terms by hash is part of the format: it makes the encoding of a given
-- term set deterministic, so an unchanged symbol re-encodes byte-for-byte and
-- the delta copy in the ingestor carries it forward unchanged.
--
-- Existing rows cannot be converted in SQL — the hash lives in the application
-- — and unlike migration 023 there is no graceful degradation available, since
-- the sparse vector is the scoring data rather than an accelerator for it. So
-- the table is emptied rather than left holding vectors that would silently
-- score zero. Emptying it is the supported repair path: symbols with no vector
-- row are exactly what getUnembeddedSymbolVersionIds selects, so the next
-- ingest re-embeds them against the stored corpus.

TRUNCATE TABLE semantic_vectors;

ALTER TABLE semantic_vectors DROP COLUMN IF EXISTS sparse_vector;
ALTER TABLE semantic_vectors ADD COLUMN sparse_vector BYTEA NOT NULL DEFAULT ''::bytea;
ALTER TABLE semantic_vectors ALTER COLUMN sparse_vector DROP DEFAULT;
