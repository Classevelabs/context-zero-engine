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
