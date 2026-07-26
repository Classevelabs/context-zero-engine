/**
 * ContextZero — Migration Checksum
 *
 * Migrations are fingerprinted so an already-applied file cannot be edited
 * underneath a live database. The fingerprint must therefore depend on the SQL
 * and on nothing else — least of all the platform the repository was checked
 * out on.
 *
 * It did. `.gitattributes` pins `eol=lf` for .sh/.ts/.mjs/.md/.json/.yml and
 * the Dockerfile, but not for `.sql`, so `* text=auto` hands Windows clones
 * CRLF migrations and Linux/Docker clones LF ones. Hashing the raw bytes made
 * those two spellings of an identical file disagree. On a development box that
 * was a startup warning; under `NODE_ENV=production` — which is what
 * docker-compose.yml sets — the runner throws "Refusing to continue", so a
 * clean checkout could fail to boot against its own database purely because it
 * was cloned on a different operating system.
 *
 * Line endings are now normalised before hashing, so the fingerprint tracks the
 * SQL itself. `.gitattributes` also pins `*.sql eol=lf` to stop the divergence
 * at the source.
 */

import * as crypto from "crypto"

/** Strip a UTF-8 BOM and normalise CRLF/CR to LF. */
function normalizeSql(sql: string): string {
  return sql.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
}

/** Fingerprint of a migration's SQL, independent of checkout line endings. */
export function migrationChecksum(sql: string): string {
  return crypto.createHash("sha256").update(normalizeSql(sql)).digest("hex")
}

/**
 * Fingerprint under the pre-normalisation scheme (raw file bytes).
 *
 * Databases migrated before this change hold one of these. A stored value that
 * matches it is the same SQL recorded under the old scheme, not drift — so it
 * is accepted and rewritten to the normalised form rather than reported as a
 * modified migration.
 */
export function legacyMigrationChecksum(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex")
}
