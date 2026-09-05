-- Migration 024: give the hash indexes the shape their queries ask for, drop
-- the ones no query can use, and let autovacuum keep up with the large tables.
--
-- Measured on a database holding 20 snapshots and 584,411 symbol versions:
-- 1,868 MB of indexes, of which 424 MB had never been scanned once.
--
-- ── Shape ──────────────────────────────────────────────────────────────────
--
-- Three of those unused indexes were the homolog engine's dedup buckets:
-- idx_sv_body_hash, idx_sv_ast_hash and idx_sv_normalized_ast_hash, 13 MB
-- each. They were not unused because nothing looks up a hash. They were unused
-- because every lookup that does is snapshot-scoped:
--
--     WHERE sv.snapshot_id = $1 AND sv.body_hash = $2
--
-- Against a single-column hash index the planner must either scan it and then
-- re-check snapshot_id per row, or use idx_sv_snapshot_kind and re-check the
-- hash. It consistently chose the latter, so 39 MB of index was maintained on
-- every insert and read by nothing. Leading with snapshot_id makes each one an
-- exact match for the query, which is also the selective order: a hash is
-- unique within a snapshot, so the probe lands on one tuple.
--
-- ── Genuinely unused ───────────────────────────────────────────────────────
--
-- idx_bp_purity_class indexed a column that only ever appears on the left of an
-- assignment (behavioral.ts sets it; nothing filters on it), so no query could
-- use it in any shape. 7,472 MB-scale on the measured database.
--
-- idx_lineage_kind is (repo_id, kind), and symbol_lineage is never filtered by
-- kind. Its only usable form was the repo_id prefix, which idx_lineage_canonical
-- already provides from the same leading column — two indexes competing for one
-- access path, both unscanned. The narrower duplicate goes.
--
-- Indexes that merely looked unused are kept: idx_symbols_canonical_name_trgm
-- backs similarity(canonical_name, $2) in the homolog engine's name bucket, and
-- the surrogate primary keys on structural_relations, inferred_relations,
-- invariants and test_artifacts are returned to callers as identifiers and
-- looked up by id elsewhere. Scan counts alone do not justify a drop.

DROP INDEX IF EXISTS idx_sv_body_hash;
DROP INDEX IF EXISTS idx_sv_ast_hash;
DROP INDEX IF EXISTS idx_sv_normalized_ast_hash;

CREATE INDEX IF NOT EXISTS idx_sv_snapshot_body_hash
    ON symbol_versions (snapshot_id, body_hash);
CREATE INDEX IF NOT EXISTS idx_sv_snapshot_ast_hash
    ON symbol_versions (snapshot_id, ast_hash);
CREATE INDEX IF NOT EXISTS idx_sv_snapshot_normalized_ast_hash
    ON symbol_versions (snapshot_id, normalized_ast_hash);

DROP INDEX IF EXISTS idx_bp_purity_class;
DROP INDEX IF EXISTS idx_lineage_kind;

-- ── Vacuum ─────────────────────────────────────────────────────────────────
--
-- Autovacuum triggers at autovacuum_vacuum_scale_factor (0.2) of a table plus a
-- threshold. On a table of 2.9 million rows that is 580,000 dead tuples before
-- the first pass, and re-ingestion replaces whole snapshots at a time, so the
-- measured database was carrying 78,244 dead tuples on symbol_versions and
-- 65,920 on semantic_vectors with no pass in sight. Dead tuples are not just
-- wasted pages: every index scan walks them and discards them.
--
-- A percentage is the wrong control for tables whose size varies by three
-- orders of magnitude between a small repository and a monorepo. These settings
-- make the trigger effectively a fixed row count, so a table is vacuumed after
-- a bounded amount of garbage rather than a fraction of however large it grew.
--
-- analyze is tightened further because the planner was working from stale
-- counts — pg_stat_user_tables reported 0 live rows for repositories on a
-- database that held three, which is the kind of error that turns an index scan
-- into a sequential one.
DO $$
DECLARE
    churn_table TEXT;
BEGIN
    FOREACH churn_table IN ARRAY ARRAY[
        'symbol_versions', 'semantic_vectors', 'structural_relations',
        'behavioral_profiles', 'effect_signatures', 'contract_profiles',
        'invariants', 'temporal_risk_scores', 'temporal_co_changes',
        'symbol_lineage', 'test_artifacts', 'files', 'symbols',
        'inferred_relations', 'dispatch_edges', 'class_hierarchy'
    ]
    LOOP
        IF to_regclass(churn_table) IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE %I SET ('
                || 'autovacuum_vacuum_scale_factor = 0.02, '
                || 'autovacuum_vacuum_threshold = 2000, '
                || 'autovacuum_analyze_scale_factor = 0.01, '
                || 'autovacuum_analyze_threshold = 1000)',
                churn_table
            );
        END IF;
    END LOOP;
END $$;
