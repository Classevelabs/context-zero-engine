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
