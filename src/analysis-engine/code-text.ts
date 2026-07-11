/**
 * Heuristic code-only text for STORED source (no AST available): blanks
 * string/template literal contents and comments so pattern scans only see
 * code. Single-pass state machine; quotes are preserved so quote-anchored
 * patterns still work, newlines are preserved so line math stays valid.
 *
 * Handles: '…' "…" `…` with backslash escapes, // line and slash-star block
 * comments (C family), # line comments (python/bash/ruby), and python
 * triple-quoted strings. Not a full lexer — regex literals in JS are left
 * as-is (rare enough to accept), and nested template interpolation keeps its
 * code visible only at the top level. Good enough for pattern precision;
 * the TS adapter uses the exact AST-based variant instead.
 */

const HASH_COMMENT_LANGS = new Set(["python", "bash", "ruby"])

export function stripLiteralsAndComments(text: string, language?: string): string {
  const useHash = language ? HASH_COMMENT_LANGS.has(language) : false
  const useSlash = !useHash || language === undefined
  const chars = text.split("")
  const n = chars.length
  let i = 0

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (chars[k] !== "\n") chars[k] = " "
    }
  }

  while (i < n) {
    const c = chars[i]
    const next = i + 1 < n ? chars[i + 1] : ""

    // Python triple-quoted strings (check before single-quote handling)
    if (useHash && (c === '"' || c === "'") && next === c && (i + 2 < n ? chars[i + 2] : "") === c) {
      const quote = c!
      const start = i + 3
      let j = start
      while (j + 2 < n && !(chars[j] === quote && chars[j + 1] === quote && chars[j + 2] === quote)) j++
      blank(start, j)
      i = Math.min(j + 3, n)
      continue
    }

    // Regular strings
    if (c === '"' || c === "'" || c === "`") {
      const quote = c!
      const start = i + 1
      let j = start
      while (j < n) {
        if (chars[j] === "\\") {
          j += 2
          continue
        }
        if (chars[j] === quote) break
        // ${ … } interpolation inside template literals: stop blanking, let
        // the interpolation code stay visible, resume after it.
        if (quote === "`" && chars[j] === "$" && j + 1 < n && chars[j + 1] === "{") {
          blank(start, j)
          let depth = 1
          let k = j + 2
          while (k < n && depth > 0) {
            if (chars[k] === "{") depth++
            else if (chars[k] === "}") depth--
            k++
          }
          // restart string scan after the interpolation
          i = k
          j = -1
          break
        }
        j++
      }
      if (j === -1) continue // resumed after interpolation
      blank(start, j)
      i = Math.min(j + 1, n)
      continue
    }

    // Comments
    if (useSlash && c === "/" && next === "/") {
      let j = i
      while (j < n && chars[j] !== "\n") j++
      blank(i, j)
      i = j
      continue
    }
    if (useSlash && c === "/" && next === "*") {
      let j = i + 2
      while (j + 1 < n && !(chars[j] === "*" && chars[j + 1] === "/")) j++
      blank(i, Math.min(j + 2, n))
      i = Math.min(j + 2, n)
      continue
    }
    if (useHash && c === "#") {
      let j = i
      while (j < n && chars[j] !== "\n") j++
      blank(i, j)
      i = j
      continue
    }

    i++
  }

  return chars.join("")
}
