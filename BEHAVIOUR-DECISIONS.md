# Behaviour decisions

Why the engine behaves the way it does where the code alone does not say so,
and what a regression looks like from the user's side.

Required by the binding engineering standard, §IV.13 (`ENGINEERING-STANDARD.md`,
kept outside this repository): a fix whose reason is not written down is a fix
scheduled to be undone by the next cleanup that is otherwise correct. Add an
entry whenever a fix depends on a constraint a later reader cannot see in the
diff. The reason also lives in a comment at the change site; this file is the
copy for someone reading the product rather than the file.

Each entry: the decision, why it is not arbitrary, what it was verified
against, and how a regression would show up to somebody using the engine.

---

## 2026-09-05 — A MinHash signature is stored only for a view of 8 or more tokens

**Decision.** `MINHASH_MIN_TOKENS` in `similarity.ts` is 8. Below it a view
stores neither a signature nor band keys, and every comparison against it uses
the exact Jaccard over the sparse vector's key set. Signatures are packed
`bytea`, not `bigint[]` (migration 023).

**Why it is not arbitrary.** On a database of 584,411 symbol versions the
signature column held 2,928 MB, 2,360 MB of it on the four narrow views whose
average width was 0 to 5 tokens. A signature over a k-token set carries at
most k distinct values, so those bytes described sets the sparse vector already
described exactly; for the behavior view they were 590 MB of one repeated
sentinel. The narrow views also poisoned candidate generation: a one-token view
produced band keys shared by every symbol with that token.

**Verified against.** `packMinHash`/`unpackMinHash` round-trip tests including
the 0xFFFFFFFF sentinel; `jaccardFromSparse` tests; the migrated local database
shows signatures on 18,362 of 131,795 rows with search and homolog queries
answering. The 17-repository sweep completed with 0 query failures.

**Regression looks like.** Storage climbs back toward gigabytes per twenty
snapshots, and homolog candidates for short symbols come back as one huge
bucket that is truncated before scoring.

---

## 2026-09-05 — Sparse vectors store token hashes, not tokens

**Decision.** A stored term is six bytes: a 32-bit FNV-1a hash of the token and
a 16-bit quantized weight, sorted by hash (migration 025). Nothing reads a
token back; a query built from text is re-keyed with `hashSparseKeys` before
it is compared.

**Why it is not arbitrary.** As JSONB a term cost 28.2 bytes, nearly all of it
the token spelled out as a key; 98,924 terms drew on 4,930 distinct tokens, so
each token was written roughly twenty times. A hash collision merges two rare
terms into one dimension and shifts a score by the rarer weight; it cannot
create a match between unrelated symbols, which needs agreement across many
terms and five views.

**Verified against.** Cosine similarity is preserved through pack/unpack in
tests to four decimals; the encoding is byte-deterministic for a term set so an
unchanged symbol is carried forward rather than rewritten.

**Regression looks like.** A search whose query vector is not re-keyed scores
everything zero and returns nothing; a "readable" JSONB column returning means
the storage grew about five-fold per term.

---

## 2026-09-05 — Semantic search probes an inverted index, not LSH bands

**Decision.** The body view carries `token_hashes` with a partial GIN index
(migration 026), and `semanticSearch` retrieves candidates whose token-hash set
overlaps the query's most distinctive hashes. Band keys remain for homolog
candidate generation only.

**Why it is not arbitrary.** LSH answers "is this a near-duplicate of that",
not "which bodies contain these terms". A two-token query against a
seventy-token body has Jaccard near 0.03, zero band collisions, and fell
through every time to a linear scan that decoded every vector in the snapshot:
583 ms at p50 on a 22k-symbol repository while the largest index in the
database showed 0 scans. Cosine is a sum over shared terms, so overlap on
token hashes is exactly the set that can score above zero.

**Verified against.** `tokenHashesInt32` and `distinctiveQueryHashes` tests;
the local database has hashes on every body row; the sweep's semantic search
answered on all 17 repositories.

**Regression looks like.** Search latency grows with snapshot size again and
the band index is the largest object in the database with no scans.

---

## 2026-09-05 — An unchanged repository reuses its parent snapshot

**Decision.** When every discovered file matches the parent snapshot by content
hash and the counts agree, `ingestRepo` deletes the snapshot it just minted and
returns the parent's id with `unchanged: true`.

**Why it is not arbitrary.** A snapshot is a full copy of the repository's
symbol versions and everything derived from them. Twenty snapshots on the
measured database held 584,411 symbol versions for 58,259 distinct bodies, most
of them minted by a watcher re-running ingestion with nothing to show for it.

**Verified against.** `ingestor.test.ts` "reuses the parent snapshot when no
file changed"; `bench-storage.mjs` reports rows added on a second pass and exits
non-zero if any were.

**Regression looks like.** `scg_list_snapshots` grows by one identical
snapshot per watcher pass and the database grows with it.

---

## 2026-09-05 — Delta ingest carries vectors, the IDF corpus and effect signatures forward

**Decision.** For files whose content hash matches the parent, the delta copy
brings `semantic_vectors`, `idf_corpus` and `effect_signatures` across, and
embedding runs only for symbols with no vector row. A snapshot with no corpus
falls back to the full embedding pass rather than embedding against default
weights.

**Why it is not arbitrary.** The vectors are a pure function of the token
streams and the corpus; recomputing them for unchanged code was the most
expensive part of every incremental pass. Embedding against an absent corpus
is not a degraded result but a wrong one: every token takes IDF 1.0 and the
stored vectors become plain term frequency beside neighbours that are not.

**Verified against.** `ingestor.test.ts` carry-forward test;
`semantic-engine-bounds.test.ts` "rebuilds the corpus rather than embedding
against default weights".

**Regression looks like.** Incremental ingest time returns to that of a full
pass, or search rankings degrade silently after an edit.

---

## 2026-09-05 — TypeScript extraction runs in a child process that exits

**Decision.** `extractFromTypeScript` writes a job file, spawns
`dist/adapters/ts/worker.js`, and reads the result file back. `SCG_TS_ISOLATED=false`
extracts in-process; running from source with no built worker falls back the
same way.

**Why it is not arbitrary.** A compiler program loads every transitively
imported file plus the ambient type surface. On a 151-file tree extraction took
the process from 75 MB to 852 MB resident and V8 never returned the pages: the
heap fell to 188 MB after collection while RSS stayed at 844 MB. In a
long-lived stdio bridge one index left the process ten times larger for its
life; four bridges were found alive on one machine, the largest at 1,806 MB.
Only a process exit gives the pages back.

**Verified against.** The full suite runs the in-process fallback; a built
bridge ingesting through the worker produces the same symbols and relations.

**Regression looks like.** The bridge's memory in the task manager climbs
after each ingest and never comes down.

---

## 2026-09-05 — The stdio bridge shuts down when its client closes stdin, after the retention pass

**Decision.** End, close or error on stdin triggers the same graceful shutdown
as SIGTERM, once. Shutdown clears the timers, then waits for a retention pass
in flight to finish its current phase (`RetentionRunner.stop`), then stops the
watcher, closes the server and the pool.

**Why it is not arbitrary.** Windows delivers no signal to a child whose parent
died, and a client exiting without signalling leaves the bridge running with
its advisory locks; the orphans above were the result. Closing the pool while
the startup retention pass was still running logged four "Database driver has
been closed" errors on every short session.

**Verified against.** `retention-runner.test.ts` ordering tests;
`retention-service.test.ts` "stops between phases"; the CI cold-start smoke now
fails on any error-level line, and the local smoke logs "stopped between
phases" before "Closing database connection pool" with zero errors.

**Regression looks like.** Bridges left alive after the client quits, or error
lines in the startup log of a session that only listed tools.

---

## 2026-09-06 — Every column the engine's SQL names is checked against the schema

**Decision.** `sql-schema-contract.test.ts` parses `db/schema.sql` into tables
and columns, applying each migration's column changes in document order, and
scans every SQL template literal under `src/` for `alias.column`,
`UPDATE … SET column` and `INSERT INTO table (columns)`. Any column the schema
lacks fails the suite. Aliases bound to subqueries or CTEs are skipped.

**Why it is not arbitrary.** Two tools had been broken since they were
written — `scg_explain_relation` joined on a column that did not exist and
`scg_review_homolog` set one — and no unit test could see it: the driver is
mocked, so a wrong column name is only ever found by PostgreSQL, at the
moment a user calls the tool. Across 384 literals the checker reports exactly
those two and nothing else, which is what makes it a gate rather than noise.

**Verified against.** Its own toy-schema cases; the two real defects before
their repair; a clean run after.

**Regression looks like.** A tool answering "column … does not exist" after a
migration renames or drops something; the suite fails first.

---

## 2026-09-06 — A test's invariant belongs to the symbols the test exercises

**Decision.** `mineInvariantsFromTests` looks up each test symbol's outgoing
structural edges in one query per thousand tests and writes an `explicit_test`
invariant on each reached symbol, named `test:<test> asserts behavior of
<target>`. A test that reaches nothing writes nothing; a test reaching another
test is skipped.

**Why it is not arbitrary.** Scoped to the test symbol itself, the invariant
was invisible to `getInvariantsForSymbol(target)` and to every capsule of the
target, and blast radius — which reports a target's own invariants at
critical for strength 0.9 — marked the test critical for asserting itself.

**Verified against.** `contracts.test.ts` scoping tests. Invariant counts on
the next full ingest change: they now count coverage of targets, not tests.

**Regression looks like.** `scg_get_invariants` on a well-tested function
returning nothing test-derived, and test symbols appearing as critical
contract impacts in blast radius.

---

## 2026-09-06 — Without a snapshot, the latest indexed one

**Decision.** `resolveSymbol` with no snapshot restricts to the repository's
newest snapshot whose status is complete or partial; `searchCode` scans that
snapshot's files and reports `files_truncated` past 10,000; the newest
snapshot for invariant lookup is chosen by `created_at`, not by sorting ids.

**Why it is not arbitrary.** Joining symbol versions without a snapshot filter
returned one row per snapshot per symbol, identical but for version ids; the
file union kept files deleted since the earliest snapshot searchable; and
`ORDER BY <uuid> DESC` is a random choice dressed as "latest". A caller who
names no snapshot means the repository as it is now.

**Verified against.** `services.test.ts` and `contracts.test.ts` SQL
assertions, and the schema-contract suite for the columns used.

**Regression looks like.** Duplicate rows from `scg_resolve_symbol`, search
hits in files that no longer exist, or invariants from an old snapshot.

---

## 2026-09-06 — A task's candidates come from the names it mentions

**Decision.** `planChange` extracts quoted spans, code-shaped words and
non-prose words from the task, resolves each on its own and keeps the best
match per symbol version; if nothing resolves it runs the task through
semantic search over code bodies; the plan's first assumption names the route.
The prose word list is a filter on English, not a table of expected inputs:
a code-shaped word is always a mention regardless of it.

**Why it is not arbitrary.** The whole sentence was handed to trigram name
similarity, so the candidates for a forty-character task were the symbol
names sharing the most letters with English. Nothing about that improves with
a better sentence.

**Verified against.** `planning-service.test.ts`: extraction cases, per-name
resolution, best-match merge, semantic fallback, honest failure.

**Regression looks like.** `scg_plan_change` returning candidates whose names
merely resemble the words of the request.

---

## 2026-09-06 — A session lists only the tools it can call

**Decision.** `registerTool` skips the 17 mutation tools while
`SCG_MCP_MUTATIONS_ENABLED` is off, and the server's `instructions` say so
once at connect. `_auth_token` is added to a schema only when
`SCG_MCP_SECRET` or `SCG_MCP_ADMIN_SECRET` is set. The blocked-call check in
the tool wrapper stays as defence in depth.

**Why it is not arbitrary.** A listed tool's schema is in the model's context
on every turn. The 61 schemas were 49,360 bytes, about 12,300 tokens per turn,
more than three capsules' worth before any question is asked — and the
founder's own sessions used more tokens with the engine than without it. The
17 mutation tools were refused outright while listed, and the auth field
described a check that never ran without a secret. Listing what cannot be
called bought nothing; unlisting it without a note would leave a session
unable to learn why ingestion is missing, so the note carries the explanation
once instead of 17 schemas every turn.

**Verified against.** `mcp-security.test.ts` (listing rule, auth-field rule,
note text); the cold-start smoke under both configurations: 44 tools at
28,491 bytes with mutations off and the note present, 61 tools at 42,745
bytes with them on; CI fails if a mutation tool is listed while they are off.

**Regression looks like.** A default session's tool list back near 50 KB, or
`scg_ingest_repo` visible to a client that cannot call it.

---

## 2026-09-06 — A capsule ships exactly what it prices, and reasons only on request

**Decision.** Responses are compact JSON. `inclusion_reason` is attached to
context nodes only when `scg_compile_context_capsule` is called with
`explain: true`, the cache key includes that flag, and the compilation record's
id is not shipped. `token_estimate` is the serialized size of the capsule as
it leaves the compiler, held by a test in both modes.

**Why it is not arbitrary.** Pretty-printing was a tenth of every capsule in
whitespace; inclusion reasons were 646 bytes of prose per capsule that no
consumer acts on; the compilation id was attached after pricing, so every
capsule was 14 tokens larger than it claimed. A budget is a promise about what
the client pays, and each of these broke it a little. Measured on twelve real
targets: 14,558 bytes per capsule to 12,507, paid tokens equal to priced.

**Verified against.** `integration/capsule.test.ts` (no reasons by default,
reasons under explain, estimate equals shipped size, cache separation);
`mcp-bridge-handlers.test.ts` (compact text, explain passed through);
`measure-payload` run on the local database.

**Regression looks like.** A capsule's `token_estimate` below the tokens the
client is billed for, or newline-indented JSON in a tool result.

---

## 2026-09-05 — A container capsule draws its dependencies from its members; a callable never does

**Decision.** For a target of kind `class`, `interface` or `enum`,
`loadDirectDependencies` unions the edges of every symbol nested in the
target's line range in the same file, minus edges pointing back into the
container. Functions, methods and route handlers keep their own edges only.
`SCG_CAPSULE_MEMBER_DEPS=0` restores the old query for everything.

**Why it is not arbitrary.** A class holds almost no edges of its own; its
collaborators are named in its methods and, for injected dependencies, in its
constructor's parameter types. Members are bare-named and there is no
class-to-member edge, so line-range nesting is the only structural fact tying
them together. Class capsules recalled about 12% of their dependencies while
94% of the misses sat one hop away on members. A callable's nested closures are
private detail already shipped with its body, not dependencies, so aggregating
them would change callable capsules for no gain.

**Verified against.** Deterministic paired A/B on the nest repository: class
recall 12.5% to 57.7% with the capsule 4,367 to 6,470 tokens; function and
method capsules byte-identical off and on. Four gate tests in
`integration/capsule.test.ts`. Containers never return themselves as a
dependency (checked on 48 classes with member-to-class edges).

**Regression looks like.** A class capsule that ships the class and none of
the things its methods call.

---

## 2026-09-05 — Constructors are indexed as methods

**Decision.** `ConstructorDeclaration` is extracted as a `method` symbol named
`constructor` with behaviour and effect hints but no contract hint.
`SCG_INDEX_CONSTRUCTORS=0` reverts.

**Why it is not arbitrary.** In dependency-injection code the constructor's
parameter types are the dependency edges. Unextracted, a NestJS or Angular
class read as isolated. The symbol is a prerequisite for the container
decision above, not a fix on its own: the edges land on the constructor, which
only a container capsule reaches.

**Verified against.** 455 constructor symbols on the nest repository; the
member-dependency A/B above.

**Regression looks like.** Injected services missing from class capsules in
DI-heavy code.

---

## 2026-09-05 — Python is extracted in batches of 200 files per interpreter

**Decision.** `extractor.py --batch <job>` extracts many files in one
interpreter and writes results to a file keyed by path; the ingestor chunks
files by 200 and falls back to one process per file only when a batch cannot
run.

**Why it is not arbitrary.** Importing libcst costs a few hundred milliseconds,
and the old contract paid it, plus process startup, once per file: a
3,000-file repository spent about twenty minutes almost entirely in repeated
startup. A per-file failure inside a batch is isolated to that file's result.

**Verified against.** `ingestor.test.ts` "batches many Python files into ONE
interpreter invocation"; django ingest 21 minutes to 8.9 minutes with identical
symbols.

**Regression looks like.** Python ingest that takes minutes on a few hundred
files while the process list shows one interpreter after another.

---

## 2026-09-05 — An explicit env file that does not exist is a startup error

**Decision.** `loadEnvFile` throws when `CONTEXTZERO_ENV_FILE` names a file
that does not exist or cannot be read. With the variable unset, an absent
`.env` is still permitted.

**Why it is not arbitrary.** Both config modules loaded the file quietly and
discarded the result, so a wrong path produced no error and no log line; the
process came up with nothing configured and failed later with "SASL: client
password must be a string", which names neither the file nor the fact that it
was never read. The variable is set deliberately by the installer, so its
absence is a configuration error, while Docker legitimately supplies values
through the environment alone.

**Verified against.** `load-env.test.ts` (missing file, unreadable path,
explicit file overriding an ambient value, absent `.env` permitted when nothing
names one); `run-real-db-tests.mjs` refuses a missing file the same way.

**Regression looks like.** A password error from a bridge whose real problem
is a moved `.env`.
