/** MCP tools that can mutate durable state, alter repositories, or execute repo commands. */
export const MUTATING_MCP_TOOLS = new Set([
  "scg_create_change_transaction",
  "scg_apply_patch",
  "scg_validate_change",
  "scg_commit_change",
  "scg_rollback_change",
  // Computes proposals AND transitions the transaction validated →
  // propagation_pending and stores a propagation report. That state change is a
  // mutation, so it must not be reachable with a read-only credential.
  "scg_propagation_proposals",
  "scg_register_repo",
  "scg_ingest_repo",
  "scg_persist_homologs",
  "scg_ingest_runtime_trace",
  "scg_incremental_index",
  "scg_batch_embed",
  "scg_plan_change",
  "scg_prepare_change",
  "scg_apply_propagation",
  "scg_review_homolog",
  "scg_admin_run_retention",
  "scg_admin_cleanup_stale",
])

export function isMutatingMcpTool(toolName: string): boolean {
  return MUTATING_MCP_TOOLS.has(toolName)
}

/**
 * Whether a tool is registered — and therefore listed — for this process.
 *
 * Every listed tool's schema rides in the model's context on every turn, and
 * the full set of schemas came to about 49 KB, roughly 12,000 tokens per turn.
 * While SCG_MCP_MUTATIONS_ENABLED is off the mutation tools are refused
 * outright, so listing them bought nothing but that cost. A tool a session
 * cannot call is not listed; the session note from
 * {@link unlistedMutationToolsNote} says once, at connect, where they went.
 */
export function shouldRegisterTool(toolName: string, features: { mutationsEnabled: boolean }): boolean {
  return features.mutationsEnabled || !isMutatingMcpTool(toolName)
}

/**
 * Whether `_auth_token` belongs in a tool's input schema. It is there so the
 * SDK does not strip it before the auth wrapper reads it — which only matters
 * when a secret exists for it to match. Without one the field was 6.6 KB of
 * every tool list, describing a check that never ran.
 */
export function authTokenInSchema(secrets: { secret?: string | null; adminSecret?: string | null }): boolean {
  return Boolean(secrets.secret || secrets.adminSecret)
}

/**
 * The server's session-level instructions when mutation tools are unlisted:
 * one sentence the client sees at connect, instead of 17 schemas on every turn.
 */
export function unlistedMutationToolsNote(count: number): string {
  return (
    `${count} tools that ingest, index, edit, review or run maintenance are not listed because ` +
    `SCG_MCP_MUTATIONS_ENABLED is off in this server's environment. A local operator enables them ` +
    `there; they are not available through tool arguments.`
  )
}
