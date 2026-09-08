/**
 * ContextZero — shared regular-expression safety.
 *
 * One guard, imported by every code-search path (the indexed `searchCode`
 * service and the native `searchWorkspaceCode` walker). Node has no regex
 * timeout and the engine is single-threaded, so a catastrophically
 * backtracking pattern hangs the whole process across every file it scans.
 * Two divergent guards used to exist; the weaker one let sequential and
 * overlapping-alternation forms through. This is the single source of truth.
 */

/** Minimal logger surface — satisfied by every logger in the codebase. */
export interface RegexSafetyLogger {
  debug?(message: string, data?: Record<string, unknown>): void
}

/** Escape a pattern so it matches literally — the fallback when a regex is refused. */
export function literalRegex(pattern: string): RegExp {
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
}

/**
 * Detect patterns with catastrophic-backtracking potential.
 *
 * The whole classic family is "a quantified group whose body can match the same
 * input more than one way" — i.e. a group carrying +/*\/{n,} that contains
 * either an alternation or another quantifier. That covers (a+)+, (a*)*,
 * (a|aa)+, (a|a?)+, (\w|\w\w)+ and friends.
 *
 * A flat sequence of quantified atoms — `a*a*a*…b` — is the same hazard without
 * a group: each atom overlaps its neighbour, so a non-match backtracks
 * exponentially. It is caught here too.
 *
 * This over-approximates: a non-overlapping pattern like `(foo|bar)+` is also
 * flagged. That is deliberate — the fallback is an escaped literal search, which
 * still returns useful results, and callers are told via the `mode` field.
 * Detecting genuine overlap needs full regex analysis; refusing to backtrack on
 * anything of this shape is the honest trade.
 *
 * Residual risk: this is a static heuristic, not a proof. A guaranteed bound
 * needs the match to run off-thread with a hard kill, which the indexed search
 * path does. On the inline paths this guard is the load-bearing defence.
 */
export function hasQuantifiedComplexGroup(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++ // skip the escaped character
      continue
    }
    if (pattern[i] !== "(") continue

    // Walk to this group's matching ')', tracking escapes, nesting and classes.
    let depth = 0
    let inClass = false
    let bodyHasAlternation = false
    let bodyHasQuantifier = false
    let end = -1
    for (let j = i; j < pattern.length; j++) {
      const ch = pattern[j]
      if (ch === "\\") {
        j++
        continue
      }
      if (inClass) {
        if (ch === "]") inClass = false
        continue
      }
      if (ch === "[") {
        inClass = true
        continue
      }
      if (ch === "(") {
        depth++
        continue
      }
      if (ch === ")") {
        depth--
        if (depth === 0) {
          end = j
          break
        }
        continue
      }
      if (depth === 1) {
        if (ch === "|") bodyHasAlternation = true
        if (ch === "+" || ch === "*" || ch === "?" || ch === "{") bodyHasQuantifier = true
      } else if (depth > 1) {
        // A nested group is itself a way for the body to match ambiguously.
        bodyHasQuantifier = true
      }
    }
    if (end === -1) continue // unbalanced — new RegExp() will reject it anyway

    const next = pattern[end + 1]
    const groupIsQuantified = next === "+" || next === "*" || next === "{"
    if (groupIsQuantified && (bodyHasAlternation || bodyHasQuantifier)) {
      return true
    }
  }

  // Group-free overlap: the same atom, quantified, twice in a row — `a*a*…`,
  // `\d+\d+`, `[ab]*[ab]*`, `.*.*`. Identical atoms overlap fully, so a
  // trailing non-match backtracks across every division of the run, which is
  // O(n^k) in the length of the run and hangs a long (e.g. minified) line.
  // Requiring IDENTICAL atoms keeps disjoint neighbours safe: `\s+\w+`,
  // `a+b*` and `\d{3}-\d{4}` match different characters and cannot overlap.
  return hasRepeatedQuantifiedAtom(pattern)
}

/** One atom of a regex at the top level, plus whether a quantifier follows it. */
interface ScannedAtom {
  /** Source text of the atom itself (a char, an escape, or a `[...]` class). */
  source: string
  /** Index in the pattern just past the atom and any quantifier. */
  next: number
  /** True when +, *, or {n,} immediately follows the atom. */
  quantified: boolean
}

/** Read the atom starting at `i` (outside any character class) and its quantifier. */
function scanAtom(pattern: string, i: number): ScannedAtom {
  let source: string
  if (pattern[i] === "\\") {
    source = pattern.slice(i, i + 2)
    i += 2
  } else if (pattern[i] === "[") {
    const start = i
    i++
    while (i < pattern.length && pattern[i] !== "]") {
      if (pattern[i] === "\\") i++
      i++
    }
    i++ // past ']'
    source = pattern.slice(start, i)
  } else {
    source = pattern[i] ?? ""
    i++
  }

  let quantified = false
  const q = pattern[i]
  if (q === "+" || q === "*") {
    quantified = true
    i++
  } else if (q === "{") {
    const close = pattern.indexOf("}", i)
    if (close !== -1) {
      quantified = true
      i = close + 1
    }
  }
  // A lazy/possessive suffix does not change the overlap hazard.
  if (quantified && (pattern[i] === "?" || pattern[i] === "+")) i++
  return { source, next: i, quantified }
}

/**
 * True when the same atom appears quantified in two consecutive positions at
 * the top level, e.g. `a*a*`. Structural characters (`(`, `)`, `|`) reset the
 * run — quantified groups are the concern of {@link hasQuantifiedComplexGroup}.
 */
function hasRepeatedQuantifiedAtom(pattern: string): boolean {
  let prev: { source: string; quantified: boolean } | null = null
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === "(" || ch === ")" || ch === "|") {
      prev = null
      i++
      continue
    }
    const atom = scanAtom(pattern, i)
    if (atom.next <= i) {
      i++ // never stall
      prev = null
      continue
    }
    if (atom.quantified && prev && prev.quantified && prev.source === atom.source) {
      return true
    }
    prev = { source: atom.source, quantified: atom.quantified }
    i = atom.next
  }
  return false
}

/**
 * Compile `pattern` as a case-insensitive global regex, or fall back to an
 * escaped literal search when it is a backtracking hazard or otherwise invalid.
 * The returned `mode` tells the caller which happened.
 */
export function buildSafeRegex(pattern: string, log?: RegexSafetyLogger): { regex: RegExp; mode: "regex" | "literal" } {
  try {
    if (hasQuantifiedComplexGroup(pattern)) throw new Error("ReDoS-suspect pattern")
    return { regex: new RegExp(pattern, "gi"), mode: "regex" }
  } catch (error) {
    log?.debug?.("Falling back to literal search pattern", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { regex: literalRegex(pattern), mode: "literal" }
  }
}
