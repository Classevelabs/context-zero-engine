/**
 * Migration fingerprints must depend on the SQL and on nothing else.
 *
 * They used to hash raw file bytes. `.gitattributes` pinned eol=lf for the
 * source and config file types but not for `.sql`, so `* text=auto` handed
 * Windows clones CRLF migrations and Linux/Docker clones LF ones — and the same
 * migration hashed two different ways. Under NODE_ENV=production, which is what
 * docker-compose.yml sets, the runner throws "Refusing to continue", so a clean
 * checkout could fail to boot against its own database purely because of the
 * operating system it was cloned on.
 */

import * as fs from "fs"
import * as path from "path"
import { migrationChecksum, legacyMigrationChecksum } from "../db-driver/migration-checksum"

const SQL_LF = "ALTER TABLE symbols\n  ADD COLUMN note TEXT;\n"
const SQL_CRLF = SQL_LF.replace(/\n/g, "\r\n")

describe("migrationChecksum", () => {
  test("is identical for LF and CRLF spellings of the same SQL", () => {
    expect(migrationChecksum(SQL_CRLF)).toBe(migrationChecksum(SQL_LF))
  })

  test("is identical for a lone-CR spelling too", () => {
    expect(migrationChecksum(SQL_LF.replace(/\n/g, "\r"))).toBe(migrationChecksum(SQL_LF))
  })

  test("ignores a leading UTF-8 BOM", () => {
    expect(migrationChecksum("﻿" + SQL_LF)).toBe(migrationChecksum(SQL_LF))
  })

  test("still changes when the SQL actually changes", () => {
    expect(migrationChecksum(SQL_LF + "-- edited\n")).not.toBe(migrationChecksum(SQL_LF))
    expect(migrationChecksum("DROP TABLE symbols;\n")).not.toBe(migrationChecksum(SQL_LF))
  })

  test("is a 64-character hex digest", () => {
    expect(migrationChecksum(SQL_LF)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("legacyMigrationChecksum", () => {
  test("reproduces the pre-normalisation raw-bytes fingerprint", () => {
    // The runner accepts this value for already-applied migrations and upgrades
    // it in place. If this ever stopped matching, existing databases would
    // report phantom drift on every startup.
    expect(legacyMigrationChecksum(SQL_CRLF)).not.toBe(legacyMigrationChecksum(SQL_LF))
    expect(legacyMigrationChecksum(SQL_LF)).toBe(migrationChecksum(SQL_LF))
  })
})

describe("shipped migrations", () => {
  const migrationsDir = path.resolve(__dirname, "..", "..", "db", "migrations")

  test("every migration hashes the same however it was checked out", () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const raw = fs.readFileSync(path.join(migrationsDir, file), "utf-8")
      const asLf = raw.replace(/\r\n/g, "\n")
      const asCrlf = asLf.replace(/\n/g, "\r\n")
      expect(migrationChecksum(asCrlf)).toBe(migrationChecksum(asLf))
    }
  })
})
