# Changelog

All notable changes to Context Zero Engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
