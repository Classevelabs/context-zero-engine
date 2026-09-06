/**
 * Content-addressed bodies: the key the application computes must be the
 * key migration 030 computes in SQL (sha256 over UTF-8 bytes, lowercase
 * hex), and the upsert must be one statement that ignores rows already
 * present.
 */

import { bodyRef, bodyUpsert } from "../db-driver/symbol-bodies"

describe("bodyRef", () => {
  test("is the SHA-256 of the UTF-8 bytes, lowercase hex", () => {
    // Known vector: sha256("abc")
    expect(bodyRef("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(bodyRef("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })

  test("hashes bytes, not code units, so multibyte text keys the same way as the database", () => {
    // "é" is two UTF-8 bytes; the key must differ from the one-byte "e".
    expect(bodyRef("é")).not.toBe(bodyRef("e"))
    expect(bodyRef("é")).toHaveLength(64)
  })
})

describe("bodyUpsert", () => {
  test("returns null for nothing to store", () => {
    expect(bodyUpsert(new Map())).toBeNull()
  })

  test("builds one multi-row insert that skips rows already present, with byte lengths", () => {
    const bodies = new Map([
      [bodyRef("function a() {}"), "function a() {}"],
      [bodyRef("naïve"), "naïve"],
    ])
    const stmt = bodyUpsert(bodies)!
    expect(stmt.text).toMatch(/^INSERT INTO symbol_bodies \(body_hash, body_source, byte_length\) VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\) ON CONFLICT \(body_hash\) DO NOTHING$/)
    expect(stmt.params).toEqual([bodyRef("function a() {}"), "function a() {}", 15, bodyRef("naïve"), "naïve", 6])
  })
})
