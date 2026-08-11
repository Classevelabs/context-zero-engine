/** MCP tools that can mutate durable state, alter repositories, or execute repo commands. */
export const MUTATING_MCP_TOOLS = new Set([
  "scg_create_change_transaction",
  "scg_apply_patch",
  "scg_validate_change",
  "scg_commit_change",
  "scg_rollback_change",
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
