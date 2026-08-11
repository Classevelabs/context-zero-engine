import { isMutatingMcpTool, MUTATING_MCP_TOOLS } from "../mcp-bridge/security"

describe("MCP mutation classification", () => {
  test.each([
    "scg_register_repo",
    "scg_ingest_repo",
    "scg_apply_patch",
    "scg_validate_change",
    "scg_commit_change",
    "scg_rollback_change",
    "scg_prepare_change",
    "scg_apply_propagation",
    "scg_admin_cleanup_stale",
  ])("classifies %s as privileged mutation", (tool) => {
    expect(isMutatingMcpTool(tool)).toBe(true)
  })

  test("does not classify read-only tools as mutations", () => {
    expect(isMutatingMcpTool("scg_resolve_symbol")).toBe(false)
    expect(isMutatingMcpTool("scg_admin_db_stats")).toBe(false)
    expect(MUTATING_MCP_TOOLS.size).toBeGreaterThanOrEqual(17)
  })
})
