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
