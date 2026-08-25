# Context Zero Engine

[![Latest release](https://img.shields.io/github/v/release/Classevelabs/context-zero-engine)](https://github.com/Classevelabs/context-zero-engine/releases/latest) [![License](https://img.shields.io/github/license/Classevelabs/context-zero-engine)](LICENSE)

**A local code-intelligence engine for AI agents.** ContextZero indexes a
repository into a PostgreSQL-backed code graph and serves structured,
token-budgeted context — symbols, dependencies, effects, contracts, similar
code, and blast radius — over MCP and HTTP. The engine and its database run
locally and do not require an external analysis or embedding API. If an
operator enables repository validation commands, those commands inherit the
repository's own behavior and may access the network.

Built by [ClassEve](https://classeve.com). Licensed under Apache-2.0.

> **Official repository.** This is the only official repository for Context Zero Engine.
> ClassEve's complete list of official accounts is at [classeve.com/official](https://classeve.com/official).
> The GitHub account `github.com/ClassEve` is an unrelated third party, not affiliated with ClassEve.

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
*which tests cover it*.

A reduction alone proves nothing, since returning nothing would score 100%. So
the measurement gives both sides the *same* token budget and scores what
survives. Across 400 random symbols in a 375k-LOC production monorepo, at the
8,000-token budget the tool defaults to, ContextZero carries the implementation
**100% of the time against 19%**, a verified caller **~76% against ~30%**, and
**about half of the cross-file imports the code actually uses, against ~0%** —
grep finds where a name is used, not what that name needs. That is **over 5x
more checkable fact per token**, at **10x fewer tokens** than grepping and
reading the matching files, or **7–10x fewer** than an oracle told in advance
exactly which files to open. The capsule reports its own size to within 0.5%
and stays inside the budget it is given.

An earlier release claimed 33.9x on a baseline inflated by duplicate source
trees; it is withdrawn, and the follow-up audit found — and fixed — the capsule
spending ~half its budget on internal waste. [BENCHMARKS.md](BENCHMARKS.md)
records the measurement, the correction, the repairs, and the places the engine
is still weak. Reproduce on your own repository with
`node scripts/bench-context-quality.mjs`.

---

## What It Computes

| Capability | Description |
|-----------|-------------|
| **Context Capsules** | Everything you need to understand a symbol in one call — source, dependencies, contracts, effects — inside a token budget you set. When the budget is tight it drops detail in five defined steps rather than truncating. |
| **Blast Radius** | What breaks if you change this. Scored across five kinds of coupling — structural, behavioral, contract, similar-code, and what has historically changed alongside it — with a severity and a confidence for each. |
| **Behavioral Profiling** | Functions are classified as pure / read_only / read_write / side_effecting. TS/JS external effects are **type-resolved** through the compiler. The shipped, author-designed fixture suite measured 100% precision and recall; this is regression evidence, not a claim of perfect accuracy on arbitrary repositories (see [BENCHMARKS.md](BENCHMARKS.md)). |
| **Effect Signatures** | What a function actually touches: nine typed effects (reads, writes, opens, throws, calls_external, logs, emits, normalizes, acquires_lock), each labelled as the function's own effect or one inherited through a call chain, with the hop count. |
| **Contract Extraction** | Input/output types, error contracts, security contracts, guard clauses, derived invariants — mined from the code itself. |
| **Homolog Detection** | Finds code elsewhere in the repository that does the same job, even when it shares no text with the original. Seven independent signals vote, and disagreement between them is reported rather than averaged away. |
| **Smart Context** | One call: source + blast radius + callers + tests + contracts. Replaces 8+ separate lookups. |
| **Dispatch Resolution** | Which implementation a call actually reaches — through inheritance, interfaces, and overrides — rather than just the name at the call site. |
| **Concept Families** | Groups symbols that solve the same kind of problem, names the clearest example of each group, and flags the members that break the pattern. |
| **Temporal Intelligence** | Git-derived co-change analysis, temporal risk scoring, churn metrics. |
| **Symbol Lineage** | Cross-snapshot identity tracking through renames and refactors. |
| **Transactional Editing** | 9-state change lifecycle with DB-backed rollback and 6-level progressive validation. |
| **Semantic Search** | Find code by what it does rather than what it is called. Runs locally on TF-IDF and MinHash similarity — no external API, no embedding service, no key to buy. |
| **Uncertainty Tracking** | Every symbol carries a confidence score, tracked back to twelve specific reasons the engine might be wrong. It tells you what it is *not* sure about instead of presenting every answer as equally solid. |
| **Self-Maintaining Index** | The graph follows the code. Edits are folded into the existing snapshot within seconds of hitting disk — no re-ingest, no scheduled job, no editor plugin. Repository-wide analysis is deferred under load and settled while you are idle, and whatever is outstanding is reported rather than assumed. |

## Languages

TypeScript, JavaScript, Python, C, C++, CUDA-flavored `.cu`/`.cuh`, Go, Rust,
Java, C#, Ruby, Kotlin, Swift, PHP, Bash — 32 file extensions across 13
parsers, since C, C++ and CUDA share the C++ parser.

TypeScript and JavaScript use full AST analysis through the TypeScript
Compiler API. Python uses LibCST with 60+ behavioral patterns. The remaining
languages use tree-sitter with language-specific walkers. CUDA files are
indexed for structure; kernel-specific semantics are not modelled separately.

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
    +-- Ingestor (13 language parsers, delta ingestion)
    +-- 13 Analysis Engines
    |     Behavioral | Contract | Deep Contract | Blast Radius
    |     Effect | Dispatch | Concept Families | Temporal
    |     Symbol Lineage | Runtime Evidence | Uncertainty
    |     Structural Graph | Capsule Compiler
    +-- Semantic Engine (TF-IDF, MinHash LSH, cosine similarity)
    +-- Homolog Engine (7-dimensional scoring)
    +-- Transactional Editor (opt-in constrained validation, rollback)
    +-- Service Layer (transport-agnostic services)
    +-- Database Driver (circuit breaker, batch loader, advisory locks)
    |
PostgreSQL (all data local, nothing leaves your machine)
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
- **PostgreSQL** 14 or newer (17 recommended) with the `pg_trgm` extension
- **Python 3** with `libcst` (optional — only for Python source analysis)

### Bootstrap (recommended)

```bash
git clone https://github.com/Classevelabs/context-zero-engine.git context-zero-engine
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
npm ci

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

MCP uses a trusted local stdio child-process boundary; it is not a remote
network authentication layer. Read tools are enabled by default. Before using
ingestion, editing, retention cleanup, or validation tools, a local operator
must set `SCG_MCP_MUTATIONS_ENABLED=true`. Validation commands additionally
require `SCG_ALLOW_UNSANDBOXED_EXECUTION=true` and should run only on trusted
repositories under a restricted operating-system account.

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

### 3. Keep it current

```bash
npm run watch
```

Watches every registered repository and folds each change into its snapshot as
it happens, so the graph describes the code as it is rather than as it was at
the last ingest. Set `SCG_WATCH=true` to start it with the MCP server instead.

It watches the filesystem and nothing else — the same behaviour whether the code
is edited by an IDE, a coding agent, a script, or a branch switch.

### 4. Or run it as an HTTP server

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
readiness, Prometheus metrics, cache, and admin endpoints. All non-health
routes require API-key authentication (`X-API-Key` or `Authorization:
Bearer`). State-changing, repository-registration, and validation-command
routes require a distinct `SCG_ADMIN_API_KEYS` credential.

### Docker (self-hosted server + bundled PostgreSQL)

```bash
cp .env.docker.example .env
# Set DB_PASSWORD, SCG_API_KEYS, and a distinct SCG_ADMIN_API_KEYS value.
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

- **Local by design** — no telemetry or required external analysis APIs; opt-in repository commands retain their own network capabilities
- **SQL injection protection** — parameterized queries plus table/column allowlists for dynamic queries
- **5-layer path traversal protection** — null bytes, URL encoding, backslash handling, symlink escape checks, base-path boundary enforcement
- **Fail-closed authentication** — timing-safe comparison, 32-character minimum keys, per-IP brute-force lockout, and separate production admin credentials for privileged HTTP routes
- **Constrained validation runner** — disabled by default; applies time/output/resource limits, process groups, SIGKILL escalation, and environment sanitization, but does not isolate filesystem or network access
- **Hardened HTTP surface** — per-route rate limits and body-size limits, input validation on every route, sanitized error responses (no stack traces, paths, or SQL)

See [SECURITY.md](SECURITY.md) for the deployment hardening checklist and
how to report a vulnerability.

---

## Historical Benchmarks

| Benchmark | Scale | Token reduction (exact-symbol baseline) |
|---|---|---:|
| Engine self-ingest | 105 files / 7,753 symbols | 2.71x (63.1% savings) |
| VS Code | 10,386 files / 125,777 symbol versions | 12.44x (91.96% savings) |
| 7 multi-language repos | Django, Prometheus, Tokio, Commons Lang, Serilog, OkHttp, Alamofire | 12.86x (92.2% savings) |

These are author-reported historical results; raw machine-readable run outputs
are not committed. Methodology, reproduction scripts, and cases where the gain
is small: [BENCHMARKS.md](BENCHMARKS.md).

---

## Testing

```bash
npm test              # full unit suite
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
