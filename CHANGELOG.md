# Changelog

All notable changes to Context Zero Engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — Ingestion architecture

### Changed

- **LSH bands moved onto `semantic_vectors` as an array; the `lsh_bands` table
  is gone.** Profiling a real 235-file ingest showed `batchEmbedSnapshot` was
  **130.8s of 244s — 53.4% of total ingestion time**. Breaking that phase down
  further put the cost squarely on writes, not maths: TF-IDF 938ms, MinHash
  4,211ms, band computation 104ms, **database flush 136,182ms (94.5%)**.

  The cause was volume and index size. `lsh_bands` held one row per
  (symbol_version, view, band) — 64 rows per symbol — and had reached
  **21,246,299 rows / 2,919 MB with a 1,234 MB primary key**. Every inserted
  band row carried an `ON CONFLICT` probe into that B-tree, so ingestion got
  slower as the database grew. The same repository ingested into an empty
  database spent 13.5s on flush versus 136.2s on the loaded one: identical
  work, **10.1x slower purely from accumulated index size**.

  `semantic_vectors` already holds exactly one row per (symbol_version, view),
  which is the grain a band array needs. Folding the band index into the band
  hash (`computeBandKeys`) makes "shares band i at band i" expressible as an
  array overlap, which GIN answers directly — so the separate table became
  redundant and 64 rows per symbol became 0.

  Measured back-to-back on the same snapshot in the same database, under the
  same load — old architecture **261,809ms**, new architecture **19,213ms**,
  a **13.6x speedup** on the phase that dominated ingestion.

  Equivalence is proven rather than assumed: across 780 MinHash signature
  pairs, array overlap returns exactly the same candidate decision as the
  retired `(band_index, band_hash)` tuple match. False negatives — an LSH
  correctness failure — cannot occur, because identical bands always encode to
  identical keys. Collisions can only add a candidate, which exact cosine
  re-scoring then discards.

  The GIN index was kept on evidence, not instinct: at snapshot scale the
  planner does use it (16-21ms lookups), and it costs ~17% on writes.

### Fixed

- **Kotlin extracted a fifth of the symbols it should have.** Measured across
  1,126 real Kotlin files: 2.1 symbols per file against TypeScript's 10.8.

  The generic CST walker looked for a declaration's member container by field
  name only — `childForFieldName("body")`, `("class_body")`, `("members")` —
  and returned if none matched. tree-sitter-kotlin exposes `class_body` as a
  plain named child, not a field, so every lookup returned null and entire
  class bodies were discarded with no warning, no error, and no confidence
  penalty. One 66KB service yielded a single symbol standing in for 1,500
  lines; its parse tree held 59 `function_declaration`, 126
  `property_declaration` and 3 `class_declaration` nodes, all reachable, none
  extracted. That file now yields 124 symbols.

  Containers are now matched by node type as well, and a declaration whose body
  cannot be identified falls through to a child walk instead of returning —
  losing a class body is worse than attributing a member to the wrong parent.

  `getNodeName` also now looks one level into declarator-style wrappers.
  Kotlin's `internal val iconInfo: ImageVector by lazy { … }` parses as
  `property_declaration > [modifiers, binding_pattern_kind,
  variable_declaration, property_delegate]`, with the identifier nested inside
  `variable_declaration`, so a depth-1 scan found no name and dropped the
  symbol. Top-level properties are ordinary Kotlin.

  Measured A/B on identical file sets — **kotlin 2.11 → 12.27 per file
  (+481%)**, with swift, rust, cpp, csharp and bash all unchanged. The other
  languages reach their symbols through dedicated handlers or grammars that do
  expose the body as a field.

### Measured but rejected

Two optimisations were tested against the real database and abandoned on the
evidence, recorded here so they are not attempted again:

- **`minhash_signature` as `INTEGER[]` instead of `BIGINT[]`** would halve the
  largest column, but MinHash values are unsigned 32-bit: `LARGE_PRIME` is
  4294967291 and the observed maximum across 170,763,520 stored values is
  4294967295, well past signed `INTEGER`. The conversion would silently corrupt
  signatures.
- **`jsonb_to_recordset` bulk insert** in place of chunked multi-row `VALUES`
  measured **1.4x slower** (2002ms vs 1407ms for 8,000 rows) — JSON
  serialisation costs more than the round-trips it saves. The existing
  multi-row insert is already the right shape.

## [2.5.2] — First-run fix

### Fixed

- **The documented install failed on the first command.** `.env.example`
  shipped `NODE_ENV=production`, and the README says to copy it and fill in
  your database credentials. `production` enables the deployment guards —
  including a refusal to start against a weak database password — so pointing
  it at an ordinary local Postgres died with *"Refusing to start with an
  insecure database password in production"* before the first migration ran.
  The guard is correct; the default was wrong for a tool whose documented
  install is one developer on one machine. `.env.example` now defaults to
  `development` and spells out exactly what switching to `production` enforces
  and when to do it.

  Verified by migrating a virgin database from zero following the README
  verbatim: 18/18 migrations applied, doctor 15/15 with no warnings, and an
  ingest → resolve → capsule round trip on the fresh database.

## [2.5.1] — Correctness and availability fixes

Ten defects found in a line-level audit of the shipped 2.5.0 tree, plus two
more caught by standing up a fresh install and running it. Two silently
disabled whole subsystems in long-running deployments, one is a reachable hang,
and one could stop a clean checkout from booting in Docker. Nothing here
changes an API shape.

### Fixed

- **Advisory locks leaked, silently disabling ingestion and retention.**
  `pg_try_advisory_lock` / `pg_advisory_unlock` were issued through
  `db.query()`, which runs each statement on an arbitrary pooled client.
  Advisory locks are *session*-scoped, so the unlock could land on a different
  backend, return `false` (a server WARNING, not an error — the existing
  `.catch()` never fired) and leave the lock held for the life of the
  connection that took it. From then on every `scg_ingest_repo`,
  `scg_incremental_index` and retention run for that key short-circuited with
  "already in progress" and returned zeroes. On the long-running HTTP server
  that meant retention stopped permanently — unbounded snapshot growth, the
  exact failure retention exists to prevent. Added `db.tryAdvisoryLock()`,
  which pins one connection for the critical section and reports a failed
  unlock, and moved all three call sites onto it. (`runPendingMigrations()`
  already did this correctly by hand and was unaffected.)
- **Incremental indexing served pre-edit code from cache.**
  `ingestIncremental` deletes and re-creates the `symbol_versions` for every
  changed file, but invalidated only the two `profileCache` entries per symbol.
  `queryCache` kept handing out the deleted `symbol_version_id`s from its
  `resolve:` entries for 60s, and `symbolCache` then answered lookups for those
  dead ids out of memory — returning the **pre-edit `body_source` for up to
  five minutes with no database row behind it**. Capsule and homolog caches
  held derived analysis of the same. All five caches are now cleared after an
  incremental pass, matching full ingestion.
- **Catastrophic backtracking in `scg_search_code` could hang the process.**
  The ReDoS filter only recognised a quantifier written directly inside a flat
  group, so the overlapping-alternation family passed straight through:
  `(a|aa)+$` took ~900 ms against a 30-character line and `(a|a?)+$` never
  returned at all. The pattern is caller-supplied, Node has no regex timeout
  and the engine is single-threaded, so one such search stalls everything.
  Fixed in two tiers. The static detector now flags any quantified group
  containing an alternation or a nested quantifier, and those fall back to
  escaped-literal search. Because a static check can never be complete — a
  group-free pattern like `a*a*a*…$` backtracks exponentially and no detector
  of this kind will see it — the scan now also runs in a **worker thread with
  a hard `terminate()`** when the pattern is capable of backtracking at all.
  That is the only bound Node actually offers: a runaway `RegExp.test` never
  yields, so in-process timers can never fire. Patterns with no quantifier,
  alternation or backreference are provably linear and skip the thread
  entirely, so ordinary substring searches pay nothing. A scan that overruns
  returns `timed_out: true` instead of hanging.
- **Two patches for the same file left a half-applied change set.** Both staged
  at the same `<path>.scg-tmp`; the first rename consumed it and the second
  failed `ENOENT`, aborting the batch *after* earlier files had already been
  renamed into place. Duplicate paths are now rejected up front on both the
  HTTP and MCP surfaces (separator- and `.`-segment-insensitive).
- **Deleted files were never removed from the index.** An incremental pass
  cleaned up a deleted file's symbol versions but left its `files` row, so the
  path stayed in the index permanently — repeatedly re-read and skipped by
  `scg_search_code`, and still counted by `scg_codebase_overview`.
- **Paginated symbol loading could end a scan early.**
  `loadSymbolVersionsBySnapshotPaginated` derived its cursor from the rows that
  survived validation, so a dropped trailing row rewound onto already-returned
  ids, and a page where every row was dropped returned a `null` cursor —
  silently ending the scan mid-snapshot. The cursor now tracks the last raw row.
- **MCP tool auth used a non-constant-time comparison.** The `_auth_token` gate
  compared with `!==`, whose early exit leaks a prefix-length oracle — at odds
  with the timing-safe guarantee the HTTP surface implements and SECURITY.md
  advertises. Now uses a padded `crypto.timingSafeEqual`.
- **Dead branch in the auth failure-map cleanup**, whose comment described an
  OR rule while the code implemented AND, plus a second condition that was a
  strict subset of the first. Behaviour is unchanged; the rule is now stated
  once and correctly.
- **Migration checksums depended on the checkout's line endings.**
  `.gitattributes` pinned `eol=lf` for the source and config file types but not
  for `.sql`, so `* text=auto` handed Windows clones CRLF migrations and
  Linux/Docker clones LF ones — and hashing raw bytes made the same migration
  fingerprint two different ways. On a development box that was a startup
  warning; under `NODE_ENV=production`, which is what `docker-compose.yml`
  sets, the runner throws "Refusing to continue", so a clean checkout could
  fail to boot against its own database purely because of the operating system
  it was cloned on. Line endings and a leading BOM are now normalised before
  hashing; databases holding the old raw-bytes value are recognised as the same
  SQL and upgraded in place rather than reported as drift, so existing installs
  converge instead of breaking. `*.sql` is pinned to `eol=lf` to stop the
  divergence at the source.
- **`npm run doctor` validated a configuration the engine never loads.** It
  always read `<repoRoot>/.env`, ignoring `CONTEXTZERO_ENV_FILE` — which is how
  every MCP client launches the bridge — and merged with the opposite
  precedence to `config.ts` (`{...fileEnv, ...process.env}`, where the engine
  uses dotenv `override: true` and lets the file win). A stray shell variable
  was enough to make doctor report one allowed base path while the engine used
  two. It now resolves the same file with the same precedence, and names any
  key where a shell variable and the env file disagree.

### Testing

1,493 tests (up from 1,445), in four new suites:

- `advisory-lock` — pins lock and unlock to one connection, and covers the
  contended, throwing and double-release paths.
- `search-redos` — asserts the previously-allowed catastrophic patterns now
  degrade to literal search while ordinary regexes still compile.
- `search-scan` — runs against a real temporary directory (no fs mocks) for
  path containment, deadline and unreadable-file handling, plus three
  worker-containment tests proving a runaway match is killed and the main
  thread stays responsive.
- `migration-checksum` — LF/CRLF/CR and BOM equivalence, real SQL changes still
  detected, and a sweep asserting every shipped migration hashes the same
  however it was checked out.

CI now builds before running tests: worker threads load JavaScript only, so
without a compiled `dist/` the containment tests skip and the execution bound
goes unexercised.

## [2.5.0] — Type-resolved effect analysis

The effect/behavioral layer stops guessing. Measured on the ground-truth
fixture suite (`npx ts-node scripts/effect-eval.ts`): **100% precision /
100% recall** across 22 labeled functions and 8 effect categories, vs
**50% precision / 68.8% recall** for the previous pattern-based analyzer
on the identical suite. (Fixture-suite numbers, not a field study — the
suite includes the known failure traps, and the eval script is shipped so
the numbers are reproducible. Unresolvable receivers in the wild — `any`
typed, dependency-injected clients — still produce no tag by design.)

### Added

- **Type-resolved effect analyzer for TypeScript/JavaScript**
  (`src/adapters/ts/effect-resolver.ts`). Every call and `new` expression
  is resolved through the TypeScript checker back to the module its
  receiver comes from (import declarations, `require()` initializers,
  one-hop local aliases like `const pool = new Pool()`, declaring-file
  package names) and classified from a curated module map (node builtins,
  pg/knex/prisma/mongo/…, axios/undici/got/…, ioredis, child_process,
  jsonwebtoken, zod, …). Raw SQL first-arguments are sniffed to split
  db_read / db_write / transaction. Effectful globals (fetch, WebSocket,
  localStorage) are tagged only when they genuinely resolve to the
  ambient lib — a local `fetch` shadow doesn't count.
- **Arrow-function coverage**: `const f = async () => { … }` bodies now
  get behavioral hints at all — the previous analyzer only hinted
  `function`/method declarations, which silently skipped the dominant
  modern style.
- **Ground-truth eval harness** (`scripts/effect-eval.ts` + labeled
  fixtures + a CI regression test) so effect-analysis quality is a
  number, not an adjective.
- **Benchmark refresh on four real production repositories** (46–2,411
  files): exact-symbol token savings measured at 63.0% / 73.0% / 97.3% /
  98.6% — see BENCHMARKS.md "Real-Project Benchmark Refresh".
- **JS retry with `allowJs` forced**: repositories whose tsconfig lacks
  `allowJs` used to silently produce zero symbols for their .js/.mjs
  scripts; those files are now re-extracted per-file with allowJs on.

### Fixed

- **Interactive statement timeout killing ingest queries.** The 2.4.0 fix
  covered bulk INSERT transactions, but long SELECTs inside persistence
  (symbol maps, relation resolution) could still hit the 30s session cap
  on a busy database and cost a whole extraction batch. Default session
  `statement_timeout` is now 120s (`DB_STATEMENT_TIMEOUT_MS` to override)
  — sized for a local single-user engine where protecting ingestion beats
  sniping slow interactive queries.

### Changed

- **Syntactic patterns no longer produce external-effect categories in
  TS/JS.** db/network/file/cache guesses (`.request(` on any object,
  `WebSocket` in a type position, `.get(` as a DB read) were the false-
  positive factory; those categories now come exclusively from the
  type resolver. Patterns still cover local categories (throws/catches,
  state mutation, locks, serialization, validation, logging,
  `.transaction(`).
- **Framework-pattern mining in the effect engine is scoped**: skipped
  entirely for TS/JS (the resolver owns externals), and for the other
  languages it now scans literal-and-comment-blanked text with tightened
  patterns (`stripe`/`twilio`/`s3` require a member call; bare `.get`/
  `.find`/`request` removed).
- **Transitive effect propagation is bounded and filtered**: only kinds
  that stay meaningful across a call boundary propagate (db/network/
  file/emits/auth/locks/throws — not logging, normalization, or
  receiver-local mutation), propagation stops after 4 hops, and cycle
  clusters union only their members' DIRECT effects. This ends the
  smearing that once put a Stripe call on a license-file helper.

## [2.4.0] — Robustness release

Found by running the engine against a 2,300-file monorepo through the MCP
bridge and fixing everything that broke. Ingestion reliability, Windows
support, and analysis precision all improve; several failures that used to
be silent are now loud and attributed.

### Fixed

- **Whole-repo ingestion loss on a single failure.** TypeScript extraction
  and persistence ran inside one try/catch — any throw marked EVERY
  TypeScript file in the repository as failed (observed live: 2,254 of
  2,277 files lost, with the actual error never surfaced). Extraction now
  isolates failures per batch, falls back to per-file extraction inside a
  failing batch, and reports `failed_files` plus a `failure_summary` with
  actual reasons in the ingestion result.
- **Self-inflicted database overload.** Homolog scoring fanned out one
  concurrent scoring task per candidate, each issuing DB queries — large
  candidate sets flooded the pool queue and tripped the driver's overload
  rejection, killing the whole call (`scg_find_homologs` returned
  "Internal server error"). Scoring is now bounded (8 concurrent), and the
  overload threshold is configurable (`DB_MAX_WAITING_QUERIES`, default
  8x pool size, was a hard-coded 2x).
- **`packages/` silently skipped during ingestion.** The NuGet-cache
  heuristic fix now applies to the DB ingestor's directory walk, not just
  native discovery — JS/TS monorepo sources under `packages/` are indexed.
- **6-level validation was dead on Windows.** The sandbox spawned bare
  `npx`, which Node refuses to spawn on Windows (CVE-2024-27980 blocks
  `.cmd` without a shell). Type checking, per-file syntax checks, and test
  runs now resolve the tool's JS entry (`typescript/lib/tsc.js`,
  `jest/bin/jest.js`, `mocha/bin/mocha.js`) and execute it with the
  engine's own `node` binary — identical behavior on every platform, and
  the sandbox can no longer trigger npx's install-on-miss.
- **`UserFacingError` swallowed into "Internal server error".** The MCP
  bridge now passes through errors that are built to be user-facing
  (bad-input 400s, not-found 404s) instead of masking them.
- **Windows path-separator chaos.** Snapshots ingested on Windows stored
  backslash paths, which broke `file_pattern` filtering (silent 0
  matches), collapsed the codebase-overview directory breakdown into "."
  and made `scg_apply_patch` reject the exact paths other tools handed
  out. All repo-relative paths are now stored and returned in portable
  forward-slash form; patch/changed-path inputs accept either separator
  (traversal checks run AFTER normalization, so `..\..\` is still
  rejected); pattern filtering and directory aggregation are
  separator-agnostic for pre-fix snapshots.
- **Phantom side effects from comments and string literals.** TypeScript
  behavioral hints were pattern-matched against raw source, so a
  `// TODO: call .destroy()` comment or a pattern-table string literal
  registered as a real side effect — and transitive propagation smeared
  it across the call graph (the engine's own effect-pattern table
  "called Stripe"). Hints now scan code-only text: string/template/regex
  literal contents and comments are blanked via the AST before matching,
  with quotes preserved so quote-anchored patterns (`.query("`) still
  fire.
- **Version drift.** Health checks and MCP server info reported a
  hard-coded "2.0.0"; they now report the real package version.
- **tsconfig parse crashes.** A malformed or unresolvable tsconfig
  (bad `extends`) no longer aborts extraction — the engine falls back to
  default compiler options and flags `incomplete_type_info`.
- **Repo identity hijack via ingest.** Ingesting an already-registered
  path under a different name silently RENAMED the canonical repository
  row — after which anything keyed on the old name (cleanup scripts,
  humans) operated on the wrong repository. Identity now changes only on
  explicit registration; ingest callers reuse the existing row as-is.
- **Bulk writes killed by the interactive statement timeout.** The
  session-wide 30-second `statement_timeout` is sized for interactive
  queries; bulk ingest INSERTs on a busy or vacuum-lagged database
  legitimately run longer and died with "canceling statement due to
  statement timeout" — which was the root cause behind lost extraction
  batches. Bulk writes now `SET LOCAL` their own bounded timeout
  (default 180s, `DB_BULK_STATEMENT_TIMEOUT_MS`) scoped to the write
  transaction; interactive queries keep the tight default.

### Changed

- **`scg_ingest_repo` is delta-by-default.** The MCP ingest now links the
  latest complete snapshot of the repo+branch as parent, so unchanged
  files are bulk-copied instead of re-parsed (a no-change re-index of a
  2,300-file monorepo drops from ~13 minutes of re-extraction to roughly
  the file-hashing time). The response includes
  `delta_parent_snapshot_id`; passing an explicit `commit_sha` still
  works, and a missing/incomplete parent falls back to a full ingest.
- **Long extractions yield to the event loop** (every 25 files and
  between batches), so the MCP server keeps answering health checks and
  other tools during a large ingest instead of freezing for minutes.
- `AdapterExtractionResult.failed_files` and
  `IngestionResult.failure_summary` are new optional fields — additive,
  no breaking shape changes.

## [2.3.0] — Initial public release

First open-source release of Context Zero Engine under the Apache-2.0
license.

### Highlights

- **15-language ingestion**: TypeScript/JavaScript via the TypeScript
  Compiler API, Python via LibCST, and C/C++/CUDA-flavored sources, Go,
  Rust, Java, C#, Ruby, Kotlin, Swift, PHP, and Bash via a tree-sitter
  universal adapter — all normalized into one extraction format.
- **13 analysis engines** over a PostgreSQL-backed code graph: behavioral
  profiling, contract extraction, deep contract synthesis, effect
  signatures, blast radius, dispatch resolution, concept families,
  temporal intelligence, symbol lineage, runtime evidence, uncertainty
  tracking, structural graph, and capsule compilation.
- **61 MCP tools** over stdio plus a **60-route HTTP API** sharing the
  same transport-agnostic service layer; 3 native filesystem tools work
  without a database.
- **Precise call graph by default**: the structural graph engine treats
  canonical names as a multi-map and drops ambiguous matches instead of
  resolving to an arbitrary candidate; precise dispatch resolution is the
  points-to analyzer's job.
- **Nested symbol extraction across all tree-sitter languages**, including
  anonymous object method overrides (a common Kotlin listener pattern)
  captured as first-class symbols.
- **Behavioral fingerprint gating for concept families** — naming-based
  clusters are sub-bucketed by purity class and effect set, eliminating
  false groupings driven purely by name similarity.
- **Transactional editing** with a 9-state lifecycle, DB-backed file
  backups, sandboxed validation, and rollback.
- Reproducible benchmark suite (`scripts/bench-*.ts`) — see
  [BENCHMARKS.md](BENCHMARKS.md).

### Known limits

- Behavioral pattern matching does not yet detect SQL built via template
  literals or variable interpolation; such functions may report a lower
  purity class than runtime behavior implies.
- CUDA `.cu`/`.cuh` files are parsed through the C++ grammar; kernel
  semantics are not modeled separately.
- PHP and Bash pass adapter validation, but no repository-scale benchmark
  claims are made for them yet.
