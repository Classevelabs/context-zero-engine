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
- PostgreSQL 14 or newer (17 recommended) with `pg_trgm`.
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
SCG_ALLOWED_BASE_PATHS=C:\Repos,D:\Work
SCG_MAX_FILES_PER_REPO=20000
SCG_MAX_FILE_SIZE_BYTES=1048576
SCG_INGEST_WORKERS=4
SCG_PYTHON_TIMEOUT_MS=30000
```

`.env` does not override a variable that is already set in the process
environment. If `SCG_ALLOWED_BASE_PATHS` (or any `DB_*`/`SCG_*` name) exists as
a system or user environment variable, that value wins and editing `.env` has
no effect. Check before assuming the file is being read:

```powershell
$env:SCG_ALLOWED_BASE_PATHS
```

```bash
echo $SCG_ALLOWED_BASE_PATHS
```

Either clear the environment variable or set the value there instead.

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
scg_health_check                      → expect status: healthy
scg_register_repo                     → repo_name + absolute repo_path; returns repo_id
scg_ingest_repo                       → pass that repo_id
```

`scg_ingest_repo` also accepts a bare `repo_path` if you would rather skip
registration. Either way the path must sit under `SCG_ALLOWED_BASE_PATHS`.

On macOS and Linux the same setting takes POSIX paths, for example
`SCG_ALLOWED_BASE_PATHS=/home/you/repos,/srv/projects`.

Ingestion finishes with a status:

- `complete` — every file was extracted; all query tools answer normally.
- `partial` — some files failed to extract. Symbols from the files that
  succeeded are stored, and query tools report the index as incomplete rather
  than answering from a fraction of the repository.
- `failed` — nothing was extracted.

A `partial` snapshot names the files it could not index. `scg_snapshot_stats`
reports them as `files_unindexed` / `unindexed_paths`, and the warning attached
to query results lists them, so you can tell whether the gap touches what you
are asking about. Repair just those files:

```text
scg_incremental_index   → repo_path + changed_paths = the unindexed paths
```

The snapshot returns to `complete` on its own once every listed path parses.

Check any repository's current state with `scg_list_snapshots`.

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

## Keep The Index Current

An index is only worth consulting if it describes the code as it is now. Left to
manual re-ingestion it is accurate for a few minutes and quietly wrong for the
rest of the day, so the engine maintains itself:

```bash
npm run watch
```

This watches every registered repository and folds each change into its existing
snapshot as it happens. It observes the filesystem and nothing else, so it works
the same whether the code is edited by an IDE, a coding agent, a script, or a
branch switch.

To have it start with the MCP server instead of running separately:

```dotenv
SCG_WATCH=true
```

Several connected clients cost one watcher, not several: each repository is held
under an advisory lock, so a second watcher is a no-op rather than a race.

### What it does

Edits are batched over a short quiet period and indexed together, so a formatter
sweep or a branch switch costs one pass rather than hundreds. Each pass
re-extracts the changed files and re-embeds their symbols in seconds — the code
you just wrote is searchable immediately.

Repository-wide analyses — symbol lineage, concept families, dispatch edges,
transitive effects, IDF weighting — are not recomputed on every edit; across a
large repository that is minutes of work per keystroke. They are deferred, the
snapshot records that they are owed, and the watcher settles the debt during an
idle period. `scg_snapshot_stats` reports `refinement_pending_since` whenever
anything is outstanding.

| Setting | Default | Effect |
|---------|---------|--------|
| `SCG_WATCH` | `false` | Start watching with the MCP server |
| `SCG_WATCH_DEBOUNCE_MS` | `2000` | Quiet period before a batch is indexed |
| `SCG_WATCH_REFINE_IDLE_MS` | `900000` | Idle time before refinement is settled; `0` leaves it manual |

### Indexing specific files

To index a known set of paths — a CI step, or repairing the files a `partial`
snapshot names — call the tool directly:

```text
scg_incremental_index   → repo_path + changed_paths
```

Paths may be absolute or repo-relative, `snapshot_id` defaults to the
repository's most recent, and `refine: "full"` recomputes the repository-wide
analyses in the same pass.

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
SCG_ALLOWED_BASE_PATHS=/srv/repos
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
