-- Migration 022: Track deferred snapshot-wide refinement.
--
-- An incremental re-index re-extracts only the files that changed, but every
-- derived-analysis engine behind it — dispatch resolution, symbol lineage,
-- effect signatures, deep contracts, concept families, the embedding corpus —
-- recomputes across the ENTIRE snapshot. Editing one file therefore cost minutes
-- of work on tens of thousands of untouched symbols, which is why nothing ever
-- called incremental indexing on the edit path and graphs simply went stale.
--
-- The fast path skips those snapshot-wide passes and refreshes only what the
-- changed symbols need. That is a real tradeoff — repository-wide analyses drift
-- until a full pass runs — and this column exists so the tradeoff is never
-- silent. It records when refinement was first deferred, so staleness is visible
-- and answerable rather than assumed.
--
-- NULL means nothing is owed: the snapshot's derived analyses are current as of
-- its last full pass.

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS refinement_pending_since TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN snapshots.refinement_pending_since IS
    'When snapshot-wide refinement was first deferred by a fast incremental pass. '
    'NULL means no refinement is owed. Cleared by any full ingest or by an '
    'incremental pass run with refine=full. Repository-wide analyses (lineage, '
    'concept families, dispatch, effect propagation, IDF weighting) may be stale '
    'while this is set; per-symbol data for changed files is always current.';
