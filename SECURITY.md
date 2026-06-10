# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via GitHub's security
advisory feature ("Report a vulnerability" on the repository's Security
tab). Do not open a public issue for security reports.

Include what you can: affected version, reproduction steps, and impact.
We will acknowledge reports as quickly as possible and coordinate a fix
and disclosure timeline with you.

## Supported Versions

Security fixes are applied to the latest released version.

## Deployment Hardening Checklist

ContextZero is local-first: the MCP bridge runs over stdio for a desktop
client and needs no network exposure. If you run the HTTP server beyond
localhost, harden it:

- **Never expose the HTTP server directly to the internet.** Put it behind
  a TLS-terminating reverse proxy and restrict access by firewall or VPN.
- **Set strong secrets.** `SCG_API_KEYS` requires 32+ character keys in
  production (generate with `openssl rand -hex 32`); replace the
  placeholder `DB_PASSWORD` before starting anything.
- **Scope the path allowlist.** `SCG_ALLOWED_BASE_PATHS` should contain
  only the repository roots you intend to index — registration fails
  closed when it is empty.
- **Database transport.** Use `DB_SSL_MODE=require` (or stricter) for any
  remote database. `DB_SSL_ALLOW_INSECURE_PRIVATE_NETWORK=true` is only
  for private-network setups such as the bundled Docker Compose bridge.
- **Keep MCP client configs secret-free.** Point clients at the repo's
  `.env` via `CONTEXTZERO_ENV_FILE` instead of duplicating database
  credentials into client config files (the bundled installer does this
  automatically).

## Built-in Controls

The engine ships with fail-closed API-key authentication (timing-safe
comparison, per-IP lockout with exponential backoff), 100% parameterized
SQL with allowlisted dynamic identifiers, 5-layer path traversal
protection (null bytes, URL encoding, backslashes, symlink escapes,
base-path boundaries), per-route rate and body-size limits, input
validation on every route, sandboxed subprocess execution with environment
sanitization, and sanitized error responses that never include stack
traces, internal paths, or SQL text.
