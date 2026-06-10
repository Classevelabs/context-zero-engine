# Changelog

All notable changes to Context Zero Engine are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
