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
- **Set strong, separated secrets.** `SCG_API_KEYS` and
  `SCG_ADMIN_API_KEYS` require 32+ character keys in production (generate
  with `openssl rand -hex 32`). Admin keys must not reuse regular API keys.
  Replace the placeholder `DB_PASSWORD` before starting anything.
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
- **Treat MCP stdio as a trusted-local boundary.** `SCG_MCP_SECRET` is
  optional per-call defense in depth, not a remote transport security layer;
  its `_auth_token` is a tool argument visible to the MCP client. Do not relay
  this stdio server over an untrusted network transport.
- **Keep mutation and command execution off unless needed.** MCP mutation
  tools require `SCG_MCP_MUTATIONS_ENABLED=true`. Repository validation
  commands additionally require `SCG_ALLOW_UNSANDBOXED_EXECUTION=true`.
  Enable them only for trusted repositories under a restricted OS identity.

## Built-in Controls

The engine ships with fail-closed API-key authentication (timing-safe
comparison, bounded lockout tracking, and distinct production admin keys for
privileged HTTP operations). Request-controlled SQL values use parameters and
dynamic identifiers are validated or allowlisted; trusted internal SQL
fragments remain, so this is not a universal “100% parameterized” guarantee.
It also applies path-boundary checks, bounded rate/body controls, route input
validation, and sanitized HTTP errors.

Validation uses an opt-in constrained subprocess runner with environment
sanitization, time/output/resource limits, process-group termination, and
best-effort Linux PID namespacing. It does **not** restrict filesystem or
network access, and Windows receives no OS-level isolation. Treat any enabled
repository command as code execution with the service account's authority.
