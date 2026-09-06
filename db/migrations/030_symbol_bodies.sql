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
