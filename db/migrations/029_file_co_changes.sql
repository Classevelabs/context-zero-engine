-- Migration 029: keep file-level co-change as file pairs, and symbol pairs
-- only where the lines say so.
--
-- temporal_co_changes held symbol pairs derived from file granularity: every
-- symbol in a changed file "co-changed" with every other, capped at fifty
-- symbols per commit, so one commit touching two ordinary files produced up
-- to 1,225 symbol pairs that no line ever justified. On the local database
-- the table held 28 MB of a 285 MB total, and blast radius reported whole
-- files as a symbol's historical partners.
--
-- File-level history is exact and cheap, so it gets its own table, keyed by
-- path. Symbol-level pairs now come from git blame — the commits that last
-- touched each symbol's lines — and are written to temporal_co_changes by
-- the same code path, which clears the repository's old rows first. Rows
-- computed before this migration are file-granular and are removed here;
-- the next ingest of each repository recomputes both tables.

CREATE TABLE IF NOT EXISTS temporal_file_co_changes (
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    file_a TEXT NOT NULL,
    file_b TEXT NOT NULL,
    co_change_count INT NOT NULL DEFAULT 0,
    total_changes_a INT NOT NULL DEFAULT 0,
    total_changes_b INT NOT NULL DEFAULT 0,
    jaccard_coefficient FLOAT NOT NULL DEFAULT 0.0,
    first_co_change TIMESTAMP WITH TIME ZONE,
    last_co_change TIMESTAMP WITH TIME ZONE,
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (repo_id, file_a, file_b),
    -- Pairs are canonical by byte order of the path. The check compares under
    -- the "C" collation because the application orders the pair by bytes, and
    -- the database's default collation (a locale) orders "_" and case
    -- differently, which rejected valid pairs.
    CONSTRAINT chk_file_co_change_order CHECK (file_a COLLATE "C" < file_b COLLATE "C")
);

CREATE INDEX IF NOT EXISTS idx_file_cochange_b ON temporal_file_co_changes (repo_id, file_b);

DELETE FROM inferred_relations WHERE relation_type = 'co_changed_with';
DELETE FROM temporal_co_changes;

COMMENT ON TABLE temporal_file_co_changes IS
    'Files that change in the same commits, from git log. Symbol-level pairs live in temporal_co_changes and come from git blame.';
