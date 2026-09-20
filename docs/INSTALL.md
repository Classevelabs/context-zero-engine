# ContextZero Install Guide

ContextZero has two supported install paths:

- **Native local MCP**: best for Claude Desktop, Codex, Cursor, and local developer workflows.
- **Docker server**: best when you want a repeatable HTTP server with bundled PostgreSQL.

Both need Node.js 20 or newer. Neither needs you to install PostgreSQL: when the machine has none,
ContextZero provisions its own and generates the password itself.

For operating guidance after installation, see `docs/OPERATIONS.md`.

## Fastest Native Install

Windows PowerShell:

```powershell
git clone https://github.com/Classevelabs/context-zero-engine.git context-zero-engine
cd context-zero-engine
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Client claude
```

macOS or Linux:

```bash
git clone https://github.com/Classevelabs/context-zero-engine.git context-zero-engine
cd context-zero-engine
scripts/bootstrap.sh --client claude
```

Use `--client codex`, `--client cursor`, or `--client all` to install another MCP client config.
If PowerShell blocks manual `npm` commands on Windows, use `npm.cmd` for the same command, for example `npm.cmd run doctor`.

The bootstrap script:

- installs npm dependencies;
- installs Python `libcst` when Python is available;
- provisions a private PostgreSQL when no database is configured;
- creates `.env` when missing, with every secret generated;
- builds ContextZero;
- runs migrations unless disabled;
- runs `npm run doctor`;
- optionally installs MCP config with a backup of the existing client config.

## The Database

With no `DB_HOST`/`DB_USER`/`DB_PASSWORD` in the environment, setup provisions a PostgreSQL that
belongs to ContextZero: binaries fetched once into your user data directory, a port nobody else is
using, and a generated password written only into `.env`. The MCP launcher starts it when a client
opens, so nothing has to be running first.

```bash
npm run db:status    # where it is, and whether it is running
npm run db:stop
npm run db:up
```

`CONTEXTZERO_HOME` moves that directory. To use a database you already run, set `DB_HOST`, `DB_USER`
and `DB_PASSWORD` before setup: PostgreSQL 14 or newer, with `pg_trgm`, and **UTF-8** — source code
is UTF-8, and `initdb` on a Windows locale produces a code page that cannot store it.

```bash
createdb -E UTF8 -T template0 scg_v2
psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

## Docker Install

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1 -Mode docker
```

macOS or Linux:

```bash
scripts/bootstrap.sh --mode docker
```

Manual Docker path:

```bash
cp .env.docker.example .env
# Edit DB_PASSWORD, SCG_API_KEYS, and distinct SCG_ADMIN_API_KEYS values.
docker compose up -d --build
```

Health check:

```bash
curl http://localhost:3100/health
```

## MCP Client Installer

Generate config snippets without modifying client files:

```bash
npm run mcp:config
```

Install directly into supported clients:

```bash
npm run mcp:install -- --client claude
npm run mcp:install -- --client codex
npm run mcp:install -- --client cursor
```

Dry run:

```bash
npm run mcp:install -- --client all --dry-run
```

The installer is idempotent and creates timestamped backups before changing existing config files.
When `.env` exists, the installer writes `CONTEXTZERO_ENV_FILE=<repo>/.env` into the client config instead of duplicating database credentials.

The MCP server is a trusted local stdio child process. Read tools are enabled
by default; set `SCG_MCP_MUTATIONS_ENABLED=true` only when a local operator
intends to allow ingestion or editing. Validation commands also require
`SCG_ALLOW_UNSANDBOXED_EXECUTION=true` and have no filesystem/network
isolation, so use them only for trusted repositories under a restricted OS
account.

Supported config targets:

- Claude Desktop:
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`
- Codex:
  - `$CODEX_HOME/config.toml` when `CODEX_HOME` is set
  - otherwise `~/.codex/config.toml`
- Cursor:
  - `~/.cursor/mcp.json`

## Diagnostics

Human-readable diagnostics:

```bash
npm run doctor
```

Machine-readable diagnostics:

```bash
npm run doctor -- --json
```

Safe repair for missing local `.env`:

```bash
npm run doctor -- --fix
```

## PostgreSQL Notes

These apply to a database you run yourself; the one ContextZero provisions is already set up this
way.

Minimum database setup — UTF-8 from `template0`, because a database on the machine's code page
cannot store source code:

```bash
createdb -E UTF8 -T template0 scg_v2
psql -d scg_v2 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

Then set `.env`:

```dotenv
DB_HOST=localhost
DB_PORT=5432
DB_NAME=scg_v2
DB_USER=postgres
DB_PASSWORD=your-real-password
SCG_ALLOWED_BASE_PATHS=/path/to/repos
```

When the MCP client launches the server it passes `CONTEXTZERO_ENV_FILE`, and
that file's values are applied with override — so the file wins over any
pre-existing `DB_*`/`SCG_*` shell or system variable. When you instead run a
command directly with `CONTEXTZERO_ENV_FILE` unset (for example a bare
`npm start`), the reverse holds: a variable already present in the environment
wins and editing `.env` has no effect. `npm run doctor` reports which case
applies; if a value looks wrong, check the shell:

```powershell
$env:SCG_ALLOWED_BASE_PATHS
```

```bash
echo $SCG_ALLOWED_BASE_PATHS
```

Either clear the environment variable or set the value there instead.

Docker install creates and manages PostgreSQL inside the compose stack.
The compose file sets `DB_SSL_ALLOW_INSECURE_PRIVATE_NETWORK=true` because the app and database communicate over Docker's private bridge network. Do not use that setting for an untrusted remote database.

## Full Validation

To verify a complete install end to end, run:

```bash
npm run build
npm test -- --runInBand
npm run test:db
npm audit
npm run doctor
```

Expected:

- build passes;
- all default tests pass;
- the opt-in PostgreSQL integration test passes on a machine with a reachable test database;
- audit reports zero vulnerabilities;
- doctor reports zero failures;
- MCP `scg_health_check` returns healthy from at least one supported client.
