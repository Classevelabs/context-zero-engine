-- Migration 019: collapse LSH bands onto semantic_vectors as an array.
--
-- lsh_bands stored one row per (symbol_version, view, band): 16 rows per
-- symbol-view, 64 per symbol. Measured on a database holding 22 snapshots and
-- 266,818 symbol versions, that table reached 21,246,299 rows / 2,919 MB, with
-- a 1,234 MB primary key and a 451 MB lookup index.
--
-- The cost was not storage, it was write latency. Every band row carried an
-- ON CONFLICT probe into that multi-gigabyte B-tree, so ingestion slowed as the
-- database grew. Ingesting the same 235-file repository took 13.5s of database
-- flush time on an empty database and 136.2s on the loaded one — the identical
-- work, 10.1x slower, purely from accumulated index size.
--
-- semantic_vectors already holds exactly one row per (symbol_version, view),
-- which is precisely the grain a band array needs. Folding the band index into
-- the band hash (see computeBandKeys) turns "shares band i" into "arrays
-- overlap", which GIN answers directly. The separate table becomes redundant:
-- 64 rows per symbol become 0.
--
-- Band data is derived from minhash_signature, which is stored, so dropping the
-- table loses nothing recoverable. Snapshots indexed before this migration have
-- band_keys NULL and fall through to the linear candidate scan that already
-- exists for un-embedded snapshots; re-ingesting repopulates them.

ALTER TABLE semantic_vectors ADD COLUMN IF NOT EXISTS band_keys INTEGER[];

-- GIN over the array answers `band_keys && ARRAY[...]` — the overlap operator
-- the candidate lookup now issues — without scanning the table.
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_band_keys
    ON semantic_vectors USING GIN (band_keys);

DROP TABLE IF EXISTS lsh_bands;
