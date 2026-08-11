# ContextZero Operations Guide

This guide covers installation, MCP client setup, repository indexing, network server mode, benchmarks, and release validation for ContextZero.

For the shorter installer reference, see `docs/INSTALL.md`.

## Product Scope

ContextZero is a local code intelligence engine for AI agents. It indexes repositories into a PostgreSQL-backed code graph and serves targeted, token-budgeted context through MCP and HTTP.

Supported capabilities:

- MCP stdio bridge for Claude Desktop, Codex, Cursor, and other MCP-compatible clients.
- PostgreSQL-backed indexing, symbol search, structural graph analysis, contracts, effects, blast radius, homolog detection, and capsule compilation.
- TypeScript, JavaScript, Python, C, C++, CUDA-flavored `.cu`/`.cuh`, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, and Bash ingestion.
- Generated MCP client configs with secret-safe `.env` loading.
- Controlled ingestion limits for large repositories.
- Docker server mode for repeatable deployment with bundled PostgreSQL.

Operational notes:

- First ingestion of a very large monorepo can be CPU and database intensive. Start with conservative limits, verify health, then scale up.
- CUDA files are parsed through the C++ parser. General structure is indexed, but CUDA-specific kernel semantics are not modeled as a separate language engine.
- The HTTP server should run behind TLS and an auth-aware reverse proxy when exposed beyond localhost.
- Desktop MCP mode is local-first and should use `CONTEXTZERO_ENV_FILE` rather than copying database secrets into client config files.

## Requirements

- Node.js 20 or newer.
- PostgreSQL 14 or newer with `pg_trgm`.
- Python 3 with `libcst` for Python extraction.
- Windows users may need Microsoft C++ Build Tools if native npm packages compile locally.

Install the Python dependency:

```powershell
python -m pip install libcst
```

Create the database:

```powershell
createdb scg_v2
psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

## Windows Quick Start

```powershell
git clone https://github.com/Classevelabs/context-zero-engine.git context-zero-engine
cd context-zero-engine
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Client claude
```

macOS/Linux:

```bash
git clone https://github.com/Classevelabs/context-zero-engine.git context-zero-engine
cd context-zero-engine
scripts/bootstrap.sh --client claude
```

Set these values in `.env` before migration if your database does not use the defaults:

```dotenv
DB_HOST=localhost
DB_PORT=5432
DB_NAME=scg_v2
DB_USER=postgres
DB_PASSWORD=your-real-password
SCG_ALLOWED_BASE_PATHS=D:\Repos,D:\Work
SCG_MAX_FILES_PER_REPO=20000
SCG_MAX_FILE_SIZE_BYTES=1048576
SCG_INGEST_WORKERS=4
SCG_PYTHON_TIMEOUT_MS=30000
```

Run diagnostics at any time:

```powershell
npm run doctor
```

If PowerShell blocks `npm.ps1`, run the same command through `npm.cmd`, for example:

```powershell
npm.cmd run doctor
```

## MCP Client Setup

Generate config snippets:

```powershell
npm run mcp:config
```

Install directly into a supported client with backup:

```powershell
npm run mcp:install -- --client claude
npm run mcp:install -- --client codex
npm run mcp:install -- --client cursor
```

Generated files:

- `.contextzero/mcp/claude-desktop.json`
- `.contextzero/mcp/codex-config.toml`
- `.contextzero/mcp/generic-mcp.json`

Claude Desktop on Windows normally reads:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Either run `npm run mcp:install -- --client claude`, or copy the `mcpServers.contextzero` entry from `.contextzero/mcp/claude-desktop.json` into that file. Restart Claude Desktop, then call `scg_health_check`.

For Codex or another MCP-compatible client, use either `.contextzero/mcp/codex-config.toml` or `.contextzero/mcp/generic-mcp.json`, depending on the client config format it exposes.

The important config fields are:

- `command`: the Node executable.
- `args`: absolute path to `dist/mcp-bridge/index.js`.
- `env`: usually only `CONTEXTZERO_ENV_FILE=<repo>/.env`; if no `.env` exists, the installer writes explicit database, path allowlist, and ingestion limit variables.

Manual bridge test:

```powershell
npm run mcp
```

## Index A Repository

MCP mutation tools are disabled by default. A trusted local operator must set:

```dotenv
SCG_MCP_MUTATIONS_ENABLED=true
```

This grants the connected MCP client authority to ingest and change allowed
repositories. It is an operator-level trust decision, not a model-supplied
tool argument.

In an MCP client, call:

```text
scg_health_check
scg_ingest_repo
```

For `scg_ingest_repo`, pass a repository path under `SCG_ALLOWED_BASE_PATHS`.

Recommended first-run ingest settings:

```dotenv
SCG_MAX_FILES_PER_REPO=20000
SCG_MAX_FILE_SIZE_BYTES=1048576
SCG_INGEST_WORKERS=4
```

For a very large monorepo, start lower:

```dotenv
SCG_MAX_FILES_PER_REPO=5000
SCG_INGEST_WORKERS=2
```

Raise the limits after `npm run doctor` passes and the first ingest finishes cleanly.

## Network Server Mode

The MCP bridge is for local stdio clients. To let other machines call ContextZero over HTTP, build and start the REST server:

```powershell
npm run build
npm start
```

Server variables:

```dotenv
SCG_HOST=0.0.0.0
SCG_PORT=3100
SCG_API_KEYS=replace-with-a-strong-32-plus-character-key
SCG_ADMIN_API_KEYS=replace-with-a-distinct-strong-32-plus-character-admin-key
SCG_ALLOWED_BASE_PATHS=D:\Repos
```

Do not expose the HTTP server directly to the open internet. Put it behind a reverse proxy with TLS, keep API keys strong, and restrict firewall access to known users or a VPN.

Docker server mode:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Mode docker
```

macOS/Linux:

```bash
scripts/bootstrap.sh --mode docker
```

## Historical Benchmarks

See [`BENCHMARKS.md`](../BENCHMARKS.md) for the consolidated methodology and numbers.

Author-reported historical headline (raw original run artifacts are not
committed; reproduce on your target corpus before relying on these values):

- Multi-language benchmark (7 repositories): 92.2% exact-token savings, 12.86x exact token reduction, and 99.26% savings versus whole-source loading.
- VS Code benchmark: 91.96% exact-token savings, 12.44x exact token reduction, and 1,618x reduction versus full-source loading.

Plain description: ContextZero indexes a repo once, then serves structured context through MCP so an agent can ask targeted questions instead of repeatedly reading thousands of raw source lines.

## Full Validation

To verify a complete install end to end, run:

```powershell
npm run build
npm test -- --runInBand
npm run test:db
npm audit
npm run doctor
```

Expected result:

- Build passes.
- Default test suite passes.
- `npm run test:db` passes against a reachable PostgreSQL database.
- `npm audit` reports no vulnerabilities.
- `npm run doctor` has zero failures and zero warnings.
- At least one real repository under `SCG_ALLOWED_BASE_PATHS` ingests successfully.
- Claude Desktop, Codex, or another MCP client can call `scg_health_check`.
- After a trusted local operator sets `SCG_MCP_MUTATIONS_ENABLED=true`, the
  client can call `scg_ingest_repo` on an allowed test repository.
