/**
 * Ground-truth evaluation of effect analysis.
 *
 * Runs the CURRENT extractor (type-resolved + scoped syntactic patterns)
 * against the hand-labeled fixture suite in
 * src/__tests__/fixtures/effect-eval/ and scores per-category precision,
 * recall, and F1 against expected.json. Also scores a faithful
 * reconstruction of the LEGACY (v2.3) analyzer — the broad regex pattern
 * set applied to raw source text — so the improvement is a measured number
 * instead of a claim.
 *
 * Usage:  npx ts-node scripts/effect-eval.ts [--json]
 */

import * as fs from "fs"
import * as path from "path"
import { extractFromTypeScript } from "../src/adapters/ts"
import type { BehaviorHint } from "../src/types"

const FIXTURE_DIR = path.join(__dirname, "..", "src", "__tests__", "fixtures", "effect-eval")
const SCORED_CATEGORIES = [
  "db_read",
  "db_write",
  "network_call",
  "file_io",
  "cache_op",
  "transaction",
  "concurrency",
  "auth_check",
] as const
type ScoredCategory = (typeof SCORED_CATEGORIES)[number]

// ── Legacy (v2.3) analyzer reconstruction ────────────────────────────────────
// The exact external-category patterns shipped in 2.3.0, applied the way 2.3
// applied them: line-by-line over RAW function text (comments and strings
// included). Local categories are omitted — the eval scores externals only.
const LEGACY_PATTERNS: { pattern: RegExp; hint_type: ScoredCategory }[] = [
  { pattern: /\.find(One|Many|All|ById|Unique|First|Where)\s*\(/, hint_type: "db_read" },
  { pattern: /\.select\s*\(\s*['"`{]/, hint_type: "db_read" },
  { pattern: /\.query\s*\(\s*['"`]/, hint_type: "db_read" },
  {
    pattern:
      /\b(db|model|repo|repository|collection|table|prisma|knex|sequelize|typeorm|pool|client)\.\w*(?:get|find|select|query|count|aggregate)\w*\s*\(/,
    hint_type: "db_read",
  },
  { pattern: /\.save\s*\(\s*\{/, hint_type: "db_write" },
  { pattern: /\.insert(One|Many)?\s*\(/, hint_type: "db_write" },
  { pattern: /\.update(One|Many|ById|Where)?\s*\(\s*\{/, hint_type: "db_write" },
  { pattern: /\.delete(One|Many|ById|Where)\s*\(/, hint_type: "db_write" },
  { pattern: /\.destroy\s*\(/, hint_type: "db_write" },
  {
    pattern:
      /\b(db|model|repo|repository|collection|table|prisma|knex|sequelize|typeorm|pool|client)\.\w*(?:save|insert|update|delete|remove|create|upsert|destroy)\w*\s*\(/,
    hint_type: "db_write",
  },
  { pattern: /fetch\s*\(/, hint_type: "network_call" },
  { pattern: /axios\.(get|post|put|patch|delete)\s*\(/, hint_type: "network_call" },
  { pattern: /\.request\s*\(/, hint_type: "network_call" },
  { pattern: /https?\.\s*(get|request)\s*\(/, hint_type: "network_call" },
  { pattern: /WebSocket/, hint_type: "network_call" },
  { pattern: /fs\.(read|write|append|unlink|mkdir|rmdir)/, hint_type: "file_io" },
  { pattern: /readFile(Sync)?\s*\(/, hint_type: "file_io" },
  { pattern: /writeFile(Sync)?\s*\(/, hint_type: "file_io" },
  { pattern: /\.cache\.(get|set|del|clear)/, hint_type: "cache_op" },
  { pattern: /redis\.(get|set|hget|hset|del)/, hint_type: "cache_op" },
  { pattern: /\.transaction\s*\(/, hint_type: "transaction" },
  { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: "transaction" },
  { pattern: /\.authenticate\s*\(/, hint_type: "auth_check" },
  { pattern: /\.authorize\s*\(/, hint_type: "auth_check" },
  { pattern: /verify(Token|JWT|Session)/, hint_type: "auth_check" },
  { pattern: /\.isAuthenticated/, hint_type: "auth_check" },
]

interface Scores {
  tp: number
  fp: number
  fn: number
}

function score(predictedByFn: Map<string, Set<string>>, expected: Record<string, string[]>): Map<string, Scores> {
  const perCategory = new Map<string, Scores>()
  for (const cat of SCORED_CATEGORIES) perCategory.set(cat, { tp: 0, fp: 0, fn: 0 })

  for (const [fnKey, expectedCats] of Object.entries(expected)) {
    if (fnKey.startsWith("_")) continue
    const predicted = predictedByFn.get(fnKey) ?? new Set<string>()
    const expectedSet = new Set(expectedCats)
    for (const cat of SCORED_CATEGORIES) {
      const s = perCategory.get(cat)!
      const inPred = predicted.has(cat)
      const inExp = expectedSet.has(cat)
      if (inPred && inExp) s.tp++
      else if (inPred && !inExp) s.fp++
      else if (!inPred && inExp) s.fn++
    }
  }
  return perCategory
}

function prf(s: Scores): { precision: number; recall: number; f1: number } {
  const precision = s.tp + s.fp === 0 ? 1 : s.tp / (s.tp + s.fp)
  const recall = s.tp + s.fn === 0 ? 1 : s.tp / (s.tp + s.fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

function aggregate(perCategory: Map<string, Scores>): Scores {
  const total: Scores = { tp: 0, fp: 0, fn: 0 }
  for (const s of perCategory.values()) {
    total.tp += s.tp
    total.fp += s.fp
    total.fn += s.fn
  }
  return total
}

/** Extract each labeled function's raw text for the legacy analyzer. */
function functionTexts(filePath: string): Map<string, string> {
  // Reuse the shipped extractor's symbol ranges to slice raw text per function.
  const source = fs.readFileSync(filePath, "utf-8")
  const lines = source.split("\n")
  const texts = new Map<string, string>()
  // Cheap structural pass: find top-level `export (async) function NAME` and
  // `export const NAME = ...` blocks; slice to the next top-level export or EOF.
  const starts: { name: string; line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/)
    if (m && m[1]) starts.push({ name: m[1], line: i })
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.line
    const to = i + 1 < starts.length ? starts[i + 1]!.line : lines.length
    texts.set(starts[i]!.name, lines.slice(from, to).join("\n"))
  }
  return texts
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json")
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf-8")) as Record<
    string,
    string[]
  >
  const fixtureFiles = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(FIXTURE_DIR, f))

  // ── Current analyzer ──
  const result = await extractFromTypeScript(fixtureFiles)
  const currentByFn = new Map<string, Set<string>>()
  for (const hint of result.behavior_hints as BehaviorHint[]) {
    // symbol_key = <abs-or-rel path>#<name>; normalize to <basename>#<name>
    const hashIdx = hint.symbol_key.lastIndexOf("#")
    const filePart = hint.symbol_key.slice(0, hashIdx)
    const namePart = hint.symbol_key.slice(hashIdx + 1)
    const key = `${path.basename(filePart)}#${namePart}`
    if (!(SCORED_CATEGORIES as readonly string[]).includes(hint.hint_type)) continue
    const set = currentByFn.get(key) ?? new Set<string>()
    set.add(hint.hint_type)
    currentByFn.set(key, set)
  }

  // ── Legacy analyzer ──
  const legacyByFn = new Map<string, Set<string>>()
  for (const file of fixtureFiles) {
    for (const [fnName, text] of functionTexts(file)) {
      const key = `${path.basename(file)}#${fnName}`
      const set = legacyByFn.get(key) ?? new Set<string>()
      for (const lp of LEGACY_PATTERNS) {
        if (lp.pattern.test(text)) set.add(lp.hint_type)
      }
      legacyByFn.set(key, set)
    }
  }

  const currentScores = score(currentByFn, expected)
  const legacyScores = score(legacyByFn, expected)
  const currentTotal = prf(aggregate(currentScores))
  const legacyTotal = prf(aggregate(legacyScores))

  if (asJson) {
    const toObj = (m: Map<string, Scores>): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const [cat, s] of m) out[cat] = { ...s, ...prf(s) }
      return out
    }
    console.log(
      JSON.stringify(
        {
          fixtures: Object.keys(expected).filter((k) => !k.startsWith("_")).length,
          current: { perCategory: toObj(currentScores), overall: { ...aggregate(currentScores), ...currentTotal } },
          legacy: { perCategory: toObj(legacyScores), overall: { ...aggregate(legacyScores), ...legacyTotal } },
        },
        null,
        2,
      ),
    )
    return
  }

  const fmt = (n: number): string => (n * 100).toFixed(1).padStart(5) + "%"
  console.log("Effect-analysis ground-truth eval")
  console.log(`Fixtures: ${Object.keys(expected).filter((k) => !k.startsWith("_")).length} labeled functions\n`)
  console.log("category        | current  P      R      F1   | legacy   P      R      F1")
  console.log("----------------+-----------------------------+---------------------------")
  for (const cat of SCORED_CATEGORIES) {
    const c = prf(currentScores.get(cat)!)
    const l = prf(legacyScores.get(cat)!)
    console.log(
      `${cat.padEnd(15)} |        ${fmt(c.precision)} ${fmt(c.recall)} ${fmt(c.f1)} |        ${fmt(l.precision)} ${fmt(l.recall)} ${fmt(l.f1)}`,
    )
  }
  console.log("----------------+-----------------------------+---------------------------")
  console.log(
    `OVERALL         |        ${fmt(currentTotal.precision)} ${fmt(currentTotal.recall)} ${fmt(currentTotal.f1)} |        ${fmt(legacyTotal.precision)} ${fmt(legacyTotal.recall)} ${fmt(legacyTotal.f1)}`,
  )

  // Per-function diff for debugging
  console.log("\nPer-function (current):")
  for (const key of Object.keys(expected)) {
    if (key.startsWith("_")) continue
    const exp = new Set(expected[key])
    const got = currentByFn.get(key) ?? new Set()
    const ok = exp.size === got.size && [...exp].every((c) => got.has(c))
    if (!ok) {
      console.log(`  MISMATCH ${key}: expected [${[...exp].join(",")}] got [${[...got].join(",")}]`)
    }
  }
  console.log("  (functions not listed matched exactly)")
}

main().catch((err) => {
  console.error("effect-eval failed:", err)
  process.exit(1)
})
