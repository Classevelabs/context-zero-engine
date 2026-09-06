-- Migration 033: keep each symbol version's blame result.
--
-- The temporal pass blames every file of every snapshot: 1.7 s of a 5.8 s
-- one-file incremental ingest of gin went to re-blaming 98 files whose
-- content had not changed. Blame attributes each line to the commit that
-- last changed it, so a file with the same content as in the parent snapshot
-- has the same attribution, and its symbols' commit sets can be carried
-- forward. This table holds those sets, one row per symbol version, and goes
-- with the version when it is deleted.

CREATE TABLE IF NOT EXISTS symbol_history (
    symbol_version_id UUID PRIMARY KEY REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    commit_shas TEXT[] NOT NULL
);

COMMENT ON TABLE symbol_history IS
    'Commits that last touched a symbol version''s lines, from git blame; carried forward to the next snapshot while the file is unchanged.';
