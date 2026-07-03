# Context Zero Engine

[![Latest release](https://img.shields.io/github/v/release/classeve-public/context-zero-engine)](https://github.com/classeve-public/context-zero-engine/releases/latest) [![License](https://img.shields.io/github/license/classeve-public/context-zero-engine)](LICENSE)

**A local code-intelligence engine for AI agents.** ContextZero indexes a
repository into a PostgreSQL-backed code graph and serves structured,
token-budgeted context — symbols, dependencies, effects, contracts, similar
code, and blast radius — over MCP and HTTP. Everything runs on your machine;
nothing leaves it.

Built by [ClassEve](https://classeve.com). Licensed under Apache-2.0.

---

## The Problem

Coding agents and developer tools usually inspect source one file at a time.
On a non-trivial codebase that means opening dozens of files, re-reading the
same code across tasks, manually tracing transitive effects — and still
missing contract assumptions or behaviorally similar code elsewhere in the
repository.

ContextZero indexes the repository once and answers the same investigation
with targeted queries: *give me this symbol with its dependencies and
contracts*, *what breaks if I change it*, *where else does this logic exist*,
*which tests cover it*. In recorded benchmark runs this cut the tokens an
agent consumed by **63–92% depending on repository size** (12.4x on VS Code,
12.9x across seven multi-language repos). See [BENCHMARKS.md](BENCHMARKS.md)
for full methodology, results, and honest caveats.

---

## What It Computes

| Capability | Description |
|-----------|-------------|
| **Context Capsules** | Token-budgeted context packages: source, dependencies, contracts, and effects in one call, with a 5-level degradation ladder. |
| **Blast Radius** | 5-dimensional impact analysis (structural, behavioral, contract, homolog, historical) with severity and confidence scoring. |
| **Behavioral Profiling** | Every function classified: pure / read_only / read_write / side_effecting, with transitive propagation through the call graph. |
| **Effect Signatures** | 9 typed effects (reads, writes, opens, throws, calls_external, logs, emits, normalizes, acquires_lock) propagated transitively. |
| **Contract Extraction** | Input/output types, error contracts, security contracts, guard clauses, derived invariants — mined from the code itself. |
| **Homolog Detection** | Finds behaviorally equivalent code (not just textual clones) via 7-dimensional evidence scoring with contradiction flags. |
| **Smart Context** | One call: source + blast radius + callers + tests + contracts. Replaces 8+ separate lookups. |
| **Dispatch Resolution** | Class hierarchy, virtual call resolution, C3 linearization, field-sensitive points-to analysis. |
| **Concept Families** | Automatic grouping of related symbols with exemplar identification, outlier detection, and contradiction flagging. |
| **Temporal Intelligence** | Git-derived co-change analysis, temporal risk scoring, churn metrics. |
| **Symbol Lineage** | Cross-snapshot identity tracking through renames and refactors. |
| **Transactional Editing** | 9-state change lifecycle with DB-backed rollback and 6-level progressive validation. |
| **Semantic Search** | Find code by what it does: TF-IDF + MinHash LSH similarity. No external APIs, no embedding service. |
| **Uncertainty Tracking** | 12-source uncertainty model with per-symbol confidence scoring — the engine tells you what it is *not* sure about. |

## 15 Languages

TypeScript, JavaScript, Python, C, C++, CUDA-flavored `.cu`/`.cuh`, Go, Rust,
Java, C#, Ruby, Kotlin, Swift, PHP, Bash.

TypeScript and JavaScript use full AST analysis through the TypeScript
Compiler API. Python uses LibCST with 60+ behavioral patterns. The remaining
languages use tree-sitter with language-specific walkers.

## How It Works

```
MCP-compatible client (Claude Desktop, Claude Code, Codex, Cursor, ...)
    |
    | MCP protocol (stdio)            HTTP clients
    |                                     |
ContextZero MCP Bridge (61 tools)    REST API (60 routes)
    |                                     |
    +------------------+------------------+
    |
    +-- Ingestor (15 languages, delta ingestion)
    +-- 13 Analysis Engines
    |     Behavioral | Contract | Deep Contract | Blast Radius
    |     Effect | Dispatch | Concept Families | Temporal
    |     Symbol Lineage | Runtime Evidence | Uncertainty
    |     Structural Graph | Capsule Compiler
    +-- Semantic Engine (TF-IDF, MinHash LSH, cosine similarity)
    +-- Homolog Engine (7-dimensional scoring)
    +-- Transactional Editor (sandboxed validation, rollback)
    +-- Service Layer (transport-agnostic services)
    +-- Database Driver (circuit breaker, batch loader, advisory locks)
    |
PostgreSQL 16 (all data local, nothing leaves your machine)
```

The `scg_` prefix on tools and environment variables comes from the engine's
internal name for its data model — the structural code graph.

Deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) (subsystems and tool
registry) and [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) (data structures,
algorithms, engine internals).

---

## Install

### Prerequisites

- **Node.js** 20+ (22 recommended)
- **PostgreSQL** 14+ (16 recommended) with the `pg_trgm` extension
- **Python 3** with `libcst` (optional — only for Python source analysis)

### Bootstrap (recommended)

```bash
git clone https://github.com/classeve-public/context-zero-engine.git context-zero-engine
cd context-zero-engine
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Client claude
```

macOS / Linux:

```bash
scripts/bootstrap.sh --client claude
```

The bootstrap installs dependencies, creates `.env`, builds, runs database
migrations, runs diagnostics (`npm run doctor`), and optionally writes the
MCP config for your client (`claude`, `codex`, `cursor`, or `all`).

### Manual install

```bash
npm install

createdb scg_v2
psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

cp .env.example .env    # set DB_USER / DB_PASSWORD / SCG_ALLOWED_BASE_PATHS

npm run build
npm run db:migrate
npm run doctor          # verifies node, database, python, env
```

Full options, client config paths, and troubleshooting:
[docs/INSTALL.md](docs/INSTALL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## Quickstart

### 1. Wire it into an MCP client

The bundled installer writes the config (with a timestamped backup of the
existing file) for Claude Desktop, Codex, or Cursor:

```bash
npm run mcp:install -- --client claude
```

Or generate config snippets without touching client files
(`npm run mcp:config`), or register manually — for example with the
Claude Code CLI:

```bash
claude mcp add contextzero -s user \
  -e CONTEXTZERO_ENV_FILE=/absolute/path/to/context-zero-engine/.env \
  -- node /absolute/path/to/context-zero-engine/dist/mcp-bridge/index.js
```

Any MCP client that speaks stdio works: the server is
`node dist/mcp-bridge/index.js` with the `DB_*`/`SCG_*` environment (or a
single `CONTEXTZERO_ENV_FILE` pointing at your `.env`).

### 2. Index a repository

From the MCP client, call:

```text
scg_health_check                      → should report status: healthy
scg_register_repo / scg_ingest_repo   → index a repo under SCG_ALLOWED_BASE_PATHS
```

Then start asking: `scg_smart_context`, `scg_blast_radius`,
`scg_compile_context_capsule`, `scg_find_homologs`,
`scg_semantic_search`, ...

Three native tools (`scg_native_codebase_overview`,
`scg_native_symbol_search`, `scg_native_search_code`) work immediately
without a database — they analyze the filesystem directly.

### 3. Or run it as an HTTP server

```bash
npm run build
npm start          # HTTP server on port 3100
```

```bash
curl http://localhost:3100/health
curl -X POST http://localhost:3100/scg_codebase_overview \
  -H "X-API-Key: <your key>" -H "Content-Type: application/json" \
  -d '{"repo_id": "..."}'
```

60 routes (7 GET + 53 POST) mirror the MCP tool surface plus health,
readiness, Prometheus metrics, cache, and admin endpoints. All POST routes
require API-key authentication (`X-API-Key` or `Authorization: Bearer`).

### Docker (self-hosted server + bundled PostgreSQL)

```bash
cp .env.docker.example .env
# Set DB_PASSWORD and SCG_API_KEYS to strong secrets.
docker compose up -d
```

When registering repositories from Docker, use paths under `/repos` — that
is where `SCG_REPOS_PATH` is mounted inside the container.

---

## MCP Tool Surface (61 tools)

| Category | Count | Examples |
|----------|------:|----------|
| Core | 8 | `scg_health_check`, `scg_ingest_repo`, `scg_incremental_index`, `scg_codebase_overview` |
| Symbol Intelligence | 8 | `scg_resolve_symbol`, `scg_read_source`, `scg_semantic_search`, `scg_get_tests` |
| Behavioral & Contract | 8 | `scg_get_behavioral_profile`, `scg_get_invariants`, `scg_get_effect_signature` |
| Impact Analysis | 8 | `scg_blast_radius`, `scg_compile_context_capsule`, `scg_smart_context`, `scg_find_homologs` |
| Change Planning | 4 | `scg_plan_change`, `scg_prepare_change`, `scg_apply_propagation` |
| Code Graph | 8 | `scg_get_class_hierarchy`, `scg_get_symbol_lineage`, `scg_get_co_change_partners` |
| Transactional Editing | 6 | `scg_create_change_transaction`, `scg_validate_change`, `scg_rollback_change` |
| Data Management | 3 | `scg_list_snapshots`, `scg_batch_embed`, `scg_ingest_runtime_trace` |
| Native Workspace (no DB) | 3 | `scg_native_codebase_overview`, `scg_native_symbol_search`, `scg_native_search_code` |
| Admin | 5 | `scg_admin_run_retention`, `scg_admin_db_stats`, `scg_admin_system_info` |

The complete registry is in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Security

- **Local by design** — no telemetry, no external APIs; analysis and storage stay on your machine
- **SQL injection protection** — parameterized queries plus table/column allowlists for dynamic queries
- **5-layer path traversal protection** — null bytes, URL encoding, backslash handling, symlink escape checks, base-path boundary enforcement
- **Fail-closed authentication** — timing-safe comparison, 32-character minimum keys, per-IP brute-force lockout with exponential backoff
- **Sandboxed validation** — resource limits, process groups, SIGKILL escalation, environment sanitization
- **Hardened HTTP surface** — per-route rate limits and body-size limits, input validation on every route, sanitized error responses (no stack traces, paths, or SQL)

See [SECURITY.md](SECURITY.md) for the deployment hardening checklist and
how to report a vulnerability.

---

## Benchmarks

| Benchmark | Scale | Token reduction (exact-symbol baseline) |
|---|---|---:|
| Engine self-ingest | 105 files / 7,753 symbols | 2.71x (63.1% savings) |
| VS Code | 10,386 files / 125,777 symbol versions | 12.44x (91.96% savings) |
| 7 multi-language repos | Django, Prometheus, Tokio, Commons Lang, Serilog, OkHttp, Alamofire | 12.86x (92.2% savings) |

Methodology, per-repo tables, reproduction scripts, and the cases where the
gain is small: [BENCHMARKS.md](BENCHMARKS.md).

---

## Testing

```bash
npm test              # full unit suite (40 suites, 1,400+ tests)
npm run test:db       # opt-in integration test against a real PostgreSQL
npm run test:ci       # with coverage
npm run typecheck     # TypeScript strict mode
npm run lint
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/INSTALL.md](docs/INSTALL.md) | Install paths, MCP client configuration, diagnostics |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Day-to-day operation, indexing, network server mode |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture, subsystems, tool registry |
| [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) | Data structures, algorithms, engine internals |
| [BENCHMARKS.md](BENCHMARKS.md) | Benchmark methodology and results |
| [SECURITY.md](SECURITY.md) | Hardening checklist and vulnerability reporting |

---

## About

Built and maintained by [ClassEve](https://classeve.com) — engineering for AI agents and developer tooling. Project page: [classeve.com/public/context-zero-engine](https://classeve.com/public/context-zero-engine).

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026
[ClassEve](https://classeve.com).
