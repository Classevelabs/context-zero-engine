/**
 * Network bind-safety guard.
 *
 * A pure, side-effect-free module so the loopback/auth policy can be unit
 * tested without importing the server entrypoint (which starts listening on
 * import). The API interface calls {@link networkBindAuthError} at startup and
 * refuses to accept traffic when the resolved bind host is reachable from other
 * machines yet carries no authentication.
 */

/**
 * True only for a genuine loopback bind — an address reachable solely from this
 * machine. Everything else (0.0.0.0, ::, a routable IP, or a hostname that may
 * resolve off-box) is treated as network-reachable and must be authenticated.
 *
 * The `127.` prefix covers the whole 127.0.0.0/8 loopback range; `::1` and the
 * literal names `localhost`/`127.0.0.1` cover the common forms. Matching is
 * case-insensitive and tolerant of surrounding whitespace.
 */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === "127.0.0.1" || h === "::1" || h === "localhost") return true
  // 127.0.0.0/8 — but not a hostname that merely starts with "127." such as
  // "127.example.com", which DNS could point anywhere.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * Returns an actionable error string when binding `host` would expose the
 * interface on a network-reachable address without any authentication, or
 * `null` when the bind is safe (loopback, or authenticated).
 *
 * `hasAuth` is true when at least one credential is configured (e.g. a
 * non-empty `SCG_API_KEYS`). This is independent of NODE_ENV so the check also
 * protects non-production processes that are told to listen on 0.0.0.0.
 */
export function networkBindAuthError(host: string, hasAuth: boolean): string | null {
  if (isLoopbackBindHost(host) || hasAuth) return null
  return (
    `Refusing to bind to non-loopback host "${host}" without authentication. ` +
    "Set SCG_API_KEYS (bearer auth) or bind to 127.0.0.1 via SCG_HOST."
  )
}
