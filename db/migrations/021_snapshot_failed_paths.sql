-- Migration 021: Record WHICH files failed extraction, not just how many.
--
-- `index_status = 'partial'` told a reader that the graph was incomplete but
-- never which part of it was missing, so the only honest response to any empty
-- result was to distrust the whole repository. The failing paths existed in the
-- ingestion result's `failure_summary`, but that value was returned once to the
-- caller and then discarded — nothing persisted it, so after the run finished
-- the question "what is missing from my index?" had no answer at all.
--
-- Storing the paths turns a blanket "results may be incomplete" warning into a
-- checkable claim: a caller can see whether the files it cares about are among
-- the unindexed ones, and re-index exactly those instead of the whole repo.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Existing rows default to the empty
-- array, which reads as "no known failures" — correct for snapshots ingested
-- before this column existed, whose failing paths are genuinely unrecoverable.

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS failed_paths TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN snapshots.failed_paths IS
    'Repository-relative paths whose extraction failed during the most recent '
    'indexing pass of this snapshot. Empty means no known failures. Kept in '
    'sync by both full and incremental ingestion: a path that parses cleanly on '
    'a later pass is removed, so index_status can recover to ''complete''.';
