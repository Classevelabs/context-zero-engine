/**
 * ContextZero — content addressing for symbol bodies.
 *
 * A body is stored once in symbol_bodies, keyed by the SHA-256 of its text,
 * and a version row carries the key (body_ref). These helpers are the only
 * place the key is computed in the application; migration 030 computes the
 * same key in SQL (sha256 over UTF-8 bytes, lowercase hex) for rows that
 * predate it, so both sides land the same text on the same row. They depend
 * on nothing but the hash, so any writer can use them.
 */

import { createHash } from "crypto"

/** Content address of a body: SHA-256 over the UTF-8 bytes, lowercase hex. */
export function bodyRef(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** One multi-row upsert of distinct bodies; rows already present cost nothing. */
export function bodyUpsert(bodies: Map<string, string>): { text: string; params: unknown[] } | null {
  if (bodies.size === 0) return null
  const values: string[] = []
  const params: unknown[] = []
  let i = 1
  for (const [hash, text] of bodies) {
    values.push(`($${i++}, $${i++}, $${i++})`)
    params.push(hash, text, Buffer.byteLength(text, "utf8"))
  }
  return {
    text: `INSERT INTO symbol_bodies (body_hash, body_source, byte_length) VALUES ${values.join(", ")} ON CONFLICT (body_hash) DO NOTHING`,
    params,
  }
}
