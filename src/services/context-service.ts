/**
 * ContextZero — Context Service
 *
 * Shared business logic for smart context compilation.
 * Orchestrates blast radius computation, severity ranking, token budgeting,
 * and source loading into a single task-oriented context bundle.
 * Used by both the REST API and MCP bridge handlers.
 */

import { db } from "../db-driver"
import { blastRadiusEngine } from "../analysis-engine/blast-radius"
import { UserFacingError } from "../types"

// ────────── Result Types ──────────

export interface TargetSymbol {
  symbol_version_id: string
  canonical_name: string
  kind: string
  signature: string
  file_path: string
  start_line: number
  end_line: number
  source: string
  token_estimate: number
}

export interface ContextSymbol {
  symbol_name: string
  kind: string
  file_path: string | null
  start_line: number | null
  end_line: number | null
  impact_type: string
  severity: string
  evidence: string
  source: string | null
  token_estimate: number
}

export interface SmartContextResult {
  task: string
  targets: TargetSymbol[]
  blast_radius: {
    total_impacts: number
    validation_scope: string
  }
  context: ContextSymbol[]
  omitted: string[] | undefined
  token_usage: {
    budget: number
    used: number
    remaining: number
  }
}

export interface SmartContextOptions {
  tokenBudget?: number
  depth?: number
}

// ────────── Constants ──────────

const CHARS_PER_TOKEN = 4
const MIN_TOKEN_BUDGET = 100
const MAX_TOKEN_BUDGET = 100_000
const MAX_TARGET_SYMBOLS = 20
const MAX_CONTEXT_SYMBOLS = 500
const MAX_OMITTED_DETAILS = 500

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function fitSourceToBudget(source: string, availableTokens: number): string {
  if (availableTokens <= 0) return ""
  if (estimateTokens(source) <= availableTokens) return source
  const maxChars = availableTokens * CHARS_PER_TOKEN
  const marker = "\n/* truncated to context token budget */"
  if (maxChars <= marker.length) return source.slice(0, maxChars)
  return source.slice(0, maxChars - marker.length) + marker
}

// ────────── Service Function ──────────

/**
 * Compile a task-oriented smart context bundle.
 *
 * 1. Loads target symbol source
 * 2. Computes blast radius for targets
 * 3. Deduplicates and ranks impacts by severity
 * 4. Loads impacted symbol source within token budget
 * 5. Returns everything needed for a change task
 */
export async function compileSmartContext(
  taskDescription: string,
  targetSymbolVersionIds: string[],
  snapshotId: string,
  options: SmartContextOptions = {},
): Promise<SmartContextResult> {
  if (typeof taskDescription !== "string" || taskDescription.trim().length === 0 || taskDescription.length > 2_000) {
    throw UserFacingError.badRequest("Task description must contain 1-2000 characters")
  }
  if (!Array.isArray(targetSymbolVersionIds) || targetSymbolVersionIds.length === 0 ||
      targetSymbolVersionIds.length > MAX_TARGET_SYMBOLS ||
      targetSymbolVersionIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)) {
    throw UserFacingError.badRequest(`Target symbols must contain 1-${MAX_TARGET_SYMBOLS} valid identifiers`)
  }
  const targetIds = [...new Set(targetSymbolVersionIds)]
  const rawBudget = options.tokenBudget
  const tokenBudget = typeof rawBudget === "number" && Number.isFinite(rawBudget)
    ? Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, Math.trunc(rawBudget)))
    : 20_000
  const rawDepth = options.depth
  const depth = typeof rawDepth === "number" && Number.isFinite(rawDepth)
    ? Math.min(Math.max(Math.trunc(rawDepth), 1), 5)
    : 2
  let usedTokens = 0

  // Step 1: Load target symbols with source
  const targetPH = targetIds.map((_, i) => `$${i + 1}`).join(",")
  const targetsResult = await db.query(
    `
        SELECT sv.symbol_version_id, s.canonical_name, s.kind, sv.signature,
               sv.summary, sv.body_source, f.path as file_path,
               sv.range_start_line, sv.range_end_line
        FROM symbol_versions sv
        JOIN symbols s ON s.symbol_id = sv.symbol_id
        JOIN files f ON f.file_id = sv.file_id
        WHERE sv.symbol_version_id IN (${targetPH})
    `,
    targetIds,
  )

  const targets: TargetSymbol[] = (targetsResult.rows as Record<string, unknown>[]).map((t) => {
    const rawSource = (t.body_source as string | null) ?? "[source unavailable]"
    const source = fitSourceToBudget(rawSource, tokenBudget - usedTokens)
    const tokens = estimateTokens(source)
    usedTokens += tokens
    return {
      symbol_version_id: (t.symbol_version_id as string) ?? "",
      canonical_name: (t.canonical_name as string) ?? "",
      kind: (t.kind as string) ?? "unknown",
      signature: (t.signature as string) ?? "",
      file_path: (t.file_path as string) ?? "",
      start_line: typeof t.range_start_line === "number" ? t.range_start_line : 0,
      end_line: typeof t.range_end_line === "number" ? t.range_end_line : 0,
      source,
      token_estimate: tokens,
    }
  })

  // Step 2: Compute blast radius
  const blastReport = await blastRadiusEngine.computeBlastRadius(snapshotId, targetIds, depth)

  // Step 3: Collect all impacts, deduplicate by symbol_id, keep highest severity
  const allImpacts = [
    ...blastReport.structural_impacts,
    ...blastReport.behavioral_impacts,
    ...blastReport.contract_impacts,
    ...blastReport.homolog_impacts,
    ...blastReport.historical_impacts,
  ]

  const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
  const impactMap = new Map<string, (typeof allImpacts)[0]>()
  for (const impact of allImpacts) {
    const existing = impactMap.get(impact.symbol_id)
    if (!existing || (severityRank[impact.severity] || 0) > (severityRank[existing.severity] || 0)) {
      impactMap.set(impact.symbol_id, impact)
    }
  }

  const rankedImpacts = Array.from(impactMap.values()).sort(
    (a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0),
  )

  // Step 4: Load source for impacted symbols (by symbol_id, matching snapshot)
  // Chunk to stay within PostgreSQL's parameter limit (~32K params)
  const PG_PARAM_CHUNK_SIZE = 500
  const impactSymIds = rankedImpacts.map((i) => i.symbol_id)
  const impactSourceMap = new Map<string, Record<string, unknown>>()
  for (let offset = 0; offset < impactSymIds.length; offset += PG_PARAM_CHUNK_SIZE) {
    const chunk = impactSymIds.slice(offset, offset + PG_PARAM_CHUNK_SIZE)
    const impPH = chunk.map((_, i) => `$${i + 2}`).join(",")
    const impResult = await db.query(
      `
            SELECT s.symbol_id, s.canonical_name, s.kind, sv.body_source,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.snapshot_id = $1 AND s.symbol_id IN (${impPH})
        `,
      [snapshotId, ...chunk],
    )
    for (const row of impResult.rows) {
      impactSourceMap.set(row.symbol_id as string, row as Record<string, unknown>)
    }
  }

  // Step 5: Fill context within token budget
  const contextSymbols: ContextSymbol[] = []
  const omitted: string[] = []

  for (const impact of rankedImpacts) {
    const meta = impactSourceMap.get(impact.symbol_id)
    const source = (meta?.body_source as string | null | undefined) ?? null
    const tokens = source ? estimateTokens(source) : 0

    if (contextSymbols.length >= MAX_CONTEXT_SYMBOLS || usedTokens + tokens > tokenBudget) {
      if (omitted.length < MAX_OMITTED_DETAILS) {
        omitted.push(`${impact.symbol_name} (${impact.severity} ${impact.impact_type})`)
      }
      continue
    }

    contextSymbols.push({
      symbol_name: impact.symbol_name,
      kind: (meta?.kind as string) || "unknown",
      file_path: impact.file_path,
      start_line: impact.start_line,
      end_line: impact.end_line,
      impact_type: impact.impact_type,
      severity: impact.severity,
      evidence: impact.evidence,
      source,
      token_estimate: tokens,
    })
    usedTokens += tokens
  }

  if (rankedImpacts.length - contextSymbols.length > omitted.length) {
    omitted.push(`[${rankedImpacts.length - contextSymbols.length - omitted.length} additional symbols omitted]`)
  }

  return {
    task: taskDescription,
    targets,
    blast_radius: {
      total_impacts: blastReport.total_impact_count,
      validation_scope: blastReport.recommended_validation_scope,
    },
    context: contextSymbols,
    omitted: omitted.length > 0 ? omitted : undefined,
    token_usage: {
      budget: tokenBudget,
      used: usedTokens,
      remaining: Math.max(0, tokenBudget - usedTokens),
    },
  }
}
