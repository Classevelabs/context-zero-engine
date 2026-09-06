-- ContextZero Database Schema
-- Generated from db/migrations/*.sql. Do not hand-edit.
-- Generated at 2026-09-06T18:11:28.908Z
-- Dropped tables excluded: semantic_profiles, lsh_bands, capsule_compilations

-- >>> 001_initial_schema.sql

-- ContextZero Database Schema (PostgreSQL)
-- Defines the structural truth, behavioral profiles, contracts, and inferred relations.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Repositories and Snapshots
CREATE TABLE repositories (
    repo_id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    default_branch VARCHAR(255) NOT NULL,
    visibility VARCHAR(50) NOT NULL,
    language_set TEXT[] NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE snapshots (
    snapshot_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    commit_sha VARCHAR(40) NOT NULL,
    branch VARCHAR(255) NOT NULL,
    parent_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    indexed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    index_status VARCHAR(50) NOT NULL,
    UNIQUE (repo_id, commit_sha)
);

-- 2. Files and Scope
CREATE TABLE files (
    file_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    language VARCHAR(50) NOT NULL,
    parse_status VARCHAR(50) NOT NULL,
    UNIQUE (snapshot_id, path)
);

-- 3. Symbols
CREATE TABLE symbols (
    symbol_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    logical_namespace TEXT,
    UNIQUE (repo_id, stable_key)
);

CREATE TABLE symbol_versions (
    symbol_version_id UUID PRIMARY KEY,
    symbol_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    range_start_line INT NOT NULL,
    range_start_col INT NOT NULL,
    range_end_line INT NOT NULL,
    range_end_col INT NOT NULL,
    signature TEXT,
    ast_hash VARCHAR(64) NOT NULL,
    body_hash VARCHAR(64) NOT NULL,
    summary TEXT,
    visibility VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    uncertainty_flags TEXT[],
    UNIQUE (symbol_id, snapshot_id)
);

-- 4. Graphs and Relations
CREATE TABLE structural_relations (
    relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    source VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type)
);

-- 5. Behavioral, Contract, and Semantic Profiles
CREATE TABLE behavioral_profiles (
    behavior_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    purity_class VARCHAR(50) NOT NULL,
    resource_touches TEXT[],
    db_reads TEXT[],
    db_writes TEXT[],
    network_calls TEXT[],
    cache_ops TEXT[],
    file_io TEXT[],
    auth_operations TEXT[],
    validation_operations TEXT[],
    exception_profile TEXT[],
    state_mutation_profile TEXT[],
    transaction_profile TEXT[],
    UNIQUE(symbol_version_id)
);

CREATE TABLE contract_profiles (
    contract_profile_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    input_contract TEXT,
    output_contract TEXT,
    error_contract TEXT,
    schema_refs TEXT[],
    api_contract_refs TEXT[],
    serialization_contract TEXT,
    security_contract TEXT,
    derived_invariants_count INT NOT NULL DEFAULT 0,
    UNIQUE(symbol_version_id)
);

CREATE TABLE invariants (
    invariant_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    scope_symbol_id UUID REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    scope_level VARCHAR(50) NOT NULL,
    expression TEXT NOT NULL,
    source_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 1.0,
    validation_method VARCHAR(50) NOT NULL,
    last_verified_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL
);

-- [omitted] CREATE TABLE semantic_profiles — dropped by later migration

-- 6. Homolog Inference and Evidence
CREATE TABLE evidence_bundles (
    evidence_bundle_id UUID PRIMARY KEY,
    semantic_score FLOAT NOT NULL,
    structural_score FLOAT NOT NULL,
    behavioral_score FLOAT NOT NULL,
    contract_score FLOAT NOT NULL,
    test_score FLOAT NOT NULL,
    history_score FLOAT NOT NULL,
    contradiction_flags TEXT[],
    feature_payload JSONB NOT NULL,
    generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE inferred_relations (
    inferred_relation_id UUID PRIMARY KEY,
    src_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    dst_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    review_state VARCHAR(50) NOT NULL,
    evidence_bundle_id UUID NOT NULL REFERENCES evidence_bundles(evidence_bundle_id) ON DELETE CASCADE,
    valid_from_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    valid_to_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    UNIQUE (src_symbol_version_id, dst_symbol_version_id, relation_type, valid_from_snapshot_id)
);

-- 7. Tests and Transactions
CREATE TABLE test_artifacts (
    test_artifact_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    framework VARCHAR(50) NOT NULL,
    related_symbols TEXT[],
    assertion_summary TEXT,
    coverage_hints JSONB,
    UNIQUE(symbol_version_id)
);

CREATE TABLE change_transactions (
    txn_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    base_snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    created_by VARCHAR(255) NOT NULL,
    state VARCHAR(50) NOT NULL,
    target_symbol_versions TEXT[],
    patches JSONB NOT NULL,
    impact_report_ref VARCHAR(255),
    validation_report_ref VARCHAR(255),
    propagation_report_ref VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_files_snapshot_id ON files(snapshot_id);
CREATE INDEX idx_symbol_versions_symbol_id ON symbol_versions(symbol_id);
CREATE INDEX idx_symbol_versions_snapshot_id ON symbol_versions(snapshot_id);
CREATE INDEX idx_structural_relations_src ON structural_relations(src_symbol_version_id);
CREATE INDEX idx_structural_relations_dst ON structural_relations(dst_symbol_version_id);
CREATE INDEX idx_inferred_relations_src ON inferred_relations(src_symbol_version_id);
CREATE INDEX idx_inferred_relations_dst ON inferred_relations(dst_symbol_version_id);

-- Query optimization indexes
CREATE INDEX idx_symbols_repo_canonical ON symbols(repo_id, canonical_name);
CREATE INDEX idx_symbols_canonical_name_trgm ON symbols USING gin (canonical_name gin_trgm_ops);
CREATE INDEX idx_invariants_scope_symbol ON invariants(scope_symbol_id);
CREATE INDEX idx_change_transactions_repo_state ON change_transactions(repo_id, state);
CREATE INDEX idx_symbol_versions_file_id ON symbol_versions(file_id);

-- >>> 002_production_hardening.sql

-- Migration 002: ContextZero Production Hardening
-- Date: 2026-03-13
-- Description: JSONB report columns, file backup table, semantic vectors,
--              IDF corpus, normalized AST hashes, performance indexes, auto-updated_at triggers.

-- ============================================================
-- 1. Fix report columns: VARCHAR(255) -> JSONB with NULL defaults
-- ============================================================
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref TYPE JSONB USING impact_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref TYPE JSONB USING validation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref TYPE JSONB USING propagation_report_ref::jsonb;
ALTER TABLE change_transactions ALTER COLUMN impact_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN validation_report_ref SET DEFAULT NULL;
ALTER TABLE change_transactions ALTER COLUMN propagation_report_ref SET DEFAULT NULL;

-- ============================================================
-- 2. Add repository base_path column
-- ============================================================
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_path TEXT;

-- ============================================================
-- 3. Add transaction_file_backups table for persistent rollback
-- ============================================================
CREATE TABLE IF NOT EXISTS transaction_file_backups (
    backup_id UUID PRIMARY KEY,
    txn_id UUID NOT NULL REFERENCES change_transactions(txn_id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_content TEXT,  -- NULL means file didn't exist before
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_file_backups_txn ON transaction_file_backups(txn_id);

-- ============================================================
-- 4. Add normalized_ast_hash to symbol_versions
-- ============================================================
ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS normalized_ast_hash VARCHAR(64);

-- ============================================================
-- 5. Add semantic_vectors table for native TF-IDF embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS semantic_vectors (
    vector_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,  -- 'name', 'body', 'signature', 'behavior', 'contract'
    sparse_vector JSONB NOT NULL,  -- {token: tfidf_score, ...}
    minhash_signature BIGINT[] NOT NULL,  -- MinHash for LSH (values can exceed signed int32 range)
    token_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(symbol_version_id, view_type)
);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_sv ON semantic_vectors(symbol_version_id);
CREATE INDEX IF NOT EXISTS idx_semantic_vectors_view ON semantic_vectors(view_type);

-- ============================================================
-- 6. Add idf_corpus table for inverse document frequency stats
-- ============================================================
CREATE TABLE IF NOT EXISTS idf_corpus (
    corpus_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    view_type VARCHAR(50) NOT NULL,
    document_count INTEGER NOT NULL,
    token_document_counts JSONB NOT NULL,  -- {token: doc_count, ...}
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(snapshot_id, view_type)
);

-- ============================================================
-- 7. Add missing performance indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_sv_body_hash ON symbol_versions(body_hash);
CREATE INDEX IF NOT EXISTS idx_sv_ast_hash ON symbol_versions(ast_hash);
CREATE INDEX IF NOT EXISTS idx_sv_normalized_ast_hash ON symbol_versions(normalized_ast_hash);
CREATE INDEX IF NOT EXISTS idx_bp_purity_class ON behavioral_profiles(purity_class);
CREATE INDEX IF NOT EXISTS idx_test_artifacts_related ON test_artifacts USING gin(related_symbols);

-- ============================================================
-- 8. Add updated_at auto-trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_repositories_updated_at
    BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_change_transactions_updated_at
    BEFORE UPDATE ON change_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- >>> 003_remove_dead_tables.sql

-- Migration 003: Remove dead tables
-- The semantic_profiles table was superseded by semantic_vectors (native TF-IDF embeddings).

DROP TABLE IF EXISTS semantic_profiles;

-- >>> 004_lsh_bands.sql

-- Migration 004: LSH Banding table for sub-linear semantic candidate retrieval
-- Locality-Sensitive Hashing bands for MinHash signatures.
--
-- Each symbol_version's MinHash signature is split into bands of R consecutive
-- rows. Each band produces one hash. Two symbols sharing any (view_type, band_index, band_hash)
-- are LSH candidates, enabling O(matches) retrieval instead of O(N) full scan.

-- [omitted] CREATE TABLE lsh_bands — dropped by later migration

-- [omitted] index on lsh_bands — table dropped

-- >>> 005_body_source.sql

-- Migration 005: Add body_source to symbol_versions
--
-- Stores the actual source code body of each symbol version directly in the DB.
-- This transforms ContextZero from a metadata index into a self-contained
-- code knowledge base — enabling:
--   1. Symbol-scoped code serving without disk I/O
--   2. Accurate body-view TF-IDF embeddings (was using summaries)
--   3. Semantic code search against actual source
--   4. Rich context capsules with real code in all nodes
--   5. Docker/remote compatibility (no repo mount needed for queries)

ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS body_source TEXT;

-- >>> 006_invariant_dedup.sql

-- Migration 006: Deduplicate invariants
--
-- The invariants table had no UNIQUE constraint on (repo_id, scope_symbol_id, expression),
-- so each re-ingestion created duplicate invariant rows. This caused blast radius
-- contract dimension to return duplicate impacts.

-- Step 1: Remove duplicates, keeping the one with the highest strength
DELETE FROM invariants a
USING invariants b
WHERE a.invariant_id > b.invariant_id
  AND a.repo_id = b.repo_id
  AND a.scope_symbol_id IS NOT DISTINCT FROM b.scope_symbol_id
  AND a.expression = b.expression;

-- Step 2: Add UNIQUE constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_invariants_dedup
    ON invariants (repo_id, COALESCE(scope_symbol_id, '00000000-0000-0000-0000-000000000000'::uuid), expression);

-- >>> 007_v2_upgrade.sql

-- ContextZero V2 Upgrade — Full schema evolution
-- Adds: symbol lineage, dispatch edges, effect signatures, concept families,
-- temporal co-changes, runtime evidence, enhanced provenance tracking.
--
-- Non-destructive: all existing tables preserved and extended.

-- ============================================================================
-- 1. SYMBOL LINEAGE — persistent identity across snapshots/restarts
-- ============================================================================

CREATE TABLE symbol_lineage (
    lineage_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    -- Deterministic seed built from (repo, language, kind, ancestry, name, signature, path)
    identity_seed VARCHAR(128) NOT NULL,
    canonical_name VARCHAR(255) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL,
    -- Lifecycle
    birth_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    death_snapshot_id UUID REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
    -- Rename/move tracking
    previous_lineage_id UUID REFERENCES symbol_lineage(lineage_id) ON DELETE SET NULL,
    rename_confidence FLOAT,
    -- Status
    is_alive BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, identity_seed)
);

CREATE INDEX idx_lineage_repo_alive ON symbol_lineage(repo_id, is_alive);
CREATE INDEX idx_lineage_canonical ON symbol_lineage(repo_id, canonical_name);
CREATE INDEX idx_lineage_kind ON symbol_lineage(repo_id, kind);

-- Link symbols to their lineage chain
ALTER TABLE symbols ADD COLUMN IF NOT EXISTS lineage_id UUID REFERENCES symbol_lineage(lineage_id) ON DELETE SET NULL;
CREATE INDEX idx_symbols_lineage ON symbols(lineage_id);

-- ============================================================================
-- 2. DISPATCH EDGES — object-aware method resolution
-- ============================================================================

CREATE TABLE dispatch_edges (
    dispatch_edge_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Source: the callsite
    caller_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- The expression chain, e.g. "self.service.validate"
    receiver_expression TEXT NOT NULL,
    -- Inferred receiver type(s)
    receiver_types TEXT[] NOT NULL DEFAULT '{}',
    -- Resolved target(s) — may have multiple for polymorphic dispatch
    resolved_symbol_version_ids UUID[] NOT NULL DEFAULT '{}',
    -- Resolution metadata
    resolution_method VARCHAR(50) NOT NULL, -- 'type_annotation', 'constructor_assignment', 'field_inference', 'inheritance_mro', 'runtime_observed', 'unresolved'
    confidence FLOAT NOT NULL DEFAULT 0.5,
    is_polymorphic BOOLEAN NOT NULL DEFAULT FALSE,
    -- For inheritance dispatch
    class_hierarchy_depth INT,
    override_chain UUID[], -- ordered list of overriding symbol_version_ids
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dispatch_caller ON dispatch_edges(caller_symbol_version_id);
CREATE INDEX idx_dispatch_snapshot ON dispatch_edges(snapshot_id);
CREATE INDEX idx_dispatch_resolved ON dispatch_edges USING gin(resolved_symbol_version_ids);
CREATE INDEX idx_dispatch_receiver ON dispatch_edges(snapshot_id, receiver_expression);

-- Class hierarchy for dispatch resolution
CREATE TABLE class_hierarchy (
    hierarchy_id UUID PRIMARY KEY,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    class_symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    parent_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Method Resolution Order position (0 = self, 1 = first parent, etc.)
    mro_position INT NOT NULL DEFAULT 0,
    relation_kind VARCHAR(30) NOT NULL, -- 'extends', 'implements', 'mixin', 'protocol'
    UNIQUE (snapshot_id, class_symbol_version_id, parent_symbol_version_id)
);

CREATE INDEX idx_hierarchy_class ON class_hierarchy(class_symbol_version_id);
CREATE INDEX idx_hierarchy_parent ON class_hierarchy(parent_symbol_version_id);
CREATE INDEX idx_hierarchy_snapshot ON class_hierarchy(snapshot_id);

-- ============================================================================
-- 3. EFFECT SIGNATURES — typed effect system
-- ============================================================================

CREATE TABLE effect_signatures (
    effect_signature_id UUID PRIMARY KEY,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Structured effects as typed entries
    effects JSONB NOT NULL DEFAULT '[]',
    -- Summary classification
    effect_class VARCHAR(50) NOT NULL, -- 'pure', 'reader', 'writer', 'io', 'full_side_effect'
    -- Resource summary
    reads_resources TEXT[] NOT NULL DEFAULT '{}',
    writes_resources TEXT[] NOT NULL DEFAULT '{}',
    emits_events TEXT[] NOT NULL DEFAULT '{}',
    calls_external TEXT[] NOT NULL DEFAULT '{}',
    mutates_state TEXT[] NOT NULL DEFAULT '{}',
    requires_auth TEXT[] NOT NULL DEFAULT '{}',
    throws_errors TEXT[] NOT NULL DEFAULT '{}',
    -- Provenance
    source VARCHAR(50) NOT NULL DEFAULT 'static_analysis', -- 'static_analysis', 'runtime_observed', 'merged'
    confidence FLOAT NOT NULL DEFAULT 0.8,
    UNIQUE (symbol_version_id, source)
);

CREATE INDEX idx_effects_sv ON effect_signatures(symbol_version_id);
CREATE INDEX idx_effects_class ON effect_signatures(effect_class);
CREATE INDEX idx_effects_resources ON effect_signatures USING gin(reads_resources);
CREATE INDEX idx_effects_writes ON effect_signatures USING gin(writes_resources);

-- ============================================================================
-- 4. CONCEPT FAMILIES — clustered homolog groups
-- ============================================================================

CREATE TABLE concept_families (
    family_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Family identity
    family_name VARCHAR(255) NOT NULL,
    family_type VARCHAR(50) NOT NULL, -- 'validator', 'serializer', 'auth_policy', 'normalization', 'billing_rule', 'feature_gate', 'error_handler', 'query_builder', 'business_rule', 'custom'
    -- Canonical exemplar — the most representative member
    exemplar_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE SET NULL,
    -- Family-level fingerprints
    family_contract_fingerprint TEXT,
    family_effect_fingerprint TEXT,
    -- Statistics
    member_count INT NOT NULL DEFAULT 0,
    avg_confidence FLOAT NOT NULL DEFAULT 0.0,
    contradiction_count INT NOT NULL DEFAULT 0,
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, snapshot_id, family_name)
);

CREATE INDEX idx_families_repo ON concept_families(repo_id, snapshot_id);
CREATE INDEX idx_families_type ON concept_families(family_type);

CREATE TABLE concept_family_members (
    member_id UUID PRIMARY KEY,
    family_id UUID NOT NULL REFERENCES concept_families(family_id) ON DELETE CASCADE,
    symbol_version_id UUID NOT NULL REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Member role
    is_exemplar BOOLEAN NOT NULL DEFAULT FALSE,
    is_outlier BOOLEAN NOT NULL DEFAULT FALSE,
    is_contradicting BOOLEAN NOT NULL DEFAULT FALSE,
    -- Similarity to family
    similarity_to_exemplar FLOAT NOT NULL DEFAULT 0.0,
    -- Evidence
    membership_confidence FLOAT NOT NULL DEFAULT 0.0,
    contradiction_flags TEXT[] NOT NULL DEFAULT '{}',
    -- Deviation from family contract/effect
    contract_deviation TEXT,
    effect_deviation TEXT,
    UNIQUE (family_id, symbol_version_id)
);

CREATE INDEX idx_family_members_family ON concept_family_members(family_id);
CREATE INDEX idx_family_members_sv ON concept_family_members(symbol_version_id);

-- ============================================================================
-- 5. TEMPORAL INTELLIGENCE — git history mining
-- ============================================================================

CREATE TABLE temporal_co_changes (
    co_change_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    -- The two symbols that co-change
    symbol_a_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    symbol_b_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    -- Statistics
    co_change_count INT NOT NULL DEFAULT 0,
    total_changes_a INT NOT NULL DEFAULT 0,
    total_changes_b INT NOT NULL DEFAULT 0,
    -- Jaccard: co_change_count / (total_changes_a + total_changes_b - co_change_count)
    jaccard_coefficient FLOAT NOT NULL DEFAULT 0.0,
    -- Temporal window
    first_co_change TIMESTAMP WITH TIME ZONE,
    last_co_change TIMESTAMP WITH TIME ZONE,
    -- Metadata
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, symbol_a_id, symbol_b_id)
);

CREATE INDEX idx_cochange_repo ON temporal_co_changes(repo_id);
CREATE INDEX idx_cochange_a ON temporal_co_changes(symbol_a_id);
CREATE INDEX idx_cochange_b ON temporal_co_changes(symbol_b_id);
CREATE INDEX idx_cochange_jaccard ON temporal_co_changes(jaccard_coefficient DESC);

CREATE TABLE temporal_risk_scores (
    risk_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    symbol_id UUID NOT NULL REFERENCES symbols(symbol_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Risk dimensions
    change_frequency INT NOT NULL DEFAULT 0,         -- total commits touching this symbol
    bug_fix_count INT NOT NULL DEFAULT 0,            -- commits with fix/bug in message
    regression_count INT NOT NULL DEFAULT 0,          -- reverts or re-fixes
    recent_churn_30d INT NOT NULL DEFAULT 0,          -- changes in last 30 days
    distinct_authors INT NOT NULL DEFAULT 0,          -- number of different authors
    -- Composite risk score (0.0 = safe, 1.0 = very risky)
    composite_risk FLOAT NOT NULL DEFAULT 0.0,
    -- Temporal
    last_change_date TIMESTAMP WITH TIME ZONE,
    computed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (repo_id, symbol_id, snapshot_id)
);

CREATE INDEX idx_risk_repo ON temporal_risk_scores(repo_id, snapshot_id);
CREATE INDEX idx_risk_symbol ON temporal_risk_scores(symbol_id);
CREATE INDEX idx_risk_composite ON temporal_risk_scores(composite_risk DESC);

-- ============================================================================
-- 6. RUNTIME EVIDENCE — trace ingestion and dynamic edges
-- ============================================================================

CREATE TABLE runtime_traces (
    trace_id UUID PRIMARY KEY,
    repo_id UUID NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- Trace metadata
    trace_source VARCHAR(50) NOT NULL, -- 'test_execution', 'dev_run', 'ci_trace', 'production_sample'
    trace_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Raw trace data
    call_edges JSONB NOT NULL DEFAULT '[]',   -- [{caller_key, callee_key, receiver_type, count}]
    dynamic_routes JSONB NOT NULL DEFAULT '[]', -- [{route, handler_key, method}]
    observed_types JSONB NOT NULL DEFAULT '[]', -- [{expression, observed_type, location}]
    framework_events JSONB NOT NULL DEFAULT '[]', -- [{event_type, detail}]
    -- Processing state
    is_processed BOOLEAN NOT NULL DEFAULT FALSE,
    edges_resolved INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_traces_repo ON runtime_traces(repo_id, snapshot_id);
CREATE INDEX idx_traces_unprocessed ON runtime_traces(is_processed) WHERE is_processed = FALSE;

CREATE TABLE runtime_observed_edges (
    observed_edge_id UUID PRIMARY KEY,
    trace_id UUID NOT NULL REFERENCES runtime_traces(trace_id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    -- The observed call
    caller_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    callee_symbol_version_id UUID REFERENCES symbol_versions(symbol_version_id) ON DELETE CASCADE,
    -- Dynamic dispatch info
    receiver_type TEXT,
    call_count INT NOT NULL DEFAULT 1,
    -- Confidence (higher for more observations)
    confidence FLOAT NOT NULL DEFAULT 0.9,
    first_observed TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_observed TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_observed_caller ON runtime_observed_edges(caller_symbol_version_id);
CREATE INDEX idx_observed_callee ON runtime_observed_edges(callee_symbol_version_id);
CREATE INDEX idx_observed_snapshot ON runtime_observed_edges(snapshot_id);

-- ============================================================================
-- 7. ENHANCED PROVENANCE — upgrade existing relations
-- ============================================================================

-- Add provenance to structural relations
ALTER TABLE structural_relations ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) NOT NULL DEFAULT 'static_exact';
-- Values: 'static_exact', 'static_inferred', 'runtime_observed', 'framework_declared', 'developer_asserted'

-- Add provenance to inferred relations
ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS provenance VARCHAR(50) NOT NULL DEFAULT 'static_inferred';

-- Add lineage tracking to symbol_versions
ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS normalized_ast_hash VARCHAR(64);
-- (already exists in some versions, IF NOT EXISTS handles idempotency)

-- ============================================================================
-- 8. CAPSULE METADATA — inclusion rationale tracking
-- ============================================================================

-- [omitted] CREATE TABLE capsule_compilations — dropped by later migration

-- [omitted] index on capsule_compilations — table dropped
-- [omitted] index on capsule_compilations — table dropped

-- ============================================================================
-- 9. REPOSITORIES ENHANCEMENT
-- ============================================================================

-- base_path already added by migration 002 (IF NOT EXISTS is idempotent)
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS base_path TEXT;

-- ============================================================================
-- 10. VALIDATION REPORT STORAGE
-- ============================================================================
-- NOTE: validation_report_ref and propagation_report_ref were already converted
-- from VARCHAR(255) to JSONB in migration 002. The ALTER below is a no-op on
-- an already-JSONB column but kept for idempotency on fresh installs where
-- migration 002 might not have run (e.g., direct schema load).
-- Using DO block to avoid error if column is already JSONB.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'change_transactions'
          AND column_name = 'validation_report_ref'
          AND data_type != 'jsonb'
    ) THEN
        ALTER TABLE change_transactions
            ALTER COLUMN validation_report_ref TYPE JSONB USING validation_report_ref::jsonb,
            ALTER COLUMN propagation_report_ref TYPE JSONB USING propagation_report_ref::jsonb;
    END IF;
END $$;

-- >>> 008_bugfixes.sql

-- ContextZero bugfix migration 008
-- Fixes:
--   1. runtime_observed_edges: add UNIQUE constraint so ON CONFLICT DO NOTHING
--      actually fires (the PK is a fresh UUID, so without a UNIQUE constraint
--      every INSERT succeeds and duplicates accumulate).
--   2. runtime_observed_edges: add index on trace_id for cascade deletes.
--   3. invariants: add missing index on last_verified_snapshot_id.

-- 1. UNIQUE constraint on runtime_observed_edges
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_runtime_observed_edges_trace_caller_callee') THEN
        ALTER TABLE runtime_observed_edges
            ADD CONSTRAINT uq_runtime_observed_edges_trace_caller_callee
            UNIQUE (trace_id, caller_symbol_version_id, callee_symbol_version_id);
    END IF;
END $$;

-- 2. Index on trace_id for cascade deletes from runtime_traces
CREATE INDEX IF NOT EXISTS idx_runtime_observed_edges_trace_id
    ON runtime_observed_edges(trace_id);

-- 3. Missing index on invariants.last_verified_snapshot_id
CREATE INDEX IF NOT EXISTS idx_invariants_last_verified_snapshot
    ON invariants(last_verified_snapshot_id);

-- 4. UNIQUE constraint on dispatch_edges to prevent duplicates
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_dispatch_edges_snapshot_caller_receiver') THEN
        ALTER TABLE dispatch_edges
            ADD CONSTRAINT uq_dispatch_edges_snapshot_caller_receiver
            UNIQUE (snapshot_id, caller_symbol_version_id, receiver_expression);
    END IF;
END $$;

-- >>> 009_repository_identity.sql

ALTER TABLE repositories DROP CONSTRAINT IF EXISTS repositories_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_base_path_unique
    ON repositories(base_path)
    WHERE base_path IS NOT NULL;

-- >>> 010_performance_indexes.sql

-- Migration 010: Performance indexes for production-scale queries

CREATE INDEX IF NOT EXISTS idx_sv_snapshot_kind
ON symbol_versions (snapshot_id, symbol_version_id);

CREATE INDEX IF NOT EXISTS idx_symbols_kind
ON symbols (kind, repo_id);

CREATE INDEX IF NOT EXISTS idx_sr_dst_type
ON structural_relations (dst_symbol_version_id, relation_type);

CREATE INDEX IF NOT EXISTS idx_effect_sig_sv
ON effect_signatures (symbol_version_id);

CREATE INDEX IF NOT EXISTS idx_ir_confidence_type
ON inferred_relations (confidence, relation_type);

CREATE INDEX IF NOT EXISTS idx_invariants_scope_verified
ON invariants (scope_symbol_id, last_verified_snapshot_id DESC);

CREATE INDEX IF NOT EXISTS idx_ta_related_symbols
ON test_artifacts USING GIN (related_symbols);

-- >>> 011_schema_constraints.sql

-- Migration 011: Production safety constraints
-- Adds CHECK constraints to enum columns, bounds to score columns, and missing indexes.

-- ─── Enum Validation ────────────────────────────────────────────────────────

-- Snapshot status must be one of the valid lifecycle states
DO $$ BEGIN
    ALTER TABLE snapshots ADD CONSTRAINT chk_snapshot_index_status
        CHECK (index_status IN ('pending', 'in_progress', 'partial', 'complete', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Behavioral profile purity classification
DO $$ BEGIN
    ALTER TABLE behavioral_profiles ADD CONSTRAINT chk_bp_purity_class
        CHECK (purity_class IN ('pure', 'read_only', 'read_write', 'side_effecting'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Effect signature classification
DO $$ BEGIN
    ALTER TABLE effect_signatures ADD CONSTRAINT chk_es_effect_class
        CHECK (effect_class IN ('pure', 'reader', 'writer', 'io', 'full_side_effect'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation types
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_relation_type
        CHECK (relation_type IN ('calls', 'imports', 'defines', 'inherits', 'implements', 'overrides', 'references', 'uses', 'decorates', 'type_references'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation source provenance
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_source
        CHECK (source IN ('static_analysis', 'runtime_trace', 'heuristic', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change transaction state machine
DO $$ BEGIN
    ALTER TABLE change_transactions ADD CONSTRAINT chk_ct_state
        CHECK (state IN ('pending', 'patched', 'validating', 'validated', 'committing', 'committed', 'rolling_back', 'rolled_back', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Symbol visibility
DO $$ BEGIN
    ALTER TABLE symbol_versions ADD CONSTRAINT chk_sv_visibility
        CHECK (visibility IN ('public', 'private', 'protected', 'internal', 'package'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Capsule compilation mode
DO $$ BEGIN
    ALTER TABLE capsule_compilations ADD CONSTRAINT chk_cc_mode
        CHECK (mode IN ('minimal', 'standard', 'strict'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Runtime trace source
DO $$ BEGIN
    ALTER TABLE runtime_traces ADD CONSTRAINT chk_rt_trace_source
        CHECK (trace_source IN ('test_suite', 'staging', 'canary', 'production'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge resolution method
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN ('static_exact', 'static_inferred', 'runtime_observed', 'framework_declared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Score / Confidence Bounds ──────────────────────────────────────────────

-- Structural relations confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_strength_bounds
        CHECK (strength >= 0.0 AND strength <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Inferred relations confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE inferred_relations ADD CONSTRAINT chk_ir_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Evidence bundle scores [0, 1]
-- Only constrain columns that actually exist on the table.
-- Columns: semantic_score, structural_score, behavioral_score, contract_score,
--          test_score, history_score (from migration 001).
-- naming_score and composite_score do NOT exist — intentionally omitted.
DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_semantic_score
        CHECK (semantic_score >= 0.0 AND semantic_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_structural_score
        CHECK (structural_score >= 0.0 AND structural_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_behavioral_score
        CHECK (behavioral_score >= 0.0 AND behavioral_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_contract_score
        CHECK (contract_score >= 0.0 AND contract_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_test_score
        CHECK (test_score >= 0.0 AND test_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT chk_eb_history_score
        CHECK (history_score >= 0.0 AND history_score <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_confidence_bounds
        CHECK (confidence >= 0.0 AND confidence <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Temporal risk composite score [0, 1]
DO $$ BEGIN
    ALTER TABLE temporal_risk_scores ADD CONSTRAINT chk_trs_composite_risk
        CHECK (composite_risk >= 0.0 AND composite_risk <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Temporal co-change Jaccard [0, 1]
DO $$ BEGIN
    ALTER TABLE temporal_co_changes ADD CONSTRAINT chk_tcc_jaccard
        CHECK (jaccard_coefficient >= 0.0 AND jaccard_coefficient <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Concept family member similarity [0, 1]
DO $$ BEGIN
    ALTER TABLE concept_family_members ADD CONSTRAINT chk_cfm_similarity
        CHECK (similarity_to_exemplar >= 0.0 AND similarity_to_exemplar <= 1.0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Symbol lineage rename confidence [0, 1]
DO $$ BEGIN
    ALTER TABLE symbol_lineage ADD CONSTRAINT chk_sl_rename_confidence
        CHECK (rename_confidence IS NULL OR (rename_confidence >= 0.0 AND rename_confidence <= 1.0));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Concept Family Member Role Mutual Exclusivity ──────────────────────────

DO $$ BEGIN
    ALTER TABLE concept_family_members ADD CONSTRAINT chk_cfm_role_exclusivity
        CHECK ((is_exemplar::int + is_outlier::int + is_contradicting::int) <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Range Validation for Symbol Versions ───────────────────────────────────

DO $$ BEGIN
    ALTER TABLE symbol_versions ADD CONSTRAINT chk_sv_line_range
        CHECK (range_start_line >= 0 AND range_end_line >= range_start_line);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Missing Performance Indexes ────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_files_language ON files (language);
CREATE INDEX IF NOT EXISTS idx_snapshots_index_status ON snapshots (index_status);
CREATE INDEX IF NOT EXISTS idx_runtime_traces_source ON runtime_traces (trace_source);
CREATE INDEX IF NOT EXISTS idx_temporal_risk_scores_symbol ON temporal_risk_scores (symbol_id);
CREATE INDEX IF NOT EXISTS idx_change_transactions_state ON change_transactions (state);

-- >>> 012_fix_constraints.sql

-- Migration 012: Fix constraint mismatches between migration 011 and application types
--
-- Migration 011 introduced CHECK constraints with enum values that do not match
-- the TypeScript type definitions. This migration drops the incorrect constraints
-- and re-creates them with the correct values from src/types.ts.

-- ─── Drop Incorrect Constraints ─────────────────────────────────────────────

-- Snapshot index_status: 011 used 'in_progress', code uses 'indexing'
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS chk_snapshot_index_status;

-- Change transaction state: 011 used (pending, validating, committing, rolling_back),
-- code uses (planned, prepared, reindexed, propagation_pending)
ALTER TABLE change_transactions DROP CONSTRAINT IF EXISTS chk_ct_state;

-- Structural relation type: 011 used (uses, decorates, type_references),
-- code uses (called_by, exports, typed_as)
ALTER TABLE structural_relations DROP CONSTRAINT IF EXISTS chk_sr_relation_type;

-- Runtime trace source: 011 used (test_suite, staging, canary, production),
-- code uses (test_execution, dev_run, ci_trace, production_sample)
ALTER TABLE runtime_traces DROP CONSTRAINT IF EXISTS chk_rt_trace_source;

-- Dispatch edge resolution method: 011 used (static_exact, static_inferred, runtime_observed, framework_declared),
-- code uses (type_annotation, constructor_assignment, field_inference, inheritance_mro, runtime_observed, unresolved)
ALTER TABLE dispatch_edges DROP CONSTRAINT IF EXISTS chk_de_resolution_method;

-- Evidence bundles: 011 originally referenced non-existent columns naming_score and composite_score.
-- Fixed in 011 to use test_score and history_score instead. Drop legacy names if somehow present.
ALTER TABLE evidence_bundles DROP CONSTRAINT IF EXISTS chk_eb_naming_score;
ALTER TABLE evidence_bundles DROP CONSTRAINT IF EXISTS chk_eb_composite_score;

-- ─── Re-create With Correct Values ──────────────────────────────────────────

-- Snapshot index_status — matches IndexStatus type in types.ts:39
DO $$ BEGIN
    ALTER TABLE snapshots ADD CONSTRAINT chk_snapshot_index_status
        CHECK (index_status IN ('pending', 'indexing', 'complete', 'failed', 'partial'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Change transaction state — matches TransactionState type in types.ts:34-37
DO $$ BEGIN
    ALTER TABLE change_transactions ADD CONSTRAINT chk_ct_state
        CHECK (state IN (
            'planned', 'prepared', 'patched', 'reindexed',
            'validated', 'propagation_pending',
            'committed', 'rolled_back', 'failed'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Structural relation type — matches StructuralRelationType type in types.ts:18-23
DO $$ BEGIN
    ALTER TABLE structural_relations ADD CONSTRAINT chk_sr_relation_type
        CHECK (relation_type IN (
            'calls', 'called_by', 'references', 'defines',
            'imports', 'exports', 'implements', 'inherits',
            'typed_as', 'overrides'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Runtime trace source — matches TraceSource type in types.ts:49
DO $$ BEGIN
    ALTER TABLE runtime_traces ADD CONSTRAINT chk_rt_trace_source
        CHECK (trace_source IN ('test_execution', 'dev_run', 'ci_trace', 'production_sample'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Dispatch edge resolution method — matches DispatchResolutionMethod type in types.ts:48
DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN (
            'type_annotation', 'constructor_assignment', 'field_inference',
            'inheritance_mro', 'runtime_observed', 'unresolved'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>> 013_index_cleanup_and_integrity.sql

-- Migration 013: Index deduplication, missing indexes, and evidence_bundles integrity
--
-- 1. Drop 3 duplicate index pairs (each created in two separate migrations)
-- 2. Add missing indexes for common query patterns
-- 3. Add UNIQUE constraint on evidence_bundles to prevent duplicate bundles

-- ─── Drop Duplicate Indexes ────────────────────────────────────────────────
-- Each pair has the same definition; keep the one with the clearer name.

-- effect_signatures: idx_effects_sv (007) duplicated by idx_effect_sig_sv (010)
DROP INDEX IF EXISTS idx_effects_sv;

-- test_artifacts GIN(related_symbols): idx_test_artifacts_related (002) duplicated by idx_ta_related_symbols (010)
DROP INDEX IF EXISTS idx_test_artifacts_related;

-- temporal_risk_scores: idx_risk_symbol (007) duplicated by idx_temporal_risk_scores_symbol (011)
DROP INDEX IF EXISTS idx_risk_symbol;

-- ─── Add Missing Indexes ───────────────────────────────────────────────────

-- change_transactions.base_snapshot_id — queried during transaction validation and listing
CREATE INDEX IF NOT EXISTS idx_change_transactions_base_snapshot
    ON change_transactions (base_snapshot_id);

-- invariants.repo_id — filtered in many queries (getInvariantsForSymbol, mineInvariants)
CREATE INDEX IF NOT EXISTS idx_invariants_repo
    ON invariants (repo_id);

-- inferred_relations.evidence_bundle_id — joined during homolog queries
CREATE INDEX IF NOT EXISTS idx_inferred_relations_evidence_bundle
    ON inferred_relations (evidence_bundle_id);

-- capsule_compilations lookup by symbol + snapshot (common cache check)
-- [omitted] index on capsule_compilations — table dropped

-- ─── Evidence Bundle Deduplication ─────────────────────────────────────────
-- Prevent identical evidence bundles from accumulating.
-- Two bundles are considered duplicates if they share all six score dimensions.
DO $$ BEGIN
    ALTER TABLE evidence_bundles ADD CONSTRAINT uq_evidence_bundle_scores
        UNIQUE (semantic_score, structural_score, behavioral_score,
                contract_score, test_score, history_score);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>> 014_retention_and_lifecycle.sql

-- Migration 014: Retention policy support and lifecycle management
--
-- 1. Add retained_until column to snapshots for policy-based expiry
-- 2. Create cleanup_log table for retention audit trail
-- 3. Add index on snapshots(repo_id, created_at) for efficient age-based queries
-- 4. Add index on change_transactions(state, updated_at) for stale cleanup

-- ─── Snapshot Lifecycle Columns ──────────────────────────────────────────────
-- `created_at` is required by the `idx_snapshots_repo_created` index below
-- and by 015's `idx_snapshots_repo_status_created`. Originally added in a
-- later migration (017), but the indexes in 014/015 reference it — so we add
-- it here (idempotent) to make a fresh-DB bootstrap succeed in correct order.
-- Migration 017's `ADD COLUMN IF NOT EXISTS` becomes a no-op when 014 has
-- already added the column.
--
-- `retained_until`: NULL means "retain indefinitely" (default). When a
-- retention policy runs, it stamps retained_until with the computed expiry
-- timestamp. Snapshots past their retained_until are eligible for cleanup
-- on the next cycle.

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS retained_until TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN snapshots.retained_until IS
    'Policy-computed expiry timestamp. NULL = retain indefinitely. '
    'Snapshots past this timestamp are eligible for cleanup.';

-- ─── Cleanup Audit Log ───────────────────────────────────────────────────────
-- Every retention run records what it did for operational visibility.

CREATE TABLE IF NOT EXISTS cleanup_log (
    cleanup_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operation           TEXT NOT NULL,
    target_table        TEXT NOT NULL,
    rows_affected       INTEGER NOT NULL DEFAULT 0,
    details             JSONB DEFAULT NULL,

    CONSTRAINT chk_cleanup_operation CHECK (
        operation IN (
            'snapshot_expiry',
            'stale_transaction_cleanup',
            'orphan_data_cleanup',
            'snapshot_cap_enforcement'
        )
    ),
    CONSTRAINT chk_cleanup_rows_affected CHECK (rows_affected >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_run_at
    ON cleanup_log (run_at DESC);

COMMENT ON TABLE cleanup_log IS
    'Audit trail for retention policy runs. Each row records one cleanup operation.';

-- ─── Performance Indexes for Retention Queries ───────────────────────────────

-- Age-based snapshot queries: "find oldest snapshots for repo X"
CREATE INDEX IF NOT EXISTS idx_snapshots_repo_created
    ON snapshots (repo_id, created_at);

-- Stale transaction detection: "find stuck transactions older than threshold"
CREATE INDEX IF NOT EXISTS idx_change_transactions_state_updated
    ON change_transactions (state, updated_at)
    WHERE state NOT IN ('committed', 'rolled_back');

-- Retained_until expiry scan: "find snapshots past their retention window"
CREATE INDEX IF NOT EXISTS idx_snapshots_retained_until
    ON snapshots (retained_until)
    WHERE retained_until IS NOT NULL;

-- >>> 015_temporal_and_retention_indexes.sql

-- Migration 015: BRIN indexes for temporal tables and retention query optimization
--
-- 1. BRIN indexes on temporal tables (naturally ordered by insertion time)
-- 2. Composite index on snapshots for retention age queries
-- 3. Partial index on symbol_lineage for active lineage queries
-- 4. Covering index on cleanup_log for recent-run lookups
--
-- NOTE: temporal tables use distinct timestamp columns by design:
--   temporal_co_changes  → computed_at  (recomputed periodically)
--   temporal_risk_scores → computed_at  (recomputed periodically)
--   runtime_observed_edges → first_observed (when the edge was first seen)
--   runtime_traces        → created_at   (when the trace was ingested)
-- A previous on-disk version of this migration uniformly used `created_at`,
-- which would fail on a fresh DB because three of these tables have no such
-- column. The DDL below matches the columns that exist in production.

-- ─── BRIN Indexes for Temporal Tables ────────────────────────────────────────
-- BRIN (Block Range INdex) is ideal for append-only temporal data where
-- physical ordering correlates with logical ordering. Much smaller than B-tree
-- while supporting range scans efficiently.

CREATE INDEX IF NOT EXISTS idx_temporal_co_changes_computed_brin
    ON temporal_co_changes USING brin (computed_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_temporal_risk_scores_computed_brin
    ON temporal_risk_scores USING brin (computed_at)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_runtime_observed_edges_observed_brin
    ON runtime_observed_edges USING brin (first_observed)
    WITH (pages_per_range = 32);

CREATE INDEX IF NOT EXISTS idx_runtime_traces_created_brin
    ON runtime_traces USING brin (created_at)
    WITH (pages_per_range = 32);

-- ─── Symbol Lineage Active Records ──────────────────────────────────────────
-- Most lineage queries filter for alive symbols — partial index avoids dead rows

CREATE INDEX IF NOT EXISTS idx_symbol_lineage_alive
    ON symbol_lineage (repo_id, canonical_name)
    WHERE is_alive = true;

-- ─── Cleanup Log Recent Lookups ─────────────────────────────────────────────
-- Retention stats query needs the most recent cleanup run per operation type

CREATE INDEX IF NOT EXISTS idx_cleanup_log_operation_run
    ON cleanup_log (operation, run_at DESC);

-- ─── Snapshot Lifecycle Composite ───────────────────────────────────────────
-- Supports retention expiry queries that filter by repo + status + age

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_status_created
    ON snapshots (repo_id, index_status, created_at DESC);

-- >>> 016_widen_commit_sha.sql

-- Migration 016: Widen snapshots.commit_sha to VARCHAR(128)
--
-- The original schema used VARCHAR(40) which fits a hex SHA-1 git commit but
-- not the longer workspace-fingerprint identifiers (e.g. "workspace-<32 hex>")
-- nor SHA-256 git hashes. 128 chars is comfortably above any plausible commit
-- identifier we want to support.
--
-- Idempotent: only runs ALTER TYPE when the column is still narrower than 128.

DO $$
DECLARE
    current_max INT;
BEGIN
    SELECT character_maximum_length INTO current_max
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'snapshots'
      AND column_name = 'commit_sha';

    IF current_max IS NULL THEN
        RAISE EXCEPTION 'snapshots.commit_sha column not found';
    END IF;

    IF current_max < 128 THEN
        ALTER TABLE snapshots ALTER COLUMN commit_sha TYPE VARCHAR(128);
    END IF;
END $$;

-- >>> 017_add_snapshots_created_at.sql

-- Migration 017: Add snapshots.created_at for retention age queries
--
-- Earlier schemas relied on `indexed_at` to date a snapshot, but retention
-- policies and the `idx_snapshots_repo_status_created` index (migration 015)
-- need a stable creation timestamp distinct from re-index time.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Existing rows backfill via the
-- DEFAULT NOW() expression (PostgreSQL evaluates the default once per row
-- on add, but the existing rows pre-date this migration anyway).

ALTER TABLE snapshots
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

COMMENT ON COLUMN snapshots.created_at IS
    'Wall-clock time at which the snapshot row was first inserted. '
    'Distinct from indexed_at, which tracks the most recent (re)indexing run.';

-- >>> 018_widen_dispatch_resolution_method.sql

-- 018: widen chk_de_resolution_method to the FULL DispatchResolver RESOLUTION enum.
--
-- The dispatch resolver (src/analysis-engine/dispatch-resolver.ts) legitimately emits
-- factory_return / dependency_injection / dataclass_attr / local_flow in addition to the
-- six methods migration 012 allowed — so EVERY snapshot whose dispatch resolution used one
-- of those threw a chk_de_resolution_method violation and silently dropped all its dispatch
-- edges (the whole batch insert rolled back). This constraint now lists exactly the values
-- ALLOWED_RESOLUTION_METHODS in that file permits; the code also normalizes any out-of-set
-- value (e.g. an unbounded points-to fact.source) to 'unresolved' before insert, so the two
-- can never drift again.

ALTER TABLE dispatch_edges DROP CONSTRAINT IF EXISTS chk_de_resolution_method;

DO $$ BEGIN
    ALTER TABLE dispatch_edges ADD CONSTRAINT chk_de_resolution_method
        CHECK (resolution_method IN (
            'type_annotation', 'constructor_assignment', 'field_inference',
            'inheritance_mro', 'factory_return', 'dependency_injection',
            'dataclass_attr', 'runtime_observed', 'local_flow', 'unresolved'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>> 019_band_keys_on_vectors.sql

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

-- >>> 020_transaction_backup_uniqueness.sql

-- A transaction must have exactly one durable original for each logical file.
-- Refuse to guess when historical duplicates exist: discarding either copy
-- automatically could destroy the only correct rollback content.
ALTER TABLE transaction_file_backups
    ADD COLUMN IF NOT EXISTS original_mode INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_transaction_file_backup_mode'
          AND conrelid = 'transaction_file_backups'::regclass
    ) THEN
        ALTER TABLE transaction_file_backups
            ADD CONSTRAINT chk_transaction_file_backup_mode
            CHECK (original_mode IS NULL OR original_mode BETWEEN 0 AND 511);
    END IF;
END
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM transaction_file_backups
        GROUP BY txn_id, file_path
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot enforce transaction backup uniqueness: duplicate (txn_id, file_path) rows require manual reconciliation';
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_file_backups_txn_path
    ON transaction_file_backups (txn_id, file_path);

-- >>> 021_snapshot_failed_paths.sql

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

-- >>> 022_snapshot_refinement_debt.sql

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

-- >>> 023_compact_minhash_signatures.sql

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

-- >>> 024_index_shape_and_vacuum.sql

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

-- >>> 025_binary_sparse_vectors.sql

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

-- >>> 026_body_token_inverted_index.sql

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

-- >>> 027_review_audit_columns.sql

-- Migration 027: record who reviewed an inferred relation, and when.
--
-- reviewHomolog wrote `updated_at = NOW()` to inferred_relations, a column the
-- table has never had, so every review failed on the column and the tool had
-- never once recorded a review. The reviewer's name was accepted and logged
-- but not stored. A review is a decision worth keeping: which relation, what
-- state, who decided it, when. Both columns are nullable — rows reviewed
-- before this migration carry no author or time, which is the truth about
-- them — and nothing else in the schema changes.

ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE inferred_relations ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

COMMENT ON COLUMN inferred_relations.reviewed_at IS
    'When review_state was last set through a review. NULL for rows never reviewed.';
COMMENT ON COLUMN inferred_relations.reviewed_by IS
    'Who set review_state, as supplied by the reviewing tool call. NULL when not given.';

-- >>> 028_symbol_parent_name.sql

-- Migration 028: record a member's owner as data.
--
-- Dispatch resolution derived the owning class of a method by parsing a
-- string: a dot in the canonical name, or a `#` in the stable key. The
-- tree-sitter adapter writes keys as `file::Parent.name` with a bare
-- canonical name, so for Go, Java, C#, Kotlin and PHP the owner was never
-- found and dispatch resolution recorded nothing — gin produced 0 dispatch
-- edges, serilog 1, okhttp 0 — while Python, whose names are `Class.method`,
-- produced 38,951 on django.
--
-- Every adapter already knows the owner when it emits the member; the
-- ingestor now writes it here, and readers ask the column instead of parsing
-- a key. The backfill reads the existing keys once, for member kinds only:
-- test cases carry titles with dots that are not owners.

ALTER TABLE symbols ADD COLUMN IF NOT EXISTS parent_name VARCHAR(255);

UPDATE symbols
   SET parent_name = regexp_replace(
         regexp_replace(stable_key, '^.*(::|#)', ''),
         '\.[^.]*$', '')
 WHERE parent_name IS NULL
   AND kind IN ('method', 'constructor', 'property', 'accessor', 'enum_member')
   AND regexp_replace(stable_key, '^.*(::|#)', '') LIKE '%.%';

COMMENT ON COLUMN symbols.parent_name IS
    'Name of the class, struct, interface, enum or receiver type that declares this member; NULL for top-level symbols.';

-- >>> 029_file_co_changes.sql

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

-- >>> 030_symbol_bodies.sql

-- Migration 030: store each distinct body once, addressed by its content.
--
-- A snapshot was a full copy of every symbol's source text. On the local
-- twenty-snapshot database that was 584,411 symbol versions carrying
-- 58,259 distinct bodies: the same text stored ten times over, because a
-- version row is per snapshot and the body column lived on it. The body
-- text also duplicated itself within one snapshot, since a class's text
-- contains its members' text.
--
-- Bodies now live in symbol_bodies, keyed by the SHA-256 of the text, and a
-- version row carries body_ref, the key. Two versions with the same text
-- share one row; a version with no body (a module symbol, a symbol whose
-- file could not be read) carries NULL. The key is the hash of the stored
-- text itself, computed the same way here and in the application
-- (sha256 over UTF-8 bytes, lowercase hex), so a row written by either
-- side lands on the same key.
--
-- Rows in symbol_bodies that no version references are reclaimed by the
-- retention pass, not by a foreign-key cascade, because a body outlives any
-- one snapshot by design.

CREATE TABLE IF NOT EXISTS symbol_bodies (
    body_hash VARCHAR(64) PRIMARY KEY,
    body_source TEXT NOT NULL,
    byte_length INT NOT NULL,
    first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE symbol_versions ADD COLUMN IF NOT EXISTS body_ref VARCHAR(64) REFERENCES symbol_bodies(body_hash);

INSERT INTO symbol_bodies (body_hash, body_source, byte_length)
SELECT DISTINCT ON (h) h, body_source, octet_length(body_source)
FROM (
    SELECT encode(sha256(convert_to(body_source, 'UTF8')), 'hex') AS h, body_source
    FROM symbol_versions
    WHERE body_source IS NOT NULL
) distinct_bodies
ON CONFLICT (body_hash) DO NOTHING;

UPDATE symbol_versions
   SET body_ref = encode(sha256(convert_to(body_source, 'UTF8')), 'hex')
 WHERE body_source IS NOT NULL;

ALTER TABLE symbol_versions DROP COLUMN body_source;

CREATE INDEX IF NOT EXISTS idx_symbol_versions_body_ref ON symbol_versions (body_ref);

COMMENT ON TABLE symbol_bodies IS
    'Distinct symbol source texts, keyed by SHA-256 of the text. Referenced from symbol_versions.body_ref; orphans are reclaimed by retention.';

-- >>> 031_drop_capsule_compilations.sql

-- Migration 031: drop the capsule compilation log.
--
-- capsule_compilations recorded one row per compiled capsule: budget, token
-- estimate, node counts and a JSON rationale for every included and omitted
-- node. Nothing read it back: no tool, no service, no script. It was written
-- on every capsule request and deleted only when a snapshot was re-ingested,
-- so on a busy server it was the one table that grew with reads rather than
-- with code. The compiler's decisions are already visible in the capsule it
-- returns (omission_rationale, fetch_handles, token_estimate).

DROP TABLE IF EXISTS capsule_compilations;

-- >>> 032_cleanup_log_derived_rows.sql

-- Migration 032: let the cleanup log record the derived-row phase.
--
-- cleanup_log enumerates the operations it accepts. The retention pass gained
-- a phase that reclaims bodies, invariants and lineage rows no living
-- snapshot supports (see retention-service.ts, cleanupStaleDerivedRows); its
-- audit row was rejected by the check while its deletes had already run,
-- which is the one order of failure an audit log must not have.

ALTER TABLE cleanup_log DROP CONSTRAINT IF EXISTS chk_cleanup_operation;
ALTER TABLE cleanup_log ADD CONSTRAINT chk_cleanup_operation CHECK (
    operation IN (
        'snapshot_expiry',
        'stale_transaction_cleanup',
        'orphan_data_cleanup',
        'snapshot_cap_enforcement',
        'derived_rows_cleanup'
    )
);

-- >>> 033_symbol_history.sql

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
