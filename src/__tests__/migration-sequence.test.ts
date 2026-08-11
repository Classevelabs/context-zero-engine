jest.mock("../db-driver", () => ({
  db: {
    query: jest.fn(),
    transaction: jest.fn(),
  },
}))

jest.mock("../db-driver/config", () => ({
  getConnectionConfig: jest.fn(() => ({})),
  getMigrationTimeoutConfig: jest.fn(() => ({ lockTimeoutMs: 1_000, statementTimeoutMs: 1_000 })),
}))

import * as fs from "fs"
import * as path from "path"
import { validateMigrationFileSequence } from "../db-driver/migrate"

describe("migration file sequencing", () => {
  test("rejects an empty migration directory", () => {
    expect(() => validateMigrationFileSequence([])).toThrow("No migration files")
  })

  test("accepts a contiguous, canonical sequence", () => {
    expect(() =>
      validateMigrationFileSequence(["001_initial.sql", "002_add_index.sql", "003_fix_constraint.sql"]),
    ).not.toThrow()
  })

  test("rejects sequence gaps", () => {
    expect(() => validateMigrationFileSequence(["001_initial.sql", "003_gap.sql"])).toThrow("sequence gap")
  })

  test("rejects duplicate numeric prefixes", () => {
    expect(() => validateMigrationFileSequence(["001_initial.sql", "001_other.sql"])).toThrow(
      "Duplicate migration number",
    )
  })

  test.each(["1_short.sql", "002-UPPER.sql", "002_bad-name.sql", "README.sql"])(
    "rejects a non-canonical filename %s",
    (file) => {
      expect(() => validateMigrationFileSequence([file])).toThrow("Invalid migration filename")
    },
  )

  test("migration 020 preserves ambiguous backups and enforces one backup per file", () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, "../../db/migrations/020_transaction_backup_uniqueness.sql"),
      "utf8",
    )
    expect(sql).toContain("HAVING COUNT(*) > 1")
    expect(sql).toContain("RAISE EXCEPTION")
    expect(sql).toContain("original_mode")
    expect(sql).toContain("BETWEEN 0 AND 511")
    expect(sql).toContain("UNIQUE INDEX")
    expect(sql).toContain("(txn_id, file_path)")
    expect(sql).not.toMatch(/DELETE\s+FROM\s+transaction_file_backups/i)
  })
})
