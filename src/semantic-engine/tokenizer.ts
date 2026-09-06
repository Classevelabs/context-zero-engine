/**
 * ContextZero — Code-Aware Tokenizer
 *
 * Generates multi-view token streams from code symbols.
 * 5 views: name, body, signature, behavior, contract
 *
 * Unlike NLP tokenizers, this understands code structure:
 * - Splits camelCase/PascalCase/snake_case identifiers
 * - Preserves meaningful operators and keywords
 * - Strips comments, string literals, numeric literals
 * - Stems common programming suffixes (Handler->handle, Service->serve, etc.)
 */

// Common JS/TS keywords and noise words to remove from body tokens
const NOISE_WORDS: Set<string> = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "this",
  "new",
  "true",
  "false",
  "null",
  "undefined",
  "import",
  "export",
  "from",
  "async",
  "await",
  "class",
  "interface",
  "type",
  "extends",
  "implements",
  "void",
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "never",
  "promise",
])

// Programming suffix stemming rules: suffix -> stem
const SUFFIX_STEMS: [string, string][] = [
  ["handler", "handle"],
  ["service", "serve"],
  ["manager", "manage"],
  ["factory", "factor"],
  ["builder", "build"],
  ["provider", "provide"],
  ["controller", "control"],
  ["validator", "valid"],
  ["serializer", "serial"],
  ["repository", "repo"],
  ["middleware", "middle"],
  ["resolver", "resolv"],
  ["adapter", "adapt"],
  ["listener", "listen"],
  ["observer", "observ"],
  ["wrapper", "wrap"],
  ["helper", "help"],
  ["utility", "util"],
]

/** Per-view input/output bounds for attacker-controlled source metadata. */
const MAX_TOKENIZE_LENGTH = 100_000
const MAX_TOKEN_LENGTH = 256
const MAX_TOKENS_PER_VIEW = 25_000

/**
 * Normalize a single token: lowercase, remove trailing digits, apply stemming.
 * Returns empty string for tokens < 2 chars after processing.
 */
export function normalizeToken(token: string): string {
  // Bound pathological identifiers before allocating their lowercase copy.
  let normalized = token.slice(0, MAX_TOKEN_LENGTH).toLowerCase()

  // Remove trailing digits
  normalized = normalized.replace(/\d+$/, "")

  // Apply suffix stemming rules
  for (const [suffix, stem] of SUFFIX_STEMS) {
    if (normalized === suffix) {
      normalized = stem
      break
    }
  }

  // Return empty string if token is too short
  if (normalized.length < 2) {
    return ""
  }

  return normalized
}

/**
 * Split a compound identifier into its component words.
 * Handles camelCase, PascalCase, snake_case, and SCREAMING_SNAKE_CASE.
 */
function splitCompoundName(name: string): string[] {
  // First split on underscores and hyphens
  const parts = name.split(/[_-]+/).filter(Boolean)

  const result: string[] = []
  for (const part of parts) {
    // Split camelCase/PascalCase:
    // Insert split before an uppercase letter that follows a lowercase letter
    // Also split before an uppercase letter followed by a lowercase (for "XMLParser" -> "XML", "Parser")
    const subParts = part
      .replace(/([a-z])([A-Z])/g, "$1\x00$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\x00$2")
      .split("\x00")

    for (const sub of subParts) {
      if (sub.length > 0) {
        result.push(sub)
      }
    }
  }

  return result
}

/**
 * Tokenize a symbol name: split compound names, lowercase, stem suffixes.
 */
export function tokenizeName(name: string): string[] {
  const parts = splitCompoundName(name.slice(0, MAX_TOKENIZE_LENGTH))
  const tokens: string[] = []

  for (const part of parts) {
    const normalized = normalizeToken(part)
    if (normalized !== "") {
      tokens.push(normalized)
      if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
    }
  }

  return tokens
}

/**
 * Tokenize a code body: extract all identifiers, split compound names,
 * remove keywords/noise. Duplicates are preserved for TF-IDF frequency counting;
 * callers that need set semantics (e.g. MinHash) wrap the result in new Set().
 */
/** Max code size for tokenization — beyond this, truncate to prevent CPU spike */
/**
 * Keywords and library nouns that carry no meaning about what a body does,
 * by language. The base set is JavaScript and TypeScript; a language adds its
 * own. These are the language's vocabulary, not a table of expected inputs:
 * `def`, `self` and `None` are in every Python body, `func`, `nil` and `err`
 * in every Go body, and a search for "what does this do" gains nothing from
 * matching them. Before this, Python and Go bodies were tokenized with the
 * JavaScript list alone, so their most common tokens were their keywords.
 */
const LANGUAGE_NOISE: Record<string, readonly string[]> = {
  python: ["def", "self", "cls", "none", "elif", "lambda", "pass", "yield", "with", "as", "not", "and", "or", "is", "in", "del", "global", "nonlocal", "raise", "except", "try", "finally", "assert", "print", "str", "int", "dict", "list", "tuple", "set", "bool", "float", "bytes", "object", "len", "range", "isinstance", "super", "kwargs", "args"],
  go: ["func", "nil", "package", "defer", "go", "chan", "range", "struct", "map", "err", "error", "int", "int64", "int32", "uint", "bool", "byte", "fmt", "len", "append", "make", "ctx", "context", "errors", "errorf", "sprintf"],
  rust: ["fn", "pub", "let", "mut", "impl", "struct", "enum", "trait", "use", "mod", "crate", "self", "match", "ref", "dyn", "where", "some", "none", "ok", "err", "vec", "box", "str", "u8", "u16", "u32", "u64", "i32", "i64", "usize", "bool", "result", "option", "unwrap", "clone", "into", "iter", "as", "loop", "unsafe"],
  java: ["public", "private", "protected", "static", "final", "int", "long", "double", "float", "char", "byte", "short", "object", "override", "throws", "throw", "catch", "try", "finally", "instanceof", "package", "abstract", "synchronized", "list", "map", "set", "integer"],
  kotlin: ["fun", "val", "var", "override", "private", "public", "internal", "protected", "object", "companion", "data", "when", "is", "as", "in", "int", "long", "unit", "list", "map", "set", "lateinit", "suspend"],
  csharp: ["public", "private", "protected", "internal", "static", "readonly", "override", "virtual", "namespace", "using", "int", "long", "double", "object", "var", "get", "set", "async", "await", "task", "list", "dictionary", "foreach", "is", "as", "throw", "catch", "try", "finally"],
  ruby: ["def", "end", "nil", "self", "do", "module", "require", "attr", "accessor", "reader", "writer", "unless", "elsif", "puts", "raise", "rescue", "ensure", "yield", "block", "each", "hash", "array"],
  php: ["function", "echo", "namespace", "use", "public", "private", "protected", "static", "array", "isset", "unset", "empty", "foreach", "as", "self", "parent", "throw", "catch", "try", "finally", "instanceof", "int", "bool", "mixed", "void"],
  c: ["int", "char", "long", "short", "double", "float", "unsigned", "signed", "struct", "typedef", "sizeof", "static", "extern", "include", "define", "ifdef", "endif", "goto", "malloc", "free", "printf", "size", "len", "buf", "ptr"],
  cpp: ["int", "char", "long", "short", "double", "float", "unsigned", "signed", "struct", "typedef", "sizeof", "static", "extern", "include", "define", "ifdef", "endif", "nullptr", "std", "template", "typename", "namespace", "using", "auto", "virtual", "override", "public", "private", "protected", "size", "len", "ptr"],
  swift: ["func", "let", "var", "guard", "nil", "self", "struct", "enum", "protocol", "extension", "override", "private", "public", "internal", "fileprivate", "throws", "throw", "try", "catch", "some", "any", "int", "string", "bool", "double"],
  bash: ["echo", "local", "then", "elif", "fi", "done", "esac", "exit", "shift", "eval", "printf", "test"],
}
const noiseCache = new Map<string, Set<string>>()
function noiseFor(language: string | undefined): Set<string> {
  const key = language ?? "typescript"
  const cached = noiseCache.get(key)
  if (cached) return cached
  const merged = new Set(NOISE_WORDS)
  for (const word of LANGUAGE_NOISE[key] ?? []) merged.add(word)
  noiseCache.set(key, merged)
  return merged
}

/** Languages whose comments are `#` lines; everything else is C-style. */
const HASH_COMMENT_LANGUAGES = new Set(["python", "ruby", "bash", "sh", "shell"])

/**
 * Remove comments the way the language writes them. C-style stripping alone
 * left every `#` comment and every docstring in Python, Ruby and shell bodies
 * as code, so the prose in a docstring was tokenized as if it were identifiers.
 */
function stripComments(input: string, language: string | undefined): string {
  let out = input
  if (language === "python") {
    out = out.replace(/"""[\s\S]*?"""/g, "").replace(/'''[\s\S]*?'''/g, "")
  }
  if (language && HASH_COMMENT_LANGUAGES.has(language)) {
    out = out.replace(/#.*$/gm, "")
    if (language === "ruby") out = out.replace(/^=begin[\s\S]*?^=end/gm, "")
    return out
  }
  out = out.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  if (language === "php") out = out.replace(/#.*$/gm, "")
  return out
}

export function tokenizeBody(code: string, language?: string): string[] {
  // Truncate extremely large bodies to prevent regex backtracking / CPU spike.
  // 100K chars covers ~2500 lines — sufficient for TF-IDF token extraction.
  const input = code.length > MAX_TOKENIZE_LENGTH ? code.slice(0, MAX_TOKENIZE_LENGTH) : code

  let stripped = stripComments(input, language)
  const noise = noiseFor(language)

  // Strip string literals (single-quoted, double-quoted, backtick)
  stripped = stripped.replace(/'(?:[^'\\]|\\.)*'/g, "")
  stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, "")
  stripped = stripped.replace(/`(?:[^`\\]|\\.)*`/g, "")

  // Strip numeric literals (decimal, hex 0x, binary 0b, octal 0o, scientific notation)
  stripped = stripped.replace(/\b0[xX][0-9a-fA-F]+\b/g, "")
  stripped = stripped.replace(/\b0[bB][01]+\b/g, "")
  stripped = stripped.replace(/\b0[oO][0-7]+\b/g, "")
  stripped = stripped.replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "")

  // Extract all identifiers
  const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g
  const rawIdentifiers: string[] = []
  let match: RegExpExecArray | null

  while ((match = identifierRegex.exec(stripped)) !== null) {
    rawIdentifiers.push(match[0])
  }

  // Split compound names, normalize, remove noise
  const tokens: string[] = []

  for (const ident of rawIdentifiers) {
    const parts = splitCompoundName(ident)
    for (const part of parts) {
      const normalized = normalizeToken(part)
      if (normalized !== "" && !noise.has(normalized)) {
        tokens.push(normalized)
        if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
      }
    }
  }

  return tokens
}

/**
 * Tokenize a function/method signature: extract parameter names, type names,
 * return type. Split compounds, remove noise. Duplicates preserved for TF-IDF.
 */
export function tokenizeSignature(signature: string): string[] {
  const input = signature.slice(0, MAX_TOKENIZE_LENGTH)
  // Extract all identifiers from the signature
  const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g
  const rawIdentifiers: string[] = []
  let match: RegExpExecArray | null

  while ((match = identifierRegex.exec(input)) !== null) {
    rawIdentifiers.push(match[0])
  }

  // Split compound names, normalize, remove noise
  const tokens: string[] = []

  for (const ident of rawIdentifiers) {
    const parts = splitCompoundName(ident)
    for (const part of parts) {
      const normalized = normalizeToken(part)
      if (normalized !== "" && !NOISE_WORDS.has(normalized)) {
        tokens.push(normalized)
        if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
      }
    }
  }

  return tokens
}

/**
 * Tokenize behavioral hints: convert each hint_type + detail into tokens.
 * Duplicates preserved for TF-IDF frequency counting.
 */
export function tokenizeBehavior(hints: { hint_type: string; detail: string }[]): string[] {
  const tokens: string[] = []

  for (const hint of hints.slice(0, 1_000)) {
    // Tokenize the hint_type (e.g., "db_read" -> ["db", "read"])
    const typeParts = splitCompoundName(hint.hint_type.slice(0, MAX_TOKENIZE_LENGTH))
    for (const part of typeParts) {
      const normalized = normalizeToken(part)
      if (normalized !== "") {
        tokens.push(normalized)
        if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
      }
    }

    // Tokenize the detail string
    const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g
    let match: RegExpExecArray | null

    const detail = hint.detail.slice(0, MAX_TOKENIZE_LENGTH)
    while ((match = identifierRegex.exec(detail)) !== null) {
      const detailParts = splitCompoundName(match[0])
      for (const part of detailParts) {
        const normalized = normalizeToken(part)
        if (normalized !== "" && !NOISE_WORDS.has(normalized)) {
          tokens.push(normalized)
          if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
        }
      }
    }
  }

  return tokens
}

/**
 * Tokenize a contract hint: extract type names from input/output/thrown types
 * and decorators, split compounds.
 */
export function tokenizeContract(hint: {
  input_types: string[]
  output_type: string
  thrown_types: string[]
  decorators: string[]
}): string[] {
  const tokens: string[] = []

  const allTypeStrings = [
    ...hint.input_types.slice(0, 1_000),
    hint.output_type,
    ...hint.thrown_types.slice(0, 1_000),
    ...hint.decorators.slice(0, 1_000),
  ]

  for (const typeStr of allTypeStrings) {
    // Extract identifiers from type expressions (handles generics like Promise<User[]>)
    const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g
    let match: RegExpExecArray | null

    const input = typeStr.slice(0, MAX_TOKENIZE_LENGTH)
    while ((match = identifierRegex.exec(input)) !== null) {
      const parts = splitCompoundName(match[0])
      for (const part of parts) {
        const normalized = normalizeToken(part)
        if (normalized !== "" && !NOISE_WORDS.has(normalized)) {
          tokens.push(normalized)
          if (tokens.length >= MAX_TOKENS_PER_VIEW) return tokens
        }
      }
    }
  }

  return tokens
}
