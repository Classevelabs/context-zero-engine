import {
  authTokenInSchema,
  isMutatingMcpTool,
  MUTATING_MCP_TOOLS,
  shouldRegisterTool,
  unlistedMutationToolsNote,
} from "../mcp-bridge/security"

// A listed tool's schema is in the model's context on every turn. The 17
// mutation tools were listed while refused, which cost about a third of a
// 49 KB tool list per turn for nothing a session could do.
describe("tool listing follows what a session can call", () => {
  test("mutation tools are not registered while mutations are disabled", () => {
    expect(shouldRegisterTool("scg_ingest_repo", { mutationsEnabled: false })).toBe(false)
    expect(shouldRegisterTool("scg_admin_run_retention", { mutationsEnabled: false })).toBe(false)
    expect(shouldRegisterTool("scg_resolve_symbol", { mutationsEnabled: false })).toBe(true)
    expect(shouldRegisterTool("scg_admin_db_stats", { mutationsEnabled: false })).toBe(true)
  })

  test("every tool is registered once mutations are enabled", () => {
    for (const tool of MUTATING_MCP_TOOLS) {
      expect(shouldRegisterTool(tool, { mutationsEnabled: true })).toBe(true)
    }
  })

  test("_auth_token rides in a schema only when a secret exists to match it", () => {
    expect(authTokenInSchema({})).toBe(false)
    expect(authTokenInSchema({ secret: "", adminSecret: "" })).toBe(false)
    expect(authTokenInSchema({ secret: undefined, adminSecret: null })).toBe(false)
    expect(authTokenInSchema({ secret: "per-call-secret" })).toBe(true)
    expect(authTokenInSchema({ adminSecret: "admin-secret" })).toBe(true)
  })

  test("the session note names the switch and the count, so the omission is explained once", () => {
    const note = unlistedMutationToolsNote(17)
    expect(note).toContain("17")
    expect(note).toContain("SCG_MCP_MUTATIONS_ENABLED")
    expect(note).toContain("not listed")
  })
})

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
