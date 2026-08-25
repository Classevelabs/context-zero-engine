/**
 * ContextZero — Context Capsule Compiler V2
 *
 * Token-budgeted minimal context packages with 3 modes:
 *   - minimal: target + direct deps only
 *   - standard: target + deps + callers + tests + contracts
 *   - strict: full graph walk with invariants, homologs, dispatch, effects, families
 *
 * V2 enhancements:
 *   - Multi-resolution context: full_source -> signature_only -> contract_summary -> effect_summary -> name_only
 *   - Inclusion/exclusion rationale for every candidate node
 *   - Fetch handles for omitted nodes (lazy expansion by the AI)
 *   - Dispatch edge resolution (object-aware method chains)
 *   - Typed effect signatures in capsule
 *   - Concept family members in strict mode
 *   - Compilation persistence for debugging and improvement
 *
 * The capsule is the atomic unit of context for each tool call.
 * Complete enough to avoid hallucination, small enough to fit
 * token budgets.
 *
 * Security: Path traversal protection on source code reads.
 */

import * as fsp from "fs/promises"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import { db } from "../db-driver"
import { Logger } from "../logger"
import { capsuleCache } from "../cache"
import { resolvePathWithinBase } from "../path-security"
import type {
  ContextCapsule,
  ContextNode,
  CapsuleMode,
  FetchHandle,
  DispatchContextNode,
  FamilyContextNode,
  InclusionRationale,
} from "../types"
import type { EffectEntry } from "./effect-engine"

const log = new Logger("capsule-compiler")

/** Approximate tokens per character (conservative estimate) */
const CHARS_PER_TOKEN = 4

/** Default token budgets per mode */
const MODE_BUDGETS: Record<CapsuleMode, number> = {
  minimal: 4_000,
  standard: 12_000,
  strict: 24_000,
}
const MIN_TOKEN_BUDGET = 100
const MAX_TOKEN_BUDGET = 100_000
const MAX_FALLBACK_SOURCE_BYTES = 2 * 1024 * 1024

/**
 * Serialized size of the capsule's fixed JSON skeleton — the keys, brackets
 * and empty arrays that ship regardless of content. Charged up front so the
 * budget binds the payload the consumer actually receives, not a subset of it.
 * Exported so tests can assert against the same allowance.
 */
export const CAPSULE_SKELETON_TOKENS = 60

/**
 * Cap on transitive entries in a shipped effect signature. Direct effects all
 * ship; transitive ones are ordered by hop count and truncated here. Beyond
 * this point additional entries stop informing and start costing.
 */
const MAX_TRANSITIVE_EFFECT_ENTRIES = 15

/** Cap on fetch handles shipped for omitted nodes. */
const MAX_FETCH_HANDLES = 12

/**
 * Resolution priority order (for reference). When budget is tight, we degrade from
 * full_source down through lower resolutions before omitting entirely:
 *   full_source -> signature_only -> contract_summary -> effect_summary -> name_only
 */

/** Internal row type returned by loadDirectDependencies and loadCallers */
interface SymbolRow {
  symbol_version_id: string
  symbol_id?: string
  canonical_name: string
  signature: string
  summary: string
  body_source: string | null
  file_path?: string
  range_start_line?: number
  range_end_line?: number
  relation_type?: string
  confidence: number
}

export class CapsuleCompiler {
  /**
   * Compile a context capsule for a target symbol.
   *
   * repoBasePath is accepted per-call to avoid shared mutable state
   * on the singleton instance, which would be a concurrency bug under
   * concurrent requests.
   */
  public async compile(
    symbolVersionId: string,
    snapshotId: string,
    mode: CapsuleMode = "standard",
    tokenBudget?: number,
    repoBasePath?: string,
  ): Promise<ContextCapsule> {
    if (!Object.prototype.hasOwnProperty.call(MODE_BUDGETS, mode)) {
      throw new Error("Invalid capsule mode")
    }
    const effectiveBudget = typeof tokenBudget === "number" && Number.isFinite(tokenBudget)
      ? Math.min(MAX_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, Math.trunc(tokenBudget)))
      : MODE_BUDGETS[mode]

    // Check capsuleCache — keyed on symbol+snapshot+mode+budget
    const cacheKey = `capsule:${symbolVersionId}:${snapshotId}:${mode}:${effectiveBudget}`
    const cached = capsuleCache.get(cacheKey) as ContextCapsule | undefined
    if (cached) return cached

    const timer = log.startTimer("compile", {
      symbolVersionId,
      mode,
      tokenBudget: effectiveBudget,
    })

    // Load target symbol
    const target = await this.loadSymbolVersion(symbolVersionId)
    if (!target) {
      throw new Error(`Symbol version not found: ${symbolVersionId}`)
    }

    const resolvedBasePath = repoBasePath ? path.resolve(repoBasePath) : null
    // Prefer stored body_source (DB-resident, Docker-safe, versioned).
    // Fall back to disk read for symbols ingested before body_source migration.
    // Nullish coalescing: empty string "" is a valid body (interfaces, type aliases).
    // Only fall back to disk when body_source is null/undefined (pre-migration symbols).
    let targetCode =
      target.body_source ??
      (await this.readSourceCode(resolvedBasePath, target.file_path, target.range_start_line, target.range_end_line))
    const truncateToTokens = (text: string, budget: number): string => {
      if (budget <= 0) return ""
      if (this.estimateTokens(text) <= budget) return text
      const maxChars = budget * CHARS_PER_TOKEN
      const marker = " /* truncated */"
      return maxChars > marker.length
        ? text.slice(0, maxChars - marker.length) + marker
        : text.slice(0, maxChars)
    }
    const targetSignature = truncateToTokens(target.signature, effectiveBudget)

    // Serialized-cost accounting. The old accounting summed the raw text of
    // the pieces it chose and ignored everything else that shipped — JSON
    // structure, the effect array, the bookkeeping — so capsules reported
    // ~40% of their true size and routinely overshot the budget they were
    // given. Every charge below is the marginal serialized cost of what the
    // consumer actually receives, so the budget binds the payload.
    const targetBlock = () => ({
      symbol_id: target.symbol_id,
      name: target.canonical_name,
      code: targetCode,
      signature: targetSignature,
      location: {
        file_path: target.file_path,
        start_line: target.range_start_line,
        end_line: target.range_end_line,
      },
    })
    let usedTokens = CAPSULE_SKELETON_TOKENS + this.serializedTokens(targetBlock())

    const contextNodes: ContextNode[] = []
    const omissionRationale: string[] = []
    const uncertaintyNotes: string[] = []
    const inclusionRationale: InclusionRationale[] = []
    const fetchHandles: FetchHandle[] = []

    // Bookkeeping strings ship too, so they are charged too.
    const chargeOmission = (message: string) => {
      omissionRationale.push(message)
      usedTokens += this.serializedTokens(message) + 1
    }

    // BUG-006 FIX: If the target alone exceeds the token budget, truncate its
    // code so the serialized block fits.
    if (usedTokens > effectiveBudget) {
      const overhead = CAPSULE_SKELETON_TOKENS + this.serializedTokens({ ...targetBlock(), code: "" })
      const availableForCode = effectiveBudget - overhead
      if (availableForCode <= 0) {
        targetCode = ""
      } else {
        const codeLines = targetCode.split("\n")
        const truncatedLines: string[] = []
        let runningTokens = 0
        for (const line of codeLines) {
          // +1 approximates the escaped newline this line costs in JSON.
          const lineTokens = this.estimateTokens(line) + 1
          if (runningTokens + lineTokens > availableForCode) {
            break
          }
          truncatedLines.push(line)
          runningTokens += lineTokens
        }
        targetCode = truncatedLines.join("\n")
      }
      // Corrective passes: JSON escaping makes quote- and backslash-heavy
      // source serialize well past its raw length, so the line cut above can
      // land over. Measure the real serialized block and shave until it fits.
      // Reserve room for the truncation note charged just below, so the note
      // itself cannot tip the capsule over.
      const codeBudget = effectiveBudget - 16
      usedTokens = CAPSULE_SKELETON_TOKENS + this.serializedTokens(targetBlock())
      for (let guard = 0; guard < 10 && usedTokens > codeBudget && targetCode.length > 0; guard++) {
        const overBy = usedTokens - codeBudget
        const keepChars = Math.max(0, targetCode.length - (overBy + 8) * CHARS_PER_TOKEN)
        const roughCut = targetCode.slice(0, keepChars)
        const lastNewline = roughCut.lastIndexOf("\n")
        targetCode = lastNewline > 0 ? roughCut.slice(0, lastNewline) : roughCut
        usedTokens = CAPSULE_SKELETON_TOKENS + this.serializedTokens(targetBlock())
      }
      chargeOmission("Target code truncated to fit token budget")
    }

    if (target.uncertainty_flags.length > 0) {
      const note = `Target has ${target.uncertainty_flags.length} uncertainty flags: ${target.uncertainty_flags.join(", ")}`
      uncertaintyNotes.push(note)
      usedTokens += this.serializedTokens(note) + 1
    }

    // Progressive inclusion based on mode and budget
    // Priority order: direct deps -> callers -> tests -> contracts -> invariants -> homologs
    //                 -> dispatch targets -> effect signatures -> family members

    // Load all context in parallel where possible
    const emptyNodeRawList: { node: ContextNode; raw: SymbolRow }[] = []
    const [deps, callers, tests] = await Promise.all([
      this.loadDirectDependencies(symbolVersionId),
      mode !== "minimal" ? this.loadCallers(symbolVersionId) : Promise.resolve(emptyNodeRawList),
      mode !== "minimal" ? this.loadTestContext(symbolVersionId) : Promise.resolve([] as ContextNode[]),
    ])

    // Also load strict-mode context in parallel if needed
    let contracts: ContextNode[] = []
    let homologs: { node: ContextNode; raw: SymbolRow }[] = []
    let dispatchEdges: DispatchContextNode[] = []
    let effectEntries: EffectEntry[] = []
    let familyContext: FamilyContextNode[] = []

    if (mode === "strict") {
      const [contractResult, homologResult, dispatchResult, effectResult, familyResult] = await Promise.all([
        this.loadContractContext(symbolVersionId),
        this.loadHomologContext(snapshotId, symbolVersionId),
        this.loadDispatchContext(symbolVersionId, snapshotId),
        this.loadEffectSignature(symbolVersionId),
        this.loadConceptFamilyContext(symbolVersionId, snapshotId),
      ])
      contracts = contractResult
      homologs = homologResult
      dispatchEdges = dispatchResult
      effectEntries = effectResult
      familyContext = familyResult
    } else if (mode === "standard") {
      // Standard mode gets effect signatures but not dispatch/family
      effectEntries = await this.loadEffectSignature(symbolVersionId)
    }

    // Budget-aware node insertion with multi-resolution degradation.
    // Tries full_source first, then degrades through lower resolutions before
    // omitting entirely. Every candidate is priced at its SERIALIZED cost —
    // the tokens the consumer will actually pay for it — and a symbol whose
    // source is already in the capsule is never pasted a second time: the
    // repeat ships as a one-line signature that names where it already is.
    const includedWithCode = new Set<string>()
    const addNodeBudgeted = (node: ContextNode, category: string, rawRow?: SymbolRow): boolean => {
      const repeat = node.symbol_id !== null && node.symbol_id !== undefined && includedWithCode.has(node.symbol_id)
      const hasCode = Boolean(node.code) && !repeat
      const fullSourceTokens = this.estimateTokens(node.code || "")
      const summaryTokens = this.estimateTokens(node.summary || "")
      const signatureText = (rawRow?.signature ?? (node.summary ?? "").split("\n")[0] ?? "").trim()

      type Candidate = {
        enriched: ContextNode
        resolution: "full_source" | "signature_only" | "contract_summary" | "name_only"
        reason: string
        degraded: string | null
      }
      const candidates: Candidate[] = []

      if (hasCode) {
        candidates.push({
          enriched: {
            ...node,
            resolution: "full_source",
            inclusion_reason: `Included as ${category} — full source fits budget`,
          },
          resolution: "full_source",
          reason: `Direct ${category} via ${rawRow?.relation_type || category} relation`,
          degraded: null,
        })
      } else if (!node.code && summaryTokens > 0 && !repeat) {
        // Nodes that never had code (tests, contract summaries): their
        // summary IS the full content — include at summary level first.
        candidates.push({
          enriched: {
            ...node,
            resolution: "contract_summary",
            inclusion_reason: `Included as ${category} — summary content (no source code available)`,
          },
          resolution: "contract_summary",
          reason: `Direct ${category} — no source code, included at summary level`,
          degraded: null,
        })
      }

      if (signatureText) {
        candidates.push({
          enriched: {
            ...node,
            code: null,
            summary: signatureText || node.summary,
            resolution: "signature_only",
            inclusion_reason: repeat
              ? `Included as ${category} — source already in this capsule (deduplicated)`
              : `Included as ${category} — degraded to signature (budget)`,
          },
          resolution: "signature_only",
          reason: repeat
            ? `${category} whose source is already included above — signature only`
            : `Budget tight — degraded from full_source to signature_only`,
          degraded: repeat ? null : `${category} ${node.name}: code truncated to summary (budget)`,
        })
      }

      if (summaryTokens > 0) {
        candidates.push({
          enriched: {
            ...node,
            code: null,
            resolution: "contract_summary",
            inclusion_reason: `Included as ${category} — contract summary only (budget)`,
          },
          resolution: "contract_summary",
          reason: `Budget tight — degraded to contract_summary`,
          degraded: repeat ? null : `${category} ${node.name}: degraded to contract summary (budget)`,
        })
      }

      candidates.push({
        enriched: {
          ...node,
          code: null,
          summary: null,
          resolution: "name_only",
          inclusion_reason: `Included as ${category} — name only (budget)`,
        },
        resolution: "name_only",
        reason: `Budget tight — degraded to name_only`,
        degraded: repeat ? null : `${category} ${node.name}: degraded to name only (budget)`,
      })

      for (const candidate of candidates) {
        const cost = this.serializedTokens(candidate.enriched) + 1
        if (usedTokens + cost > effectiveBudget) continue
        contextNodes.push(candidate.enriched)
        usedTokens += cost
        if (candidate.resolution === "full_source" && node.symbol_id) {
          includedWithCode.add(node.symbol_id)
        }
        if (candidate.degraded) chargeOmission(candidate.degraded)
        inclusionRationale.push({
          node_name: node.name,
          node_type: category,
          included: true,
          resolution: candidate.resolution,
          reason: candidate.reason,
          tokens_used: cost,
          tokens_saved:
            candidate.resolution === "full_source" ? 0 : Math.max(0, fullSourceTokens + summaryTokens - cost),
        })
        return true
      }

      // Fully omitted — record rationale and create fetch handle
      chargeOmission(`Omitted ${category} ${node.name}: token budget exceeded`)
      inclusionRationale.push({
        node_name: node.name,
        node_type: category,
        included: false,
        resolution: "name_only",
        reason: `Token budget exceeded — omitted entirely`,
        tokens_used: 0,
        tokens_saved: fullSourceTokens + summaryTokens,
      })

      // Create fetch handle so the AI can request this node later
      const handle: FetchHandle | null = rawRow
        ? {
            symbol_id: rawRow.symbol_id || rawRow.symbol_version_id,
            symbol_version_id: rawRow.symbol_version_id,
            name: rawRow.canonical_name,
            file_path: rawRow.file_path || "",
            start_line: rawRow.range_start_line || 0,
            end_line: rawRow.range_end_line || 0,
            why_omitted: `Token budget exceeded (need ~${fullSourceTokens + summaryTokens} tokens, ${Math.max(0, effectiveBudget - usedTokens)} remaining)`,
            estimated_tokens: fullSourceTokens + summaryTokens,
          }
        : node.symbol_id
          ? {
              symbol_id: node.symbol_id,
              symbol_version_id: node.symbol_id,
              name: node.name,
              file_path: "",
              start_line: 0,
              end_line: 0,
              why_omitted: `Token budget exceeded (need ~${fullSourceTokens + summaryTokens} tokens, ${Math.max(0, effectiveBudget - usedTokens)} remaining)`,
              estimated_tokens: fullSourceTokens + summaryTokens,
            }
          : null
      // Handles are the escape hatch for what the budget excluded, but they
      // ship too: cap the count so a hundred omissions cannot bloat the very
      // capsule that was too full to hold them.
      if (handle && fetchHandles.length < MAX_FETCH_HANDLES) {
        fetchHandles.push(handle)
        usedTokens += this.serializedTokens(handle) + 1
      }

      return false
    }

    // 1. Direct dependencies (all modes)
    for (const dep of deps) {
      addNodeBudgeted(dep.node, "dependency", dep.raw)
    }

    // 2. Callers (standard + strict)
    if (mode !== "minimal") {
      for (const caller of callers) {
        addNodeBudgeted(caller.node, "caller", caller.raw)
      }
    }

    // 3. Test context (standard + strict)
    if (mode !== "minimal") {
      for (const test of tests) {
        addNodeBudgeted(test, "test")
      }
    }

    // 4. Contract and invariant context (strict only)
    if (mode === "strict") {
      for (const contract of contracts) {
        if (!addNodeBudgeted(contract, "contract")) break
      }

      // 5. Homolog context (strict only)
      for (const hom of homologs) {
        addNodeBudgeted(hom.node, "homolog", hom.raw)
      }

      // 6. Dispatch context — include resolved dispatch targets as context nodes
      for (const dispatch of dispatchEdges) {
        if (dispatch.resolved_target) {
          const dispatchNode: ContextNode = {
            type: "dispatch_target",
            symbol_id: null,
            name: dispatch.resolved_target,
            code: null,
            summary: `Dispatch: ${dispatch.chain} -> ${dispatch.resolved_target} (${dispatch.resolution_method}, confidence: ${dispatch.confidence.toFixed(2)})`,
            relevance: dispatch.confidence,
            resolution: "contract_summary",
            inclusion_reason: `Dispatch chain resolution for ${dispatch.chain}`,
          }
          const dispatchTokens = this.serializedTokens(dispatchNode) + 1
          if (usedTokens + dispatchTokens <= effectiveBudget) {
            contextNodes.push(dispatchNode)
            usedTokens += dispatchTokens
            inclusionRationale.push({
              node_name: dispatch.resolved_target,
              node_type: "dispatch_target",
              included: true,
              resolution: "contract_summary",
              reason: `Resolved dispatch chain: ${dispatch.chain}`,
              tokens_used: dispatchTokens,
              tokens_saved: 0,
            })
          }
        }
      }

      // 7. Concept family context — include exemplar and contradicting members
      for (const family of familyContext) {
        const familyNode: ContextNode = {
          type: "family_member",
          symbol_id: null,
          name: family.family_name,
          code: null,
          summary:
            `Concept family [${family.family_type}]: ${family.member_count} members. ` +
            (family.exemplar_name ? `Exemplar: ${family.exemplar_name}. ` : "") +
            (family.contradicting_members.length > 0
              ? `Contradicting: ${family.contradicting_members.join(", ")}`
              : "No contradictions"),
          relevance: 0.75,
          resolution: "contract_summary",
          inclusion_reason: `Target belongs to concept family "${family.family_name}"`,
        }
        const familyTokens = this.serializedTokens(familyNode) + 1
        if (usedTokens + familyTokens <= effectiveBudget) {
          contextNodes.push(familyNode)
          usedTokens += familyTokens
          inclusionRationale.push({
            node_name: family.family_name,
            node_type: "family_member",
            included: true,
            resolution: "contract_summary",
            reason: `Target is member of concept family "${family.family_name}" (${family.family_type})`,
            tokens_used: familyTokens,
            tokens_saved: 0,
          })
        }
      }
    }

    // 8. Effect signature — deduplicate, cap, and ship COUNTED. The old code
    // added a formatted summary node (counted) and then attached the entire
    // raw entry array to the capsule as well (uncounted): on a cyclic corpus
    // that array alone was ~40% of the shipped bytes and mostly photocopies.
    // Now one representation ships, priced like everything else: the full
    // structured entries when they fit, direct-only when they don't, a
    // one-line summary as the last resort.
    let shippedEffects: EffectEntry[] | undefined
    if (effectEntries.length > 0) {
      const deduped = this.dedupeEffects(effectEntries)
      const directOnly = deduped.filter((e) => !e.provenance || e.provenance === "direct")
      const tryShip = (entries: EffectEntry[], label: string): boolean => {
        if (entries.length === 0) return false
        const cost = this.serializedTokens(entries) + 2
        if (usedTokens + cost > effectiveBudget) return false
        shippedEffects = entries
        usedTokens += cost
        inclusionRationale.push({
          node_name: "Effect Signature",
          node_type: "effect",
          included: true,
          resolution: "effect_summary",
          reason: label,
          tokens_used: cost,
          tokens_saved: 0,
        })
        return true
      }
      if (
        !tryShip(deduped, "Typed effect signature (deduplicated)") &&
        !tryShip(directOnly, "Typed effect signature — direct effects only (budget)")
      ) {
        const effectSummary = this.formatEffectSignature(deduped)
        const effectNode: ContextNode = {
          type: "effect",
          symbol_id: null,
          name: "Effect Signature",
          code: null,
          summary: effectSummary,
          relevance: 0.88,
          resolution: "effect_summary",
          inclusion_reason: "Typed effect signature for target symbol",
          effect_signature: effectSummary,
        }
        const effectTokens = this.serializedTokens(effectNode) + 1
        if (usedTokens + effectTokens <= effectiveBudget) {
          contextNodes.push(effectNode)
          usedTokens += effectTokens
          inclusionRationale.push({
            node_name: "Effect Signature",
            node_type: "effect",
            included: true,
            resolution: "effect_summary",
            reason: "Typed effect signature for target and dependencies (summary line)",
            tokens_used: effectTokens,
            tokens_saved: 0,
          })
        } else {
          chargeOmission("Effect signature omitted: token budget exceeded")
        }
      }
    }

    const nodesIncluded = contextNodes.length
    const nodesOmitted = fetchHandles.length

    // What ships is what was priced. Dispatch and family context already ship
    // as context nodes, so the raw arrays would be the same information paid
    // for twice; inclusion rationale is bookkeeping and is persisted to the
    // database below instead of being billed to every consumer.
    const capsule: ContextCapsule = {
      target_symbol: targetBlock(),
      context_nodes: contextNodes,
      omission_rationale: omissionRationale,
      uncertainty_notes: uncertaintyNotes,
      token_estimate: usedTokens,
      // V2 fields
      fetch_handles: fetchHandles.length > 0 ? fetchHandles : undefined,
      effect_signature: shippedEffects,
    }

    // token_estimate is the measured serialized size of the capsule itself —
    // no longer an undercount of a subset. The safety pass trims bookkeeping
    // (never content) in the rare case rounding pushed the total past budget.
    capsule.token_estimate = this.serializedTokens(capsule)
    this.enforceBudget(capsule, effectiveBudget)
    capsule.token_estimate = this.serializedTokens(capsule)

    // Persist compilation metadata for debugging and improvement
    const compilationId = await this.persistCompilation(
      symbolVersionId,
      snapshotId,
      mode,
      effectiveBudget,
      usedTokens,
      nodesIncluded,
      nodesOmitted,
      inclusionRationale,
      fetchHandles,
    )
    if (compilationId) {
      capsule.compilation_id = compilationId
    }

    timer({ nodes: contextNodes.length, tokens: usedTokens, omissions: omissionRationale.length })
    capsuleCache.set(cacheKey, capsule)
    return capsule
  }

  /**
   * Read source code from disk with path traversal protection.
   */
  public async readSourceCode(
    basePath: string | null,
    filePath: string,
    startLine: number,
    endLine: number,
  ): Promise<string> {
    if (!basePath) {
      return `[Source code unavailable — repo base path not set]`
    }

    try {
      const safePath = resolvePathWithinBase(basePath, filePath)
      const resolved = safePath.realPath
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return `[Source code unavailable — invalid line range]`
      }
      const handle = await fsp.open(resolved, "r")
      let content: string
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_FALLBACK_SOURCE_BYTES) {
          return `[Source code unavailable — file exceeds safe read limit]`
        }
        const data = Buffer.alloc(stat.size)
        let offset = 0
        while (offset < data.length) {
          const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        content = data.subarray(0, offset).toString("utf8")
      } finally {
        await handle.close()
      }
      const lines = content.split("\n")

      // BUG-005 FIX: Defensive validation of line ranges to prevent
      // code boundary leakage from stale or mis-indexed DB data.
      const clampedStart = Math.max(1, Math.trunc(startLine))
      const clampedEnd = Math.min(lines.length, Math.trunc(endLine))

      if (clampedStart !== startLine || clampedEnd !== endLine) {
        log.warn("Line range clamped — possible stale DB line numbers", {
          filePath,
          startLine,
          endLine,
          clampedStart,
          clampedEnd,
          totalLines: lines.length,
        })
      }

      if (clampedStart > clampedEnd) {
        log.warn("Invalid line range after clamping", {
          filePath,
          clampedStart,
          clampedEnd,
        })
        return `[Source code unavailable — invalid line range]`
      }

      const extracted = lines.slice(clampedStart - 1, clampedEnd)

      // Warn if the first non-empty line doesn't look like a symbol definition —
      // may indicate the DB range_start_line includes preceding code.
      const firstNonEmpty = extracted.find((l) => l.trim().length > 0)
      if (firstNonEmpty) {
        const trimmed = firstNonEmpty.trim()
        const looksLikeDefinition =
          /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum|def |abstract\s|public\s|private\s|protected\s)/.test(
            trimmed,
          ) || /^(\/\*\*|\/\/|#|\*)/.test(trimmed) // doc-comment is also OK
        if (!looksLikeDefinition) {
          log.warn(
            "Extracted code may include preceding function — first non-empty line does not start with a recognized keyword",
            {
              filePath,
              startLine: clampedStart,
              firstLine: trimmed.slice(0, 120),
            },
          )
        }
      }

      return extracted.join("\n")
    } catch {
      return `[Source code unavailable — file not readable]`
    }
  }

  public estimateTokens(text: string): number {
    return Math.ceil(Buffer.byteLength(text, "utf-8") / CHARS_PER_TOKEN)
  }

  /**
   * Tokens a value costs the consumer once serialized into the capsule JSON.
   * This is the only honest unit for budgeting: raw text lengths ignore keys,
   * quotes and escapes, which is how capsules came to ship 2.4x their own
   * token_estimate. Measured in BYTES, not UTF-16 code units — bytes are what
   * ship, and on unicode-heavy source the two differ by half again as much.
   */
  public serializedTokens(value: unknown): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf-8") / CHARS_PER_TOKEN)
  }

  /**
   * Deduplicate effect entries by kind:descriptor — direct observations win
   * over transitive ones — then cap the transitive tail by hop count. On a
   * cyclic corpus the stored signature can hold hundreds of near-identical
   * propagated entries; past the cap they stop informing and start costing.
   */
  public dedupeEffects(entries: EffectEntry[]): EffectEntry[] {
    const byKey = new Map<string, EffectEntry>()
    for (const entry of entries) {
      const key = `${entry.kind}:${entry.descriptor}`
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, entry)
        continue
      }
      const entryDirect = !entry.provenance || entry.provenance === "direct"
      const existingDirect = !existing.provenance || existing.provenance === "direct"
      if (entryDirect && !existingDirect) byKey.set(key, entry)
    }
    const deduped = [...byKey.values()]
    const direct = deduped.filter((e) => !e.provenance || e.provenance === "direct")
    const transitive = deduped
      .filter((e) => e.provenance === "transitive")
      .sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99))
    return [...direct, ...transitive.slice(0, MAX_TRANSITIVE_EFFECT_ENTRIES)]
  }

  /**
   * Last-resort budget enforcement on the assembled capsule. Content was
   * priced as it was added, so overshoot here is bookkeeping and rounding;
   * trim in order of least value — fetch handles, omission notes, transitive
   * effect entries — and never touch the target or the context nodes.
   */
  private enforceBudget(capsule: ContextCapsule, budget: number): void {
    const over = () => this.serializedTokens(capsule) > budget
    if (!over()) return

    while (over() && (capsule.fetch_handles?.length ?? 0) > 0) {
      capsule.fetch_handles!.pop()
      if (capsule.fetch_handles!.length === 0) capsule.fetch_handles = undefined
    }
    if (over() && capsule.omission_rationale.length > 1) {
      capsule.omission_rationale = [`${capsule.omission_rationale.length} nodes omitted or degraded (budget)`]
    }
    if (over() && capsule.uncertainty_notes.length > 0) {
      capsule.uncertainty_notes = [`${capsule.uncertainty_notes.length} uncertainty notes elided (budget)`]
    }
    while (over() && (capsule.effect_signature?.length ?? 0) > 0) {
      let idx = -1
      for (let i = capsule.effect_signature!.length - 1; i >= 0; i--) {
        if (capsule.effect_signature![i]!.provenance === "transitive") {
          idx = i
          break
        }
      }
      if (idx < 0) break
      capsule.effect_signature!.splice(idx, 1)
      if (capsule.effect_signature!.length === 0) capsule.effect_signature = undefined
    }

    // Guaranteed fit: if rounding in the per-piece charges still leaves the
    // capsule over budget, degrade context nodes from the tail — lowest
    // priority was added last — to signature-level, then drop them. The
    // target itself is never touched; it was truncated to fit up front.
    for (let i = capsule.context_nodes.length - 1; over() && i >= 0; i--) {
      const node = capsule.context_nodes[i]!
      if (node.code) {
        node.code = null
        node.resolution = "signature_only"
        node.inclusion_reason = `${node.inclusion_reason ?? "Included"} (degraded by final budget pass)`
      }
    }
    while (over() && capsule.context_nodes.length > 0) {
      capsule.context_nodes.pop()
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // V1 Data Loaders (preserved)
  // ────────────────────────────────────────────────────────────────────

  public async loadSymbolVersion(svId: string): Promise<{
    symbol_id: string
    canonical_name: string
    signature: string
    file_path: string
    range_start_line: number
    range_end_line: number
    body_source: string | null
    uncertainty_flags: string[]
  } | null> {
    const result = await db.query(
      `
            SELECT sv.symbol_id, s.canonical_name, sv.signature,
                   f.path as file_path, sv.range_start_line, sv.range_end_line,
                   sv.body_source, sv.uncertainty_flags
            FROM symbol_versions sv
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE sv.symbol_version_id = $1
        `,
      [svId],
    )
    return (
      (result.rows[0] as
        | {
            symbol_id: string
            canonical_name: string
            signature: string
            file_path: string
            range_start_line: number
            range_end_line: number
            body_source: string | null
            uncertainty_flags: string[]
          }
        | undefined) ?? null
    )
  }

  public async loadDirectDependencies(svId: string): Promise<{ node: ContextNode; raw: SymbolRow }[]> {
    // One row per dependency symbol. The extractor records both a `calls`
    // edge and a `references` edge for the same pair — calling a function is
    // also referencing it — and without DISTINCT ON the same dependency
    // arrived twice, was pasted into the capsule twice at full source, and
    // consumed two slots of the LIMIT. Half the dependency capacity of every
    // capsule went to photocopies. The strongest relation represents each
    // pair: a call outranks a type usage outranks a bare mention.
    const result = await db.query(
      `
            SELECT * FROM (
              SELECT DISTINCT ON (sv.symbol_version_id)
                     sv.symbol_version_id, sv.symbol_id, s.canonical_name, sv.signature, sv.summary,
                     sv.body_source, sr.relation_type, sr.confidence,
                     f.path as file_path, sv.range_start_line, sv.range_end_line
              FROM structural_relations sr
              JOIN symbol_versions sv ON sv.symbol_version_id = sr.dst_symbol_version_id
              JOIN symbols s ON s.symbol_id = sv.symbol_id
              JOIN files f ON f.file_id = sv.file_id
              WHERE sr.src_symbol_version_id = $1
              ORDER BY sv.symbol_version_id,
                       CASE sr.relation_type
                         WHEN 'calls' THEN 0
                         WHEN 'inherits' THEN 1
                         WHEN 'implements' THEN 1
                         WHEN 'typed_as' THEN 2
                         ELSE 3
                       END,
                       sr.confidence DESC
            ) dep
            ORDER BY CASE dep.relation_type
                       WHEN 'calls' THEN 0
                       WHEN 'inherits' THEN 1
                       WHEN 'implements' THEN 1
                       WHEN 'typed_as' THEN 2
                       ELSE 3
                     END,
                     dep.confidence DESC
            LIMIT 80
        `,
      [svId],
    )

    return (
      result.rows as (SymbolRow & {
        relation_type: string
      })[]
    ).map((row) => ({
      node: {
        type: "dependency" as const,
        symbol_id: row.symbol_version_id,
        name: row.canonical_name,
        code: row.body_source ?? null,
        summary: `${row.relation_type}: ${row.signature || row.summary || "no summary"}`,
        relevance: row.confidence,
      },
      raw: row,
    }))
  }

  public async loadCallers(svId: string): Promise<{ node: ContextNode; raw: SymbolRow }[]> {
    // One row per caller symbol (DISTINCT ON) — a caller that both calls and
    // references the target used to arrive twice and be pasted twice.
    // Callers before referencers: something that INVOKES this symbol answers
    // "what breaks if I change it" directly; something that merely mentions
    // it — reads a constant, names a type — is weaker evidence. Confidence
    // alone is a constant for statically extracted edges, so without the
    // relation ranking, plentiful references crowded real callers out of the
    // limit and the capsule presented mentions as callers.
    const result = await db.query(
      `
            SELECT * FROM (
              SELECT DISTINCT ON (sv.symbol_version_id)
                     sv.symbol_version_id, sv.symbol_id, s.canonical_name, sv.signature, sv.summary,
                     sv.body_source, sr.relation_type, sr.confidence,
                     f.path as file_path, sv.range_start_line, sv.range_end_line
              FROM structural_relations sr
              JOIN symbol_versions sv ON sv.symbol_version_id = sr.src_symbol_version_id
              JOIN symbols s ON s.symbol_id = sv.symbol_id
              JOIN files f ON f.file_id = sv.file_id
              WHERE sr.dst_symbol_version_id = $1
              AND sr.relation_type IN ('calls', 'references')
              ORDER BY sv.symbol_version_id,
                       CASE sr.relation_type WHEN 'calls' THEN 0 ELSE 1 END,
                       sr.confidence DESC
            ) caller
            ORDER BY CASE caller.relation_type WHEN 'calls' THEN 0 ELSE 1 END, caller.confidence DESC
            LIMIT 10
        `,
      [svId],
    )

    return (result.rows as SymbolRow[]).map((row) => ({
      node: {
        type: "caller" as const,
        symbol_id: row.symbol_version_id,
        name: row.canonical_name,
        code: row.body_source ?? null,
        summary: row.signature || row.summary || "no summary",
        relevance: row.confidence,
      },
      raw: row,
    }))
  }

  public async loadTestContext(svId: string): Promise<ContextNode[]> {
    // Real test cases first — a `test_case` symbol is an it/test block whose
    // body exercises the target, which doubles as a usage example — then the
    // named helpers that merely live in test files. The test's own source
    // ships when the budget allows; the budget ladder degrades it to the
    // title line when it does not.
    const result = await db.query(
      `
            SELECT ta.test_artifact_id, ta.assertion_summary, ta.framework,
                   sv.symbol_version_id, sv.body_source, s.canonical_name, s.kind
            FROM test_artifacts ta
            JOIN symbol_versions sv ON sv.symbol_version_id = ta.symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            WHERE $1 = ANY(ta.related_symbols)
            ORDER BY CASE s.kind WHEN 'test_case' THEN 0 ELSE 1 END
            LIMIT 5
        `,
      [svId],
    )

    return (
      result.rows as {
        test_artifact_id: string
        assertion_summary: string
        framework: string
        symbol_version_id: string
        body_source: string | null
        canonical_name: string
        kind: string
      }[]
    ).map((row) => ({
      type: "test" as const,
      symbol_id: row.symbol_version_id,
      name: row.canonical_name,
      code: row.kind === "test_case" ? (row.body_source ?? null) : null,
      summary: `[${row.framework}] ${row.assertion_summary || "test case"}`,
      relevance: 0.85,
    }))
  }

  public async loadContractContext(svId: string): Promise<ContextNode[]> {
    const result = await db.query(
      `
            SELECT cp.input_contract, cp.output_contract, cp.error_contract,
                   cp.security_contract, cp.serialization_contract
            FROM contract_profiles cp
            WHERE cp.symbol_version_id = $1
        `,
      [svId],
    )

    if (result.rows.length === 0) return []

    const cp = result.rows[0] as {
      input_contract: string
      output_contract: string
      error_contract: string
      security_contract: string
      serialization_contract: string
    }

    return [
      {
        type: "contract" as const,
        symbol_id: null,
        name: "Contract Profile",
        code: null,
        summary: `Input: ${cp.input_contract} → Output: ${cp.output_contract} | Errors: ${cp.error_contract} | Security: ${cp.security_contract}`,
        relevance: 0.9,
      },
    ]
  }

  public async loadHomologContext(snapshotId: string, svId: string): Promise<{ node: ContextNode; raw: SymbolRow }[]> {
    const result = await db.query(
      `
            SELECT ir.dst_symbol_version_id, ir.relation_type, ir.confidence,
                   s.canonical_name, sv.signature, sv.body_source, sv.symbol_id,
                   f.path as file_path, sv.range_start_line, sv.range_end_line
            FROM inferred_relations ir
            JOIN symbol_versions sv ON sv.symbol_version_id = ir.dst_symbol_version_id
            JOIN symbols s ON s.symbol_id = sv.symbol_id
            JOIN files f ON f.file_id = sv.file_id
            WHERE ir.src_symbol_version_id = $1
            AND ir.confidence >= 0.70
            AND ir.review_state != 'rejected'
            ORDER BY ir.confidence DESC
            LIMIT 5
        `,
      [svId],
    )

    return (
      result.rows as {
        dst_symbol_version_id: string
        relation_type: string
        confidence: number
        canonical_name: string
        signature: string
        body_source: string | null
        symbol_id: string
        file_path: string
        range_start_line: number
        range_end_line: number
      }[]
    ).map((row) => ({
      node: {
        type: "homolog" as const,
        symbol_id: row.dst_symbol_version_id,
        name: row.canonical_name,
        code: row.body_source ?? null,
        summary: `${row.relation_type} (confidence: ${row.confidence.toFixed(2)}): ${row.signature || "no signature"}`,
        relevance: row.confidence,
      },
      raw: {
        symbol_version_id: row.dst_symbol_version_id,
        symbol_id: row.symbol_id,
        canonical_name: row.canonical_name,
        signature: row.signature,
        summary: `${row.relation_type} (confidence: ${row.confidence.toFixed(2)})`,
        body_source: row.body_source,
        file_path: row.file_path,
        range_start_line: row.range_start_line,
        range_end_line: row.range_end_line,
        relation_type: row.relation_type,
        confidence: row.confidence,
      },
    }))
  }

  // ────────────────────────────────────────────────────────────────────
  // V2 Data Loaders
  // ────────────────────────────────────────────────────────────────────

  /**
   * Load dispatch edges for the target symbol. Returns resolved dispatch
   * chains so the AI can see what `self.service.validate()` actually calls.
   */
  private async loadDispatchContext(symbolVersionId: string, snapshotId: string): Promise<DispatchContextNode[]> {
    try {
      const result = await db.query(
        `
                SELECT de.receiver_expression,
                       de.resolved_symbol_version_ids,
                       de.resolution_method,
                       de.confidence,
                       de.is_polymorphic
                FROM dispatch_edges de
                WHERE de.caller_symbol_version_id = $1
                  AND de.snapshot_id = $2
                  AND de.confidence >= 0.5
                ORDER BY de.confidence DESC
                LIMIT 10
            `,
        [symbolVersionId, snapshotId],
      )

      if (result.rows.length === 0) return []

      const rows = result.rows as {
        receiver_expression: string
        resolved_symbol_version_ids: string[]
        resolution_method: string
        confidence: number
        is_polymorphic: boolean
      }[]

      // Batch-load all first-target symbol names in a single query
      const targetIds = rows.map((r) => r.resolved_symbol_version_ids[0]).filter((id): id is string => id != null)
      const uniqueTargetIds = [...new Set(targetIds)]

      const targetMap = new Map<string, { canonical_name: string; signature: string }>()
      if (uniqueTargetIds.length > 0) {
        const targetResult = await db.query(
          `
                    SELECT sv.symbol_version_id, s.canonical_name, sv.signature
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.symbol_version_id = ANY($1)
                `,
          [uniqueTargetIds],
        )

        for (const tRow of targetResult.rows as {
          symbol_version_id: string
          canonical_name: string
          signature: string
        }[]) {
          targetMap.set(tRow.symbol_version_id, {
            canonical_name: tRow.canonical_name,
            signature: tRow.signature,
          })
        }
      }

      const dispatchNodes: DispatchContextNode[] = []

      for (const row of rows) {
        let resolvedTarget: string | null = null
        let targetSignature: string | null = null

        const firstId = row.resolved_symbol_version_ids[0]
        if (firstId) {
          const cached = targetMap.get(firstId)
          if (cached) {
            resolvedTarget = cached.canonical_name
            targetSignature = cached.signature
          }
        }

        dispatchNodes.push({
          chain: row.receiver_expression,
          resolved_target: resolvedTarget,
          target_signature: targetSignature,
          resolution_method: row.resolution_method,
          confidence: row.confidence,
        })
      }

      return dispatchNodes
    } catch (err) {
      // Table may not exist yet if migration hasn't run
      log.debug("dispatch_edges query failed — table may not exist yet", {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  /**
   * Load typed effect signature for the target symbol. Returns structured
   * effect entries that tell the AI what side effects to expect.
   */
  private async loadEffectSignature(symbolVersionId: string): Promise<EffectEntry[]> {
    try {
      const result = await db.query(
        `
                SELECT es.effects, es.effect_class,
                       es.reads_resources, es.writes_resources,
                       es.emits_events, es.calls_external,
                       es.mutates_state, es.requires_auth,
                       es.throws_errors, es.confidence
                FROM effect_signatures es
                WHERE es.symbol_version_id = $1
                ORDER BY es.confidence DESC
                LIMIT 1
            `,
        [symbolVersionId],
      )

      if (result.rows.length === 0) return []

      const row = result.rows[0] as {
        effects: EffectEntry[]
        effect_class: string
        reads_resources: string[]
        writes_resources: string[]
        emits_events: string[]
        calls_external: string[]
        mutates_state: string[]
        requires_auth: string[]
        throws_errors: string[]
        confidence: number
      }

      // If we have structured effects from JSONB, use them directly
      if (Array.isArray(row.effects) && row.effects.length > 0) {
        return row.effects
      }

      // Otherwise, synthesize from the flattened resource arrays
      const synthesized: EffectEntry[] = []
      const conf = `confidence: ${row.confidence.toFixed(2)}`

      for (const r of row.reads_resources) {
        synthesized.push({ kind: "reads", descriptor: r, detail: conf, provenance: "direct" })
      }
      for (const w of row.writes_resources) {
        synthesized.push({ kind: "writes", descriptor: w, detail: conf, provenance: "direct" })
      }
      for (const e of row.emits_events) {
        synthesized.push({ kind: "emits", descriptor: e, detail: conf, provenance: "direct" })
      }
      for (const c of row.calls_external) {
        synthesized.push({ kind: "calls_external", descriptor: c, detail: conf, provenance: "direct" })
      }
      for (const m of row.mutates_state) {
        synthesized.push({ kind: "mutates", descriptor: m, detail: conf, provenance: "direct" })
      }
      for (const a of row.requires_auth) {
        synthesized.push({ kind: "requires", descriptor: a, detail: conf, provenance: "direct" })
      }
      for (const t of row.throws_errors) {
        synthesized.push({ kind: "throws", descriptor: t, detail: conf, provenance: "direct" })
      }

      return synthesized
    } catch (err) {
      log.debug("effect_signatures query failed — table may not exist yet", {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  /**
   * Load concept family context for the target symbol. If the target belongs
   * to a concept family, returns the family's canonical exemplar and any
   * contradicting members.
   */
  private async loadConceptFamilyContext(symbolVersionId: string, snapshotId: string): Promise<FamilyContextNode[]> {
    try {
      // Find which families the target belongs to
      const memberResult = await db.query(
        `
                SELECT cfm.family_id, cfm.is_exemplar, cfm.is_contradicting,
                       cfm.similarity_to_exemplar, cfm.membership_confidence,
                       cf.family_name, cf.family_type, cf.member_count,
                       cf.exemplar_symbol_version_id
                FROM concept_family_members cfm
                JOIN concept_families cf ON cf.family_id = cfm.family_id
                WHERE cfm.symbol_version_id = $1
                  AND cf.snapshot_id = $2
                ORDER BY cfm.membership_confidence DESC
                LIMIT 3
            `,
        [symbolVersionId, snapshotId],
      )

      if (memberResult.rows.length === 0) return []

      const rows = memberResult.rows as {
        family_id: string
        is_exemplar: boolean
        is_contradicting: boolean
        similarity_to_exemplar: number
        membership_confidence: number
        family_name: string
        family_type: string
        member_count: number
        exemplar_symbol_version_id: string | null
      }[]

      // Batch-load all exemplar names in a single query
      const exemplarIds = rows
        .filter((r) => r.exemplar_symbol_version_id && !r.is_exemplar)
        .map((r) => r.exemplar_symbol_version_id as string)
      const uniqueExemplarIds = [...new Set(exemplarIds)]

      const exemplarMap = new Map<string, { canonical_name: string; signature: string }>()
      if (uniqueExemplarIds.length > 0) {
        const exemplarResult = await db.query(
          `
                    SELECT sv.symbol_version_id, s.canonical_name, sv.signature
                    FROM symbol_versions sv
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE sv.symbol_version_id = ANY($1)
                `,
          [uniqueExemplarIds],
        )

        for (const eRow of exemplarResult.rows as {
          symbol_version_id: string
          canonical_name: string
          signature: string
        }[]) {
          exemplarMap.set(eRow.symbol_version_id, {
            canonical_name: eRow.canonical_name,
            signature: eRow.signature,
          })
        }
      }

      // Batch-load all contradicting members across all families in a single query
      const familyIds = [...new Set(rows.map((r) => r.family_id))]
      const contradictMap = new Map<string, string[]>()
      if (familyIds.length > 0) {
        const contradictResult = await db.query(
          `
                    SELECT cfm.family_id, s.canonical_name
                    FROM concept_family_members cfm
                    JOIN symbol_versions sv ON sv.symbol_version_id = cfm.symbol_version_id
                    JOIN symbols s ON s.symbol_id = sv.symbol_id
                    WHERE cfm.family_id = ANY($1)
                      AND cfm.is_contradicting = TRUE
                      AND cfm.symbol_version_id != $2
                `,
          [familyIds, symbolVersionId],
        )

        for (const cRow of contradictResult.rows as {
          family_id: string
          canonical_name: string
        }[]) {
          const existing = contradictMap.get(cRow.family_id) || []
          existing.push(cRow.canonical_name)
          contradictMap.set(cRow.family_id, existing)
        }
      }

      const families: FamilyContextNode[] = []

      for (const row of rows) {
        let exemplarName: string | null = null
        let exemplarSignature: string | null = null

        if (row.exemplar_symbol_version_id && !row.is_exemplar) {
          const cached = exemplarMap.get(row.exemplar_symbol_version_id)
          if (cached) {
            exemplarName = cached.canonical_name
            exemplarSignature = cached.signature
          }
        }

        // Limit to 5 contradicting members per family (matching original behavior)
        const contradictingMembers = (contradictMap.get(row.family_id) || []).slice(0, 5)

        families.push({
          family_name: row.family_name,
          family_type: row.family_type,
          exemplar_name: exemplarName,
          exemplar_signature: exemplarSignature,
          member_count: row.member_count,
          is_target_exemplar: row.is_exemplar,
          contradicting_members: contradictingMembers,
        })
      }

      return families
    } catch (err) {
      log.debug("concept_families query failed — table may not exist yet", {
        error: err instanceof Error ? err.message : String(err),
      })
      return []
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // V2 Helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Format a list of effect entries into a human-readable effect signature string.
   */
  private formatEffectSignature(effects: EffectEntry[]): string {
    if (effects.length === 0) return "pure (no effects)"

    const grouped: Record<string, string[]> = {}
    for (const effect of effects) {
      const kind = effect.kind
      if (!grouped[kind]) grouped[kind] = []
      grouped[kind].push(effect.descriptor ?? effect.detail ?? "unknown")
    }

    const parts: string[] = []
    for (const [kind, resources] of Object.entries(grouped)) {
      parts.push(`${kind}(${resources.join(", ")})`)
    }

    return parts.join(" | ")
  }

  /**
   * Persist compilation metadata to capsule_compilations table.
   * Returns the capsule_id on success, or null if persistence fails
   * (non-blocking — compilation works even without persistence).
   */
  private async persistCompilation(
    symbolVersionId: string,
    snapshotId: string,
    mode: CapsuleMode,
    tokenBudget: number,
    tokenEstimate: number,
    nodesIncluded: number,
    nodesOmitted: number,
    rationale: InclusionRationale[],
    handles: FetchHandle[],
  ): Promise<string | null> {
    const capsuleId = uuidv4()
    try {
      const inclusionEntries = rationale.filter((r) => r.included)
      const exclusionEntries = rationale.filter((r) => !r.included)

      await db.query(
        `
                INSERT INTO capsule_compilations (
                    capsule_id, symbol_version_id, snapshot_id,
                    mode, token_budget, token_estimate,
                    nodes_included, nodes_omitted,
                    inclusion_rationale, exclusion_rationale,
                    omitted_handles
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `,
        [
          capsuleId,
          symbolVersionId,
          snapshotId,
          mode,
          tokenBudget,
          tokenEstimate,
          nodesIncluded,
          nodesOmitted,
          JSON.stringify(inclusionEntries),
          JSON.stringify(exclusionEntries),
          JSON.stringify(handles),
        ],
      )

      log.debug("Capsule compilation persisted", {
        capsuleId,
        symbolVersionId,
        mode,
        nodesIncluded,
        nodesOmitted,
      })
      return capsuleId
    } catch (err) {
      // Non-blocking: log the error but don't fail the compilation
      log.warn("Failed to persist capsule compilation — continuing without persistence", {
        error: err instanceof Error ? err.message : String(err),
        capsuleId,
        symbolVersionId,
      })
      return null
    }
  }
}

export const capsuleCompiler = new CapsuleCompiler()
