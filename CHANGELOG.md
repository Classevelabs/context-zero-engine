# Changelog

All notable changes to Context Zero Engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**Upgrade note.** Migration 025 changes how sparse vectors are stored and
empties `semantic_vectors`; the table cannot be converted in SQL because the
new keys are computed in the application. Semantic search and homolog
similarity return nothing for a repository until its next ingest, which
re-embeds it against the stored corpus. Nothing else is lost.

### Performance

Measured on a fresh database, wall clock for a full ingest, before and
after this batch: gin 17.6 s to 11.6 s, flask 28.6 s to 15.4 s, this engine
56.8 s to 36.2 s. A second ingest of gin with one file touched: 12.4 s to
4.2 s, extracting 1 file instead of 99.

- **Relations are resolved once per snapshot, after every file's symbols
  exist.** They were resolved per file, rebuilding the identity index each
  time and asking the database for every name the index did not hold: 3.8 s
  of gin's ingest, 11.9 s of flask's, 19.0 s of this engine's. One pass over
  the complete index also lets a relation reach a symbol in a file persisted
  after its own, and there is no database fallback and no cap on the index:
  gin now keeps 3,789 relations (3,422 before).
- **Every engine's batch insert folds identical single-row inserts into
  multi-row statements.** The shared helper handed the database one
  round-trip per row for every engine (21,849 for this engine's relations
  alone). Runs of statements with identical text now go as one statement
  per chunk with renumbered placeholders; updates and CTEs run as written;
  a chunk that would touch the same conflict row twice is rolled back to a
  savepoint and replayed row by row, so every caller keeps its semantics.
- **Delta ingest is the default, for every caller.** Only the MCP handler
  looked up the parent snapshot; the REST server, the benches and scripts
  re-parsed every file and re-ran every engine on each ingest. The ingest
  entry now takes the latest complete snapshot of the repository and branch
  as parent unless told otherwise.
- **Engines carry unchanged work forward instead of redoing it.** With a
  fully refined parent, a version with the same body and signature keeps
  its symbol's invariants (re-verified in one statement, not mined again)
  and its effect signature's direct entries (transitive entries are rebuilt
  by propagation over the whole graph); a file with the same content keeps
  its symbols' blame commit sets (`symbol_history`, migration 033), so the
  temporal pass blames only changed files: 1.7 s to 115 ms on the one-file
  pass. Deep-contract paging moved from OFFSET, quadratic in the snapshot,
  to a key cursor.
- **Rename candidates come from an index, not a scan.** Lineage ranked every
  same-kind old symbol by edit distance for every new symbol; candidates are
  now the old symbols sharing the most name bigrams plus those sharing the
  body or normalized-AST hash.
- **The native symbol search parses a file once per version.** Every search
  re-parsed the workspace; a parse is reused while the file's size and
  mtime hold, bounded at 4,000 files.
- **Validation of a change is a delta ingest of the base snapshot**, which
  the two changes above make proportional to the patch rather than the
  repository.

### Added

- **A large class ships as a skeleton.** When a class or interface body
  would take more than a third of the capsule budget, the capsule carries
  its header and one signature line per member, with a fetch handle for
  each member's body, and spends the rest of the budget on what the class
  actually depends on. Measured on class targets before this: 57.7%
  dependency recall at 6,470 tokens, most of it spent on member bodies the
  caller could fetch by handle.
  Measured on the same 29 class targets of this engine, same database,
  12,000-token budget, switch off against on: 13.8% to 44.4% of 201 indexed
  dependencies delivered, median capsule 7,903 to 7,912 tokens.
- **A class's blast radius includes its members' callers.** The class node
  alone has almost no callers; its methods do. Class and interface targets
  now widen to their members before any dimension runs, and the report says
  how many were added (`member_targets`).
- **The semantic diff of a class reports its members.** A removed member is
  breaking, a changed body major, an added member minor; before this a
  class diff compared the class node's own, nearly empty, profile.
- **The quality benchmark measures Python and Go, not only TypeScript.**
  Dependency ground truth now comes from Python imports (absolute and
  relative, module or member) and Go package imports resolved through
  go.mod, so recall is measured on the languages the engine indexes rather
  than stated for one and assumed for the rest.
- **A qualified call resolves through the file's imports.** `json.Unmarshal`
  in a Go file that imports `.../internal/json`, `util.helper` in a Python
  file that imports `pkg.util`, a Java class imported by path: the name
  before the dot is the package or module the file imports under that
  name, and the member is looked up there. An import path is matched to the
  snapshot's files and directories by its longest trailing segments, so no
  module root has to be known. Before this, a qualified call fell to the
  repository-wide bare name and was dropped whenever two packages exported
  it.
- **The benchmark's targets are library code.** Test functions are excluded
  from the target population unless `CZ_BENCH_INCLUDE_TESTS=1`: a test's
  dependencies are its fixtures and the standard library, which says
  nothing about the graph, and on gin they were 37 of 60 targets.
- **The benchmark counts what it could not answer.** A target the capsule
  compiler fails on, or answers with fewer than 50 tokens, used to vanish
  from the denominator; it is now a failed task, reported with its reason,
  and `contextzero_recall_incl_failures_pct` carries its dependencies. The
  naive baseline's 25-file cap is a stated parameter, and the uncapped cost
  of reading every file that mentions the symbol ships beside it.

### Changed

- **A snapshot no longer copies every symbol's source text.** Bodies live
  in `symbol_bodies`, one row per distinct text keyed by its SHA-256, and a
  version row carries `body_ref` (migration 030, which moves existing text
  over and drops `symbol_versions.body_source`). Two versions with the same
  text share one row, across snapshots and within one: a class's text used
  to be stored again inside each of its members' rows. On the local
  twenty-snapshot database 584,411 version rows carried 58,259 distinct
  bodies. Every reader joins the body by reference; nothing a tool returns
  changes.
  Measured on the local database (26,359 versions, 25,689 distinct bodies,
  mostly one snapshot per repository): migrations 030 to 032 ran in 4.7 s;
  after the table rewrite that returns the dropped column's space (`VACUUM
  FULL symbol_versions`, 1.2 s) the version table went from 39 MB to 27 MB
  and the body table holds 17 MB, so a database with little duplication
  pays about 5 MB for the second table and its index. On the bench database,
  four snapshots of this engine share 16,919 bodies across 20,149 versions.
  The saving grows with snapshots per repository, which is what incremental
  ingest and the watcher produce; a fresh ingest of gin stores 1,691 distinct
  bodies for 1,715 versions and a capsule for its largest function carries
  the full 12,702-character body through the join.
- **The capsule compilation log is gone.** `capsule_compilations` recorded
  a row per compiled capsule with a JSON rationale for every included and
  omitted node; nothing read it back, and it was the one table that grew
  with reads rather than with code. Migration 031 drops it. The capsule
  itself carries the decisions (`omission_rationale`, `fetch_handles`,
  `token_estimate`).
- **A transitive effect entry no longer repeats its origin as text.** The
  `[transitive from <id>] ...` string was 147 bytes on 17,318 of 20,100
  effect entries locally and said what `origin_symbol_version_id` and
  `hops` already say. `detail` is now present only on direct observations.
- **Retention reclaims derived rows.** A new last phase removes bodies no
  version references (an hour after they were written, so an ingest in
  flight is never cut out from under), invariants whose verifying snapshot
  is gone, and dead lineages whose birth and death snapshots are both gone;
  a living lineage keeps its history after the snapshot it was born in
  expires. None of these were ever pruned: snapshot deletion cascades to
  rows that reference a snapshot and these deliberately do not. The cleanup
  log's list of operations now admits the phase (migration 032); its first
  run had reclaimed rows and then failed to record that it had.
- **Bench scripts bring their scratch database's schema current before
  ingesting.** `bench-storage` failed on the first column a migration had
  added since the scratch database was last touched.

### Fixed

- **Historical co-change claimed symbol pairs that no line supported.**
  Symbol pairs were derived from files: every symbol in a changed file
  "co-changed" with every other, capped at fifty per commit, so one commit
  touching two ordinary files produced up to 1,225 symbol pairs. On the local
  database that was 87,804 rows and 28 MB, and blast radius listed whole
  files as a symbol's historical partners. File-level history is exact and
  now has its own table (`temporal_file_co_changes`, migration 029). Symbol
  pairs come from `git blame`: the commits that last touched each symbol's
  lines, so two symbols co-changed only when the same commit last touched
  lines of both. Blame runs within a wall-clock budget
  (`SCG_TEMPORAL_BLAME_BUDGET_MS`, 60 s); files it does not reach keep
  file-level history and are counted in the ingest log. Risk scores use the
  same attribution. Both tables are rewritten on every run, so a pair that
  history no longer supports does not linger, and `get_co_change_partners`
  returns symbol partners and file partners as separate lists. Rows computed
  before the migration are removed; the next ingest of each repository
  recomputes them. Measured in a fresh database on this engine's own repository (71
  commits, 164 files): 159 of 161 files blamed in 3.9 s, 650 file pairs,
  90 symbol pairs, 142 relations, 6,178 risk rows; gin's 98 files blamed
  in 1.6 s and flask's 66 in 1.2 s. Lines the working tree has changed
  since the last commit belong to no commit and are left out.
- **Blast radius rated every pure caller "high" and every strong
  body-derived invariant "critical".** A pure or read-only caller's
  assumption is something to re-check, not a known break, and is now medium;
  the structural dimension already rates direct callers high. An invariant
  is critical only when the code enforces it (an assertion or a validation
  schema) at strength 0.9 or above; one derived from the body's shape tops
  out below high. File co-change partners are reported on the partner file's
  module symbol at low severity instead of being fanned out over every
  symbol in the file.
- **Effects found by regular expressions looked the same as type-resolved
  ones.** Every effect entry now says where it came from (`source`:
  `behavioral_profile`, `contract_profile` or `heuristic_pattern`), and a
  heuristic entry carries its own `confidence` of 0.5. Nothing is removed;
  readers can now tell a checker-verified network call from a word match.
- **A quarter of all invariants described the body instead of constraining
  it.** `null_safety` (`x ?? d`, `x?.m()`), `closure` (a count of nested
  functions) and `closure_binding` (uses `this`) were 18,676 of 75,889
  invariant rows on the local database and promised callers nothing. They
  are no longer emitted; explicit null checks, return shapes and
  higher-order facts stay. A symbol also keeps at most 40 invariants,
  strongest first: the 99th-percentile symbol carried 23, the largest 129.
- **Concept families were seeded by name suffix.** When homolog edges were
  sparse, every `*Service` was joined to every other `*Service` at a
  synthetic 0.45, which made a family out of a naming convention. The seed
  now groups symbols of one kind by the callees they share: the edge is the
  Jaccard overlap of their callee sets, needs at least two shared callees
  and an overlap of 0.5, and ignores callees with more than 200 callers.
- **Concept family members were lost whenever two clusters shared a name.**
  The family upsert kept the existing row and its id, but the members were
  written under a freshly generated id, so the foreign key failed, the
  transaction rolled back, and the whole family pass was skipped as
  "non-fatal": one error line per ingest on gin, flask and this engine, and
  no family members for any of them. Members now use the id the database
  returns.
- **Homolog search scored twenty arbitrary same-kind symbols per target and
  ran two queries per candidate.** The "same kind" bucket returned whichever
  rows the planner produced first and each cost seven scoring dimensions; it
  is gone. Test overlap and co-change history are now loaded once per target
  and looked up per candidate, instead of two queries each.
- **Tree-sitter languages and Python kept a fraction of the relations they
  extracted.** Three defects, one mechanism. A relation whose source is the
  file itself — an import, a module-level call — had no symbol to come from:
  every file now has a module symbol, keyed `<path>::__module__`, and a
  file-level source resolves to it whether the adapter wrote the bare path or
  the module key. Call text was matched against bare names or nothing:
  resolution now walks the caller's scopes outward — the same file, the same
  directory (the package in Go, Java, C# and Kotlin), then the repository —
  and `Owner.member` text finds that owner's member wherever it lives; only a
  unique match at a scope counts, and the database is asked by the identifier
  a chain ends in rather than the whole chain. Measured on the same
  repositories in a fresh database: gin keeps 36.3% of its extracted
  relations (19.4% before), flask 37.0% (6.5% before), with flask's import
  edges 2 to 140.
- **Dispatch resolution was dead for Go, Java, C#, Kotlin and PHP.** The
  owning class was parsed from a dot in the canonical name or a `#` in the
  key, and the tree-sitter adapter writes neither, so gin produced 0 dispatch
  edges with 428 methods. Every adapter now records a member's owner as a
  column (`symbols.parent_name`, migration 028); a Go method's owner is its
  receiver type; and a chain rooted at a typed parameter or receiver — `c` in
  `c.JSON(...)` inside `func (c *Context)`, a `Context ctx` in Java, `ctx:
  Context` anywhere — is resolved from that type, where before only `this`
  and `self` chains were collected at all.
- **TypeScript properties, accessors, interface members and enum members were
  resolution targets but never symbols.** A reference to `this.config` or
  `Color.Red` resolved to a key nothing carried and the edge was dropped. They
  are symbols now, keyed under their owner; a getter and its setter are one
  member; interface and enum members are visited under their owner rather
  than the owner's parent. The engine's own tree gains 1,967 property symbols.
- **The Python extractor carried two dead method bodies.** In a class body
  the last definition of a name wins silently, so the first
  `_extract_contract_hint` and `_collect_raised_exceptions` never ran and an
  edit to either read as a fix while changing nothing. The dead copies are
  removed — output on a real module is byte-identical — and a test fails on
  any class-level name defined twice.
- **Bodies of every language were tokenized with the JavaScript rules.**
  Python, Ruby and shell comments and Python docstrings stayed in as code, and
  each language's keywords were its most frequent tokens, so a search for what
  code does matched `def`, `self`, `func` and `nil`. Comments are stripped the
  way the language writes them and each language brings its own keyword list.
- **`scg_explain_relation` had never once answered.** Its query joined
  `evidence_bundles` on `inferred_relation_id`, a column that table does not
  have; the relation row carries `evidence_bundle_id`. Every call failed with
  "column eb.inferred_relation_id does not exist". It joins on the id the row
  carries.
- **`scg_review_homolog` had never once recorded a review.** It set
  `updated_at` on `inferred_relations`, a column the table never had, so the
  update failed on every call; the reviewer's name was accepted, logged, and
  dropped. Migration 027 adds `reviewed_at` and `reviewed_by`, and a review
  writes the state, the time and the reviewer.
- **A test's invariant sat on the test, not on what it tests.** Test-derived
  invariants were scoped to the test symbol with the expression "asserts
  behavior of target symbol", so the target never saw them and blast radius
  marked the test critical for asserting itself. They now attach to each
  symbol the test reaches through its edges, named after both; a test that
  reaches nothing asserts nothing the graph can attach.
- **Invariant lookup picked an arbitrary snapshot's set.** "Most recent" was
  computed by sorting `last_verified_snapshot_id`, a random UUID. It is now the
  snapshot's creation time.
- **Resolving a symbol without a snapshot returned one row per snapshot.** Up
  to the retention cap of identical rows differing only in version id. Without
  a snapshot, the repository's latest indexed snapshot is meant, and now used.
- **Code search unioned every snapshot's files and truncated in silence.** A
  file deleted since the earliest kept snapshot stayed searchable, and a
  repository past the 10,000-file cap lost the rest with nothing to say so.
  Search scans the latest indexed snapshot and reports `files_truncated` when
  it stops short.
- **`scg_plan_change` resolved candidates from the whole task sentence.** The
  sentence was handed to name similarity as one string, so forty characters of
  prose were compared against every symbol name and the candidates were
  whichever names shared the most trigrams with the English. The names a task
  mentions — quoted spans, camelCase and snake_case words, dotted paths, words
  that are not ordinary prose — are now resolved one by one, the best match per
  symbol kept; when none resolves, the task is run through semantic search over
  code bodies instead. The plan's assumptions say which route produced the
  candidates.
- **A mangled dash in the rollback error.** An em dash written through the
  wrong code page reached the message as three stray characters.
- **A capsule shipped 14 tokens more than its own estimate said.** The row id
  of the persisted compilation record was attached after the estimate was
  taken, and nothing reads that id back through any tool. It is no longer
  shipped, and a test now holds `token_estimate` to the serialized size of
  exactly what ships, with and without inclusion reasons.
- **Class capsules recalled about one dependency in eight.** A class holds
  almost no edges of its own: its collaborators are named in its methods and,
  for injected dependencies, in its constructor's parameter types, and those
  members are tied to the class only by line-range nesting. The dependency
  loader read the target's own edges and nothing else, so 94% of a class's
  missed dependencies sat one hop away. A target of kind class, interface or
  enum now draws its dependencies from every symbol nested in its range, minus
  edges back into the container; functions and methods keep their own edges
  only, so a nested closure is never mistaken for a dependency. Measured on the
  nest repository with the same targets before and after: class recall 12.5% to
  57.7%, with the capsule growing from 4,367 to 6,470 tokens; function and
  method capsules byte-identical. `SCG_CAPSULE_MEMBER_DEPS=0` restores the old
  query.
- **Constructors were not indexed**, so a class built by dependency injection
  read as isolated: `constructor(private config: ApplicationConfig)` produced
  no edge at all. A constructor is now a `method` symbol named `constructor`,
  with behaviour and effect hints. `SCG_INDEX_CONSTRUCTORS=0` reverts.
- **A JavaScript repository was compiled one file at a time.** A group of
  plain JS files under a tsconfig without `allowJs` (or under no tsconfig, where
  the defaults leave it off) was refused wholesale by the program and then
  re-extracted file by file, each with a fresh program that reloaded the whole
  standard library: a 141-file repository spent about 110 s repeating that
  instead of the 2 s one shared program costs. JS is accepted up front for such
  a group. Measured: express 119 s to 13 s; react from about an hour to 5.9 min.
- **Python extraction spawned one interpreter per file**, paying the libcst
  import and process startup every time — a 3,000-file repository spent about
  twenty minutes almost entirely in startup. `extractor.py --batch` extracts
  200 files per interpreter, results travel through a file keyed by path, a
  per-file failure is isolated to that file, and a batch that cannot run falls
  back to the per-file path. Measured: django 21 minutes to 8.9 minutes with
  identical symbols.
- **A re-index with nothing changed minted a full duplicate snapshot.** Every
  full pass wrote a new snapshot — a complete copy of the repository's symbol
  versions and everything derived from them — even when every file matched the
  parent by content hash. On the measured database twenty snapshots held
  584,411 symbol versions for 58,259 distinct bodies. An unchanged repository
  now reuses its parent snapshot and reports `unchanged: true`.
- **Embedding a symbol against a missing corpus wrote plain term-frequency
  vectors.** With no IDF corpus every token took a default weight of 1.0, so
  the stored vector disagreed silently with its neighbours. A snapshot with no
  corpus now takes the full embedding pass, which builds one, and a batch loads
  the corpus once rather than once per symbol.
- **A wrong `CONTEXTZERO_ENV_FILE` surfaced as a password error.** Both config
  modules loaded the file quietly and discarded the result, so a path that did
  not resolve produced no error and the process came up with nothing
  configured, failing later with "SASL: client password must be a string". An
  explicitly named file that does not exist or cannot be read now fails at
  startup and says which file. `npm run doctor` already reported this; the
  runtime agrees with it.
- **A client that closed its pipe left the bridge running.** Windows delivers
  no signal to a child whose parent died, and a client exiting without
  signalling leaves the bridge indexing and holding its advisory locks; four
  such orphans were found alive on one machine, the largest at 1,806 MB. End,
  close or error on stdin now triggers the same graceful shutdown as SIGTERM.
- **Shutdown closed the connection pool under the startup retention pass.**
  The bridge fires retention on startup without awaiting it, and a short
  session — the CI cold-start smoke is one — shut down while that pass was still
  running, so its remaining phases each failed with "Database driver has been
  closed": four error lines per session that every check still passed. A
  runner now keeps one pass in flight, shutdown waits for the phase that is
  running, and the pass starts no further phase once a stop is requested.
  The same drain applies to the HTTP interface's scheduled pass.
- **Every Docker install crash-looped on first boot.** Compose mounted
  `db/schema.sql` into `docker-entrypoint-initdb.d`, so Postgres created every
  table, and the server's migration runner then met tables with an empty ledger,
  failed `001_initial_schema.sql` on `relation "repositories" already exists`,
  refused to start, and restarted forever. The README's documented install
  path had never worked on a clean machine. Docker now uses the migration
  runner like every other install.
- **The package-boundary gate died on npm 12**, whose `npm pack --json` returns
  an object keyed by package name where every earlier client returned an array.
  Both shapes are read, and neither carrying a file list fails with a sentence
  rather than a stack trace.
- **Lint failed on every push over one loop form**: `while (true)` in the
  tsconfig walk, a constant condition under eslint 8. It is now `for (;;)`, the
  form the other unbounded loops here already use.
- **Module-level destructured declarations are indexed.** `export const { query,
  transaction } = db` declares real, importable names. The TypeScript adapter
  skipped the whole declaration and recorded a `destructuring_binding_skipped`
  flag, so those names had no symbol: nothing for an import to resolve against,
  nothing for an edge to land on, and every consumer of `query` read as
  depending on nothing. Each binding element with a concrete name is now its own
  symbol, nested patterns included; the shared initializer is walked once, under
  the first binding, so its calls are not attributed to every name in the
  pattern. Measured effect on this repository's own ingest: +6 symbols, +34
  relations (0.16%).

### Changed

- **A session lists only the tools it can call.** Every listed tool's schema
  rides in the model's context on every turn, and the 61 schemas came to
  49,360 bytes — about 12,300 tokens per turn, before any question is asked.
  Seventeen of those tools are refused outright while
  `SCG_MCP_MUTATIONS_ENABLED` is off, which is the default, so they are no
  longer registered until it is on; the server's connect message tells the
  session once that they exist and where the switch is. A default session now
  lists 44 tools at 28,491 bytes, about 7,100 tokens per turn.
- **`_auth_token` is part of a tool's schema only when a secret exists for it
  to match.** Without `SCG_MCP_SECRET` or `SCG_MCP_ADMIN_SECRET` the field was
  6,588 bytes of every tool list, describing a check that never ran. With
  mutations enabled and no secret, the full 61-tool list is now 42,745 bytes.
- **Responses are compact JSON.** Pretty-printing was a tenth of every capsule
  and a twenty-fifth of every smart context in whitespace, measured on a real
  repository: a capsule that cost 14,558 bytes now costs 12,507 for the same
  content.
- **Capsules ship inclusion reasons only on request.** The one-line reason
  attached to every context node was 646 bytes of a 14.5 KB capsule, prose the
  consumer never acts on. `scg_compile_context_capsule` takes `explain: true`
  to attach them; by default they are neither shipped nor priced, and the
  cache never serves an explained capsule to a plain request.
- **Semantic vectors are stored packed, and a MinHash signature only where it
  carries signal.** On a database of 584,411 symbol versions `semantic_vectors`
  held 5,857 MB, 2,928 MB of it the signature column, 2,360 MB of that on the
  four views whose average width is 0 to 5 tokens — sets the sparse vector
  already described exactly. A signature is now stored as packed `bytea`, only
  for a view of 8 or more tokens; a narrower view is compared by exact Jaccard
  over the sparse vector's keys, which is the value the signature estimated
  (migration 023). Sparse vectors are six bytes per term — a 32-bit token hash
  and a 16-bit quantized weight — instead of 28.2 as JSONB, where 98,924 terms
  drew on 4,930 distinct tokens and each token was spelled out about twenty
  times (migration 025). The surrogate `vector_id` is gone; the natural key is
  the primary key.
- **Semantic search retrieves through an inverted index.** Search was built on
  the LSH band index, which answers "is this a near-duplicate of that", not
  "which bodies contain these terms": a short query never collides with a long
  body, so every search fell through to a linear scan that decoded every vector
  in the snapshot — 583 ms at p50 on a 22k-symbol repository while the band
  index, the largest in the database, showed 0 scans. The body view now carries
  its distinct token hashes under a partial GIN index, and a query probes with
  its most distinctive hashes. A symbol sharing no term with the query scores
  exactly zero, so this is the exact candidate set, not an approximation
  (migration 026). Band keys remain for homolog candidates.
- **Hash indexes match the queries that use them, and autovacuum keeps up.**
  Three homolog dedup indexes were never scanned because every lookup is
  snapshot-scoped and the planner preferred the snapshot index; they now lead
  with `snapshot_id`. Two indexes no query could use are dropped. Sixteen
  churn tables get fixed-count vacuum and analyze thresholds instead of a
  percentage, so a 2.9-million-row table is vacuumed after a bounded amount of
  garbage rather than after 580,000 dead tuples (migration 024).
- **Delta ingest carries vectors, the IDF corpus and effect signatures
  forward** for files whose content hash matches the parent, and embeds only the
  symbols extraction produced. Recomputing vectors for unchanged code was the
  single most expensive part of an incremental pass.
- **TypeScript extraction runs in a child process that exits.** A compiler
  program loads every transitively imported file plus the ambient type surface;
  on a 151-file tree extraction took the process from 75 MB to 852 MB resident,
  and V8 never returned the pages — the heap fell to 188 MB after collection
  while RSS stayed at 844 MB. In a long-lived bridge one index left the process
  ten times larger for its life. The compiler now runs in a worker that exits,
  and only its result crosses back through a file. `SCG_TS_ISOLATED=false`
  extracts in-process.

### Added

- `scripts/bench-storage.mjs` reports what an index costs against the source it
  describes, split into heap and index and per vector column, and what a
  second pass over unchanged source writes — which should be nothing and for a
  long time was not. `scripts/bench-e2e.mjs` measures ingest, storage, every
  read handler's latency at p50/p95/p99 over rotating inputs, and how many of
  those calls actually returned an answer.
- The quality benchmark takes `CZ_BENCH_ORDER=det`, which picks the same
  targets on every run so a before/after isolates the change, and
  `CZ_BENCH_KIND`, which restricts targets to one symbol kind.
- `BEHAVIOUR-DECISIONS.md` records why the engine behaves as it does where the
  code alone does not say so, and what a regression looks like from the user's
  side.
- A test fails when `db/schema.sql` is older than the newest migration; the
  file had been generated before migration 026 existed and shipped without it.
- A test reads every SQL literal in the source and checks each column it
  names — `alias.column`, `UPDATE … SET column`, `INSERT INTO table (columns)`
  — against the shipped schema. The driver is mocked in unit tests, so a column
  that does not exist was only ever found by PostgreSQL, in production. Across
  384 literals it found exactly the two broken tools above and nothing else.
- Migration 027: `inferred_relations.reviewed_at` and `reviewed_by`.
- The CI cold-start smoke fails on any error-level log line. The retention
  race above logged four while every existing check passed. It also fails if
  a mutation tool is listed while mutations are off, and records the size of
  the tool list.
- `.env.example` documents `SCG_TS_ISOLATED`, `SCG_INDEX_CONSTRUCTORS` and
  `SCG_CAPSULE_MEMBER_DEPS`.

### Security

- **The API interface accepted unauthenticated network traffic outside
  production.** The startup guard demanded `SCG_API_KEYS` only under
  `NODE_ENV=production`, so a non-production process told to listen on
  `0.0.0.0` — the address the bundled Compose file uses — served the network
  with no authentication. Any non-loopback bind that carries no API keys is now
  refused regardless of `NODE_ENV`; the policy lives in `bind-guard.ts` as pure
  functions with unit tests.
- `SECURITY.md` names `security@classeve.com` for reports.
- Every third-party action in the workflows is pinned to a commit SHA; a tag
  can be moved, a commit cannot.
- The `fast-uri` and `qs` advisories the audit gate failed on are resolved by
  transitive patch releases; nothing in `package.json` moves.

### Testing

- The install path the README prints is now run in CI: copy the Docker env
  example, set the three values, `docker compose up -d`, wait on the image's
  own health check, then assert that `/health` answers, a protected route
  refuses a caller with no key, and the configured key is accepted on a route
  that reads the database. The gate's env substitution set values in place
  rather than appending duplicates, and the authenticated `/ready` proves the
  migration ledger is populated rather than empty behind a pre-seeded schema.
- The quality benchmark resolves ESM specifiers: `import "./core.js"` where the
  file on disk is `core.ts` was unresolvable, which read out as 0% recall on
  modern repositories that in fact delivered their dependencies. It also
  measures TypeScript and JavaScript recall only; other languages' ground truth
  is not parsed yet.
- Watcher tests drive the debounce through the captured `fs.watch` callback
  and fake timers instead of writing real files and sleeping past an OS event,
  which raced under parallel load.

### Documentation

- `TECHNICAL_DESIGN.md` describes the packed vector storage, the signature
  threshold, and the search index.
- **BENCHMARKS.md: the unnamed clean-ingest figure is withdrawn.** The
  2026-08-20 run (2,637 files, 29,791 symbol versions, 34,818 relations, 5m 55s,
  ~7.4 files/sec) never recorded which repository it ingested, and the database
  has since been rebuilt, so the corpus cannot be identified and the run cannot
  be reproduced. It is replaced by a named, reproducible engine self-ingest and
  documented as withdrawn rather than deleted.

---

## [2.13.0] — Resolve the way the compiler resolves

Cross-file helper delivery on the 375k-line benchmark monorepo rose from
54% to 69% overall — 75% of everything the index has any record of — and on
the mixed second corpus from 45% to 72%. Three causes, all in how references
were resolved to declarations:

### Fixed

- **One tsconfig governed a whole monorepo.** Extraction built its programs
  from the repository-root tsconfig, but path aliases like `@/*` live in the
  per-package tsconfigs — so every `@/context/layout` import in every package
  was unresolvable, the checker returned nothing for any name that arrived
  through one, and the reference produced no edge. Files are now grouped by
  the tsconfig that governs them — the nearest one walking up from each file,
  the way the compiler, the editor and the bundler all resolve — and each
  group gets a program built with its own options. Structural relations on
  the benchmark monorepo: 131,850 → 228,202.
- **A method reached through an instance could not resolve.** Class members
  are indexed as `Class.member`, but keys were built from the bare symbol
  name, so `db.query(...)` emitted `file#query`, matched nothing, fell back
  to name matching, and was dropped as ambiguous. Keys now carry the class
  qualifier the index uses.
- **The benchmark's "delivered" check under-credited small constants.** It
  required 40 characters of code, so a fully delivered one-line constant
  scored as a miss. Delivery is now the capsule's own resolution marker:
  full source shipped, at any length; a stub at no length.

Measured limit, stated as found: doubling the token budget does not raise
helper coverage — the remaining misses are functions whose helpers cannot
physically fit beside them and declaration shapes the indexer does not yet
record, not selection or budget.

## [2.12.0] — A test is code

### Fixed

- **Test content was invisible to the graph.** `describe(...)` and `it(...)`
  are expression statements, not declarations, so a walker that only extracts
  declarations stored nothing for them: the calls a test makes to the code it
  exercises produced no edges, test artifacts had almost nothing to relate,
  and a capsule could link a covering test for barely one symbol in twenty.
  A leaf test or hook (`it`, `test`, `bench`, `beforeEach`, …) is now a symbol
  of its own — kind `test_case`, named by its title, its body walked for
  relations like any function. A suite (`describe`) contributes its title to
  the keys of the tests inside it and is not itself a symbol, so nothing is
  attributed twice; `it.todo` and bodiless suites are swallowed. On the
  375k-line monorepo this adds 9,317 test-case symbols and 72k relations, and
  a capsule now links a covering test for 27% of targets, up from 5% — with
  the test's own source included when the budget allows, which doubles as a
  usage example.
- **Every module-level constant wore the label `function`.** classifyKind was
  handed the VariableStatement, which is none of the kinds it tests for, so
  20,000 constants on the same monorepo fell through to the default. A
  declaration whose initializer is a function is a `function`; anything else
  is a `variable`. Contract mining, dispatch resolution and search filters all
  select by kind and now see the truth.

Capsules also rank real test cases ahead of test-file helpers when choosing
which tests to ship.

## [2.11.0] — The signature is part of what a symbol depends on

### Fixed

- **A type used only in a signature produced no edge at all.** Relation
  extraction walked a function's body and nothing else, so
  `function handle(evt: GlobalEvent): AgentInstance` recorded no dependency on
  either type. Type-only imports are the common shape for that, so those
  symbols read as depending on nothing and their capsules arrived without the
  types they take and return. Parameters, type parameters and the return type
  are now walked alongside the body — which also picks up parameter default
  values, ordinary expressions that were equally invisible. Structural
  relations on a 375k-line monorepo: 115,220 to 131,850.
- **A dependency reached through a module namespace was invisible.** With
  `export * as Provider from "./provider"`, the receiver in `Provider.helper`
  resolves to the source file itself and carries a quoted path for a name, so
  it could never match a symbol; worse, that unmatched name fell through to
  name matching and could land on an unrelated symbol elsewhere. Namespace
  receivers are now rejected outright, and the member reached through them is
  resolved to its own declaration, which is the thing the calling code actually
  depends on.

Measured on the same 1,000 randomly sampled functions with the same
disk-derived ground truth, pointing the benchmark at the old graph and the new
one: cross-file helpers delivered rose from 44.1% to 53.6%, and from 48.9% to
57.6% of those the index has any record of.

### Changed

- Benchmarks are stated in files, lines of code and tokens — what a job costs —
  rather than in ratios and coverage percentages. `bench-context-quality.mjs`
  reports those units directly, and `CZ_BENCH_SNAPSHOT` pins a snapshot so the
  same ground truth can be pointed at two graphs, which is the only way to
  attribute a change to the engine rather than to the measurement.
  `CZ_BENCH_DIAGNOSE=1` splits every miss into "no edge was recorded" and
  "an edge exists and was not chosen", because those need different fixes.

## [2.10.0] — The capsule stops paying for its own waste

An instrumented audit of shipped capsules on a 375k-LOC monorepo found roughly
half of every capsule spent on photocopied effect entries, duplicate nodes, and
uncounted bookkeeping. All four causes are fixed; on the same corpus and
benchmark the average strict capsule fell from 7,825 to ~2,900 tokens while
delivered cross-file dependencies rose, and quality per token tripled
(0.46 → ~1.3 checkable facts per 1,000 tokens). See BENCHMARKS.md for the
full before/after.

### Fixed

- **Effect cycle recovery unioned weakly connected components, not cycles.**
  Symbols left over after acyclic effect propagation were clustered by BFS over
  both edge directions, fusing nearly all of them into one blob whose unioned
  effects were stamped onto every member — 99.0% of all stored effect entries
  (696,940 of 703,997) were that photocopy, and 6,021 functions were
  mislabelled `full_side_effect`. Recovery now computes true strongly connected
  components (iterative Tarjan) and processes them sinks-first, so only genuine
  mutual recursion shares a fate and cross-component effects propagate with
  real hop counts. After re-ingest, 36 cycle entries survive and 153 functions
  carry the maximal label. Re-ingest to regenerate stored signatures.
- **Capsule loaders returned one row per relation, not per symbol.** A
  dependency that is both called and referenced arrived twice, was pasted at
  full source twice, and consumed two slots of the load limit. Dependency and
  caller queries now select one row per symbol with the strongest relation
  (calls > inherits/implements > typed_as > references), and a symbol whose
  source is already in the capsule ships as a one-line signature instead of a
  second copy.
- **Capsule budgets bound a subset of the payload.** Budgeting summed raw text
  of chosen pieces while the shipped JSON also carried the full effect array,
  a per-node rationale ledger, and structural overhead — `token_estimate`
  averaged 40.7% of true size and 203 of 400 capsules overshot their budget.
  Every piece is now priced at serialized byte cost, the rationale ledger is
  persisted to `capsule_compilations` instead of shipping, effects ship once
  (deduplicated, direct-first, transitive tail capped at 15) and are counted,
  `token_estimate` is the measured size of the capsule itself (±0.5%), and a
  final enforcement pass guarantees the budget. Token math is byte-based; the
  previous UTF-16 count under-measured unicode-heavy source by up to half.
- **`scg_smart_context` had the milder form of the same accounting gap.**
  Entries now charge their serialized cost including metadata, the omission
  list is capped at 25 named entries plus a rollup, and `token_usage.used`
  reports the measured size of the whole result.

## [2.9.0] — Every symbol contributes its references

### Fixed

- **Most symbols were indexed but emitted nothing.** Relation extraction ran
  only for `FunctionDeclaration` and `MethodDeclaration`. Everything else —
  arrow functions assigned to a const, function expressions, constructors,
  accessors, class property initializers, interfaces, type aliases — was stored
  as a symbol and contributed no edges at all. `const Foo = () => {...}` is the
  dominant style for components and handlers in modern TypeScript, so on a
  375k-line monorepo 13,205 of 20,244 symbols classified as functions emitted
  nothing, and every one of 5,184 type aliases and 853 interfaces emitted
  nothing. A symbol that is present but silent is worse than one that is
  missing, because the gap does not show.

  Extraction now runs for every symbol-bearing node, walking the part of the
  declaration that belongs to that symbol: a function's body, a variable's
  initializer, a class's property initializers — not its methods, which are
  symbols in their own right and would otherwise have their calls attributed
  twice.

- **A concise arrow body was walked past.** `() => load()` has the call as its
  body rather than inside a block, and the walker descended into children
  before testing the node it was given, stepping over the only relation such a
  symbol has.

- **A symbol used without being called produced no edge.** The walker
  recognised calls, JSX elements and type references. A constant read in a
  comparison, an enum member, a schema passed as an argument, a handler placed
  in a lookup table — none of those are any of the three, so every module-level
  constant in the repository read as dead code. Identifier references now
  resolve through the checker, restricted to declarations at module scope:
  locals and parameters describe the inside of one function rather than how the
  repository fits together, and would bury the real structure.

- **Capsules presented mentions as callers.** Caller selection accepted `calls`
  and `references` and ordered them by confidence, which is a constant for
  statically extracted edges. Once references became plentiful they crowded
  genuine callers out of the limit. Calls now rank ahead of references, which
  restored caller precision and brought capsules back inside their token budget.

  Same corpus, against 2.7.0: symbols with inbound edges 30.1% to 72.4%,
  symbols emitting edges 28.1% to 61.9%, structural relations 27,450 to
  113,459, symbols carrying known effects 926 to 9,222, recorded effect facts
  40,122 to 799,699 — while a full ingest got faster, 466s to 350s. In compiled
  capsules at the default 8k budget, a verified caller is present for 80% of
  targets, up from 48.7%, and effects for 66.7%, up from 10.3%.

## [2.8.0] — Call targets resolve to declarations

### Fixed

- **Most of the call graph pointed at the wrong symbol, or at nothing.** Call
  targets were resolved by name, and a name does not identify a symbol: a call
  written `db.query(...)` carries only `query`, and any repository of size has
  many symbols called `query`, `run` or `handle` — a monorepo that vendors a
  dependency has two of everything. The resolver held one symbol per name and
  the database fallback selected `DISTINCT ON (canonical_name)`, so every such
  call was attributed to one arbitrary symbol. That symbol accumulated callers
  it never had, and the genuine targets showed none: on a 375k-line monorepo
  only 30% of symbols had any inbound edge, and functions with dozens of real
  call sites read as dead code.

  Adapters that can resolve a declaration exactly now report it. The TypeScript
  adapter follows the receiver's type and any import alias through the compiler
  to the declaration itself, so `db.query` resolves to the method on that class
  rather than to whichever `query` was indexed last. Name matching remains for
  adapters without type resolution, but only when the name is unambiguous — an
  ambiguous name now records nothing rather than a confident wrong edge.

- **Rendering a component was not treated as calling it.** `<Header />` runs
  `Header`, but it is a JSX element rather than a call expression, so a walker
  looking only for calls recorded nothing. Every component in a user interface
  therefore read as uncalled, and "what breaks if I change this?" answered
  nothing for the part of a repository people actually see. Component usage is
  now an edge to the component's declaration; intrinsic elements (`div`,
  `span`) are correctly not treated as symbols.

- **Effect signatures were mostly empty as a consequence.** Transitive effect
  propagation walks the call graph, so a graph that could not resolve its own
  edges had no path to propagate along. With targets resolving correctly, the
  same corpus went from 926 symbols carrying known effects to 4,907, and from
  40,122 recorded effect facts to 332,035.

### Added

- `scripts/bench-quality.mjs` — measures what a token reduction actually costs
  in completeness. Both sides receive the same budget, and are scored on facts
  that can be checked exactly: the implementation, a caller whose own source is
  verified to reference the target, and the interface. A reduction figure on its
  own is not evidence — returning nothing is a 100% reduction — so cost and
  completeness are now reported together from one run.

## [2.7.0] — A self-maintaining index

### Added

- **The index follows the code.** `npm run watch` keeps every registered
  repository current: changes are folded into the existing snapshot within
  seconds of hitting disk, with no re-ingest, no scheduled job and no editor
  plugin. Set `SCG_WATCH=true` to start it alongside the MCP server. It observes
  the filesystem only, so it behaves identically whether the code is edited by an
  IDE, a coding agent, a script, or a branch switch. Edits are batched over a
  quiet period, so a formatter sweep costs one pass rather than hundreds, and
  each repository is held under an advisory lock so several connected clients
  cost one watcher rather than a race.

- **Two refinement tiers for incremental indexing.** `refine: "deferred"` (the
  edit-time default) re-extracts changed files and re-embeds their symbols in
  seconds; `refine: "full"` also recomputes lineage, dispatch, effects, deep
  contracts, concept families and the embedding corpus across the snapshot.
  Deferred work is recorded on the snapshot as `refinement_pending_since` and
  reported by `scg_snapshot_stats`, and the watcher settles it while the tree is
  idle. Per-symbol data for changed files is current either way.

- **`scg_incremental_index` identifies its own target.** It now accepts
  `repo_path` — the repository root or any file inside it — resolves the
  repository's most recent snapshot when `snapshot_id` is omitted, and takes
  absolute or repo-relative changed paths.

- **A `partial` snapshot names what is missing.** Failing paths are stored on the
  snapshot and surfaced through `scg_snapshot_stats` as `files_unindexed` /
  `unindexed_paths`, and listed in the warning attached to query results, so an
  incomplete index can be checked against the question being asked and repaired
  file by file instead of by a full re-ingest.

### Fixed

- **Incremental indexing could drop a file's symbols and still report the
  snapshot as complete.** Invalidation deletes a changed file's symbol versions
  before re-extraction; an extraction that then failed was logged and otherwise
  ignored, leaving the symbols absent from a graph that still described itself as
  complete. Callers of that file read as uncalled. Every extraction path now
  records its failures, and the snapshot's status is reconciled at the end of the
  pass.

- **`index_status` could not recover.** Incremental passes never wrote it, so a
  snapshot marked `partial` stayed `partial` after the offending file was fixed,
  and a file that broke during an incremental pass never marked it at all. The
  status now moves in both directions as files are repaired or broken.

- **Class hierarchy was built twice on every ingest.** `resolveDispatches` builds
  it as its first step; both the full and incremental paths called
  `buildClassHierarchy` immediately beforehand, duplicating the whole pass.

- **Embedding dominated the cost of a small change.** An incremental pass rebuilt
  the entire snapshot's vectors and IDF corpus. Changed symbols are now embedded
  against the stored corpus, which is what makes edit-time indexing viable at all.

- `SCG_LOG_LEVEL_OVERRIDE` sets the log level for embedded callers. `LOG_LEVEL`
  is loaded from the env file with `override: true`, so a CLI or watcher could
  not quiet the engine except by redirecting stderr, which discards real failures
  along with the noise.

## [2.6.0] — Ingestion architecture and write-path integrity

### Security

- **A read-only API key could reach the admin-only HTTP routes.** Express matches
  routes case-insensitively and ignores a trailing slash, but
  `requirePrivilegedHttpRoute` compared the raw `req.path` against an exact
  allowlist. `POST /scg_apply_patch/` and `POST /SCG_APPLY_PATCH` therefore
  reached the same handler as `/scg_apply_patch` with the admin check skipped —
  patch application, commits, rollbacks and repository registration were
  reachable with an ordinary key. The gate now matches on the same normalised
  form Express routed on. The `/scg_admin_*` routes were never exposed: they
  carry their own `requireAdminKey` behind the global gate.

- **A dangling symlink could be written through under `allowMissing`.**
  `existsSync` stats through a link, so a dangling one read as absent and the
  nearest-existing-ancestor walk stepped straight over it, returning a path whose
  link component was never resolved. Recreating the target afterwards turned that
  into a write outside the repository base. The walk now uses `lstat`, so it
  stops at the link and the containment check sees the unresolved target.

- Patch backups take one file handle and `fstat` through it rather than calling
  `stat` and `readFile` on the name separately, so the regular-file and size
  checks describe the same object the bytes come from.

- `scripts/setup.mjs` and `scripts/doctor.mjs` wrote credentials to `.env` with
  `"` escaped as `\"`, which dotenv does not unescape — a `DB_PASSWORD`
  containing a quote came back different from the one that was typed. Values are
  now placed in a quote style dotenv reads back literally, and a value that
  cannot be represented is refused instead of silently corrupted.

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

- **Behavioral and contract profiles are written in bulk.** Persistence ran one
  round-trip per symbol; it now chunks 500 rows per statement, de-duplicating
  within a chunk so `ON CONFLICT DO UPDATE` cannot touch the same row twice.

### Fixed

- **A single NUL byte in a source file destroyed the batch it landed in.**
  PostgreSQL `text` cannot hold `0x00`, so one file containing one drove the
  whole multi-row `INSERT` to error out — taking every other row in that batch
  with it. On one workspace this cost **686 files** in a single run, and left the
  snapshot `partial`, which the read guard then correctly refused to answer
  from. Parameters are now stripped of NUL in the database driver, inside
  strings and inside array parameters alike. The driver is the single boundary
  every write crosses, so no extractor, present or future, can reintroduce it.

- **Re-ingesting a symbol deleted the edges pointing *at* it.** The cleanup
  before a re-extract removed relations matching the symbol on either end
  (`src_symbol_version_id ... OR dst_symbol_version_id ...`), so re-indexing one
  file silently severed inbound edges owned by files that had not changed.
  Callers disappeared from `scg_get_symbol_relations` and blast radius
  under-reported. Cleanup now removes only the relations the re-extracted
  symbol owns.

- **A blocked ingest reported success.** When another ingest held the
  repository advisory lock, the second call returned a normal result with zero
  counts — indistinguishable from a repository that genuinely had nothing to
  index. It now returns an error carrying `error_code: "INGEST_LOCK_HELD"`.

- **Reads could answer from an incomplete snapshot.** A snapshot left `partial`
  or `failed` still served queries, so a caller received a confidently-shaped
  answer computed over a fraction of the repository. The read path now checks
  snapshot status and says the index is incomplete instead of guessing.

- **Snapshots abandoned mid-ingest stayed `indexing` forever.** A crashed or
  killed ingest left a row no later run would reconcile, and the repository
  looked permanently busy. Retention now closes out snapshots stuck past
  `SCG_STUCK_INDEXING_TIMEOUT_MINUTES` (default 180).

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
