/**
 * ContextZero — TypeScript Language Adapter
 *
 * Symbol extraction using the TypeScript Compiler API.
 * Extracts symbols, relations, behavior hints, and contract hints
 * from source code.
 *
 * Uses:
 * - ts.createProgram for project-level type resolution
 * - ts.TypeChecker for type information extraction
 * - AST walking for symbol boundary detection
 * - 30+ regex patterns for behavioral side-effect detection
 * - SHA-256 hashing for AST and body fingerprints
 */

import * as ts from "typescript"
import * as crypto from "crypto"
import * as path from "path"
import { Logger } from "../../logger"
import type {
  AdapterExtractionResult,
  ExtractedSymbol,
  ExtractedRelation,
  BehaviorHint,
  ContractHint,
} from "../../types"
import { normalizeForComparison } from "./ast-normalizer"
import { resolveEffectHints } from "./effect-resolver"

const log = new Logger("ts-adapter")

/**
 * Syntactic side-effect patterns for behavioral hints.
 *
 * SCOPE CHANGE (v2.5): external-effect categories — db_read, db_write,
 * network_call, file_io, cache_op — are now produced by the TYPE-RESOLVED
 * analyzer (./effect-resolver), which follows each call's receiver back to
 * its source module through the checker. Pattern guesses for those
 * categories were the false-positive factory (`.request(` on any object,
 * `WebSocket` in a type position, "stripe" in a string) and are gone.
 * Patterns below only cover LOCAL/SYNTACTIC categories the resolver can't
 * see: throws/catches, state mutation, locking, serialization, validation,
 * auth idioms, `.transaction(` and logging.
 */
const BEHAVIOR_PATTERNS: { pattern: RegExp; hint_type: BehaviorHint["hint_type"]; detail: string }[] = [
  // Auth
  { pattern: /\.authenticate\s*\(/, hint_type: "auth_check", detail: "authenticate" },
  { pattern: /\.authorize\s*\(/, hint_type: "auth_check", detail: "authorize" },
  { pattern: /verify(Token|JWT|Session)/, hint_type: "auth_check", detail: "token_verify" },
  { pattern: /\.isAuthenticated/, hint_type: "auth_check", detail: "auth_check" },
  // Validation
  { pattern: /\.validate\s*\(/, hint_type: "validation", detail: "validate" },
  { pattern: /Joi\.|Yup\.|Zod\./, hint_type: "validation", detail: "schema_validation" },
  // Exception handling
  { pattern: /throw\s+new\s+\w+/, hint_type: "throws", detail: "throws" },
  { pattern: /catch\s*\(/, hint_type: "catches", detail: "catches" },
  // State mutation
  { pattern: /this\.\w+\s*=/, hint_type: "state_mutation", detail: "this_assignment" },
  { pattern: /\.setState\s*\(/, hint_type: "state_mutation", detail: "set_state" },
  // Transactions
  { pattern: /\.transaction\s*\(/, hint_type: "transaction", detail: "db_transaction" },
  { pattern: /BEGIN|COMMIT|ROLLBACK/, hint_type: "transaction", detail: "sql_transaction" },
  // Lock acquisition
  { pattern: /\.(lock|acquire|tryLock)\s*\(/, hint_type: "acquires_lock", detail: "lock_acquire" },
  { pattern: /[Mm]utex/, hint_type: "acquires_lock", detail: "mutex" },
  { pattern: /[Ss]emaphore/, hint_type: "acquires_lock", detail: "semaphore" },
  { pattern: /synchronized/, hint_type: "acquires_lock", detail: "synchronized" },
  // Serialization
  { pattern: /JSON\.stringify/, hint_type: "serialization", detail: "json_stringify" },
  { pattern: /\.(serialize|marshal)\s*\(/, hint_type: "serialization", detail: "serialize" },
  { pattern: /\.toJSON\s*\(/, hint_type: "serialization", detail: "to_json" },
  { pattern: /protobuf/, hint_type: "serialization", detail: "protobuf" },
  { pattern: /\.encode\s*\(/, hint_type: "serialization", detail: "encode" },
  // Logging (informational only)
  { pattern: /console\.(log|warn|error|info)/, hint_type: "logging", detail: "console" },
  { pattern: /log\.(debug|info|warn|error|fatal)/, hint_type: "logging", detail: "structured_log" },
]

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}

function getVisibility(node: ts.Node): string {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  if (mods) {
    for (const mod of mods) {
      if (mod.kind === ts.SyntaxKind.PrivateKeyword) return "private"
      if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return "protected"
    }
  }
  // Check for export keyword
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return "public"
  return "internal"
}

function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile)
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile, checker: ts.TypeChecker): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const name = node.name?.getText(sourceFile) || "anonymous"
    const params = node.parameters
      .map((p) => {
        const pName = p.name.getText(sourceFile)
        const pType = p.type ? p.type.getText(sourceFile) : checker.typeToString(checker.getTypeAtLocation(p))
        return `${pName}: ${pType}`
      })
      .join(", ")
    const sig = checker.getSignatureFromDeclaration(node)
    const returnType = node.type
      ? node.type.getText(sourceFile)
      : sig
        ? checker.typeToString(checker.getReturnTypeOfSignature(sig))
        : "unknown"
    return `${name}(${params}): ${returnType}`
  }
  if (ts.isClassDeclaration(node)) {
    return `class ${node.name?.getText(sourceFile) || "anonymous"}`
  }
  if (ts.isInterfaceDeclaration(node)) {
    return `interface ${node.name.getText(sourceFile)}`
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return `type ${node.name.getText(sourceFile)}`
  }
  if (ts.isEnumDeclaration(node)) {
    return `enum ${node.name.getText(sourceFile)}`
  }
  if (ts.isVariableDeclaration(node)) {
    return node.name.getText(sourceFile)
  }
  return node.getText(sourceFile).substring(0, 100)
}

function classifyKind(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isClassDeclaration(node)) return "class"
  if (ts.isInterfaceDeclaration(node)) return "interface"
  if (ts.isTypeAliasDeclaration(node)) return "type_alias"
  if (ts.isEnumDeclaration(node)) return "enum"
  if (ts.isMethodDeclaration(node)) return "method"
  if (ts.isFunctionDeclaration(node)) {
    const text = node.getText(sourceFile)
    if (/router\.(get|post|put|delete|patch)|app\.(get|post|put|delete|patch)/.test(text)) {
      return "route_handler"
    }
    return "function"
  }
  if (ts.isVariableDeclaration(node)) return "variable"
  return "function"
}

/** Maximum files per TypeScript compiler batch to prevent OOM in large monorepos */
const BATCH_SIZE = 500

/**
 * Extract all symbols, relations, behavior hints, and contract hints
 * from a set of TypeScript files.
 *
 * For repos with more than BATCH_SIZE files, processes files in batches
 * using a shared CompilerHost so cross-file type resolution still works
 * (the host caches parsed source files between batches).
 */
export async function extractFromTypeScript(
  filePaths: string[],
  tsconfigPath?: string,
): Promise<AdapterExtractionResult> {
  const timer = log.startTimer("extractFromTypeScript", { fileCount: filePaths.length })
  const uncertaintyFlags: string[] = []

  // Load compiler options
  let compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    esModuleInterop: true,
    noEmit: true,
  }

  if (tsconfigPath) {
    // A malformed/unresolvable tsconfig (bad `extends`, JSON5 quirks) must not
    // take down extraction for the whole repo — fall back to default options.
    try {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath))
        compilerOptions = parsed.options
      } else {
        uncertaintyFlags.push("incomplete_type_info")
        log.warn("Failed to read tsconfig", { path: tsconfigPath })
      }
    } catch (err) {
      uncertaintyFlags.push("incomplete_type_info")
      log.warn("tsconfig parse threw — using default compiler options", {
        path: tsconfigPath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const symbols: ExtractedSymbol[] = []
  const relations: ExtractedRelation[] = []
  const behaviorHints: BehaviorHint[] = []
  const contractHints: ContractHint[] = []
  const failedFiles: string[] = []

  // Yield to the event loop so a long extraction doesn't freeze the MCP/HTTP
  // server (a blocked loop stalls health checks and can get the host to kill us).
  const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  const YIELD_EVERY_FILES = 25

  /** Extract every file of a program, isolating per-file visitor crashes. */
  const extractProgramFiles = async (paths: string[], program: ts.Program, checker: ts.TypeChecker): Promise<void> => {
    let sinceYield = 0
    for (const filePath of paths) {
      const sourceFile = program.getSourceFile(filePath)
      if (!sourceFile) {
        uncertaintyFlags.push("parse_error")
        failedFiles.push(filePath)
        log.warn("Source file not found in program", { filePath })
        continue
      }
      try {
        extractFromSourceFile(
          sourceFile,
          checker,
          filePath,
          symbols,
          relations,
          behaviorHints,
          contractHints,
          uncertaintyFlags,
        )
      } catch (err) {
        uncertaintyFlags.push("parse_error")
        failedFiles.push(filePath)
        log.warn("Per-file extraction failed", {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (++sinceYield >= YIELD_EVERY_FILES) {
        sinceYield = 0
        await yieldLoop()
      }
    }
  }

  /**
   * Last-resort isolation: when a whole program/batch fails to construct,
   * retry each file as its own single-file program so one poison file (or a
   * transient resource failure) costs one file, not the entire repository.
   */
  const extractPerFileFallback = async (paths: string[], options: ts.CompilerOptions = compilerOptions): Promise<void> => {
    for (const filePath of paths) {
      try {
        const program = ts.createProgram([filePath], options)
        await extractProgramFiles([filePath], program, program.getTypeChecker())
      } catch (err) {
        uncertaintyFlags.push("parse_error")
        failedFiles.push(filePath)
        log.warn("Single-file fallback extraction failed", {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      await yieldLoop()
    }
  }

  if (filePaths.length <= BATCH_SIZE) {
    // Small repo: single-program approach (no overhead)
    try {
      const program = ts.createProgram(filePaths, compilerOptions)
      await extractProgramFiles(filePaths, program, program.getTypeChecker())
    } catch (err) {
      log.error(
        "Program-level extraction failed — retrying per file",
        err instanceof Error ? err : new Error(String(err)),
      )
      await extractPerFileFallback(filePaths)
    }
  } else {
    // Large monorepo: batched extraction with shared CompilerHost
    // The shared host caches parsed files so cross-file type resolution
    // still works across batches while avoiding holding all ASTs in memory.
    const host = ts.createCompilerHost(compilerOptions)
    const totalBatches = Math.ceil(filePaths.length / BATCH_SIZE)
    log.info("Batched extraction enabled", { files: filePaths.length, batchSize: BATCH_SIZE, totalBatches })

    for (let batchIdx = 0; batchIdx < filePaths.length; batchIdx += BATCH_SIZE) {
      const batch = filePaths.slice(batchIdx, batchIdx + BATCH_SIZE)
      const batchNum = Math.floor(batchIdx / BATCH_SIZE) + 1
      log.debug("Processing batch", { batch: batchNum, totalBatches, files: batch.length })

      try {
        const program = ts.createProgram(batch, compilerOptions, host)
        await extractProgramFiles(batch, program, program.getTypeChecker())
      } catch (err) {
        log.error(
          `Batch ${batchNum}/${totalBatches} extraction failed — retrying batch per file`,
          err instanceof Error ? err : new Error(String(err)),
        )
        await extractPerFileFallback(batch)
      }
      await yieldLoop()
    }
  }

  // JS retry: repos whose tsconfig lacks allowJs get their .js/.mjs files
  // refused by the program ("source file not found"). Those aren't broken
  // files — re-extract each with allowJs forced so scripts still index.
  const jsRefused = failedFiles.filter((f) => /\.(m|c)?jsx?$/i.test(f))
  if (jsRefused.length > 0 && compilerOptions.allowJs !== true) {
    for (const f of jsRefused) {
      const idx = failedFiles.indexOf(f)
      if (idx >= 0) failedFiles.splice(idx, 1)
    }
    log.info("Retrying JS files with allowJs forced", { count: jsRefused.length })
    await extractPerFileFallback(jsRefused, { ...compilerOptions, allowJs: true, checkJs: false })
  }

  timer({
    symbols: symbols.length,
    relations: relations.length,
    behavior_hints: behaviorHints.length,
    contract_hints: contractHints.length,
    failed_files: failedFiles.length,
  })

  return {
    symbols,
    relations,
    behavior_hints: behaviorHints,
    contract_hints: contractHints,
    parse_confidence: uncertaintyFlags.length === 0 ? 1.0 : Math.max(0.5, 1.0 - uncertaintyFlags.length * 0.1),
    uncertainty_flags: [...new Set(uncertaintyFlags)],
    failed_files: failedFiles,
  }
}

function extractFromSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
  symbols: ExtractedSymbol[],
  relations: ExtractedRelation[],
  behaviorHints: BehaviorHint[],
  contractHints: ContractHint[],
  uncertaintyFlags: string[],
): void {
  const relativePath = filePath

  function visit(node: ts.Node, parentKey?: string): void {
    // Extract top-level and class-member declarations
    const isTopLevelVariableStatement = ts.isVariableStatement(node) && ts.isSourceFile(node.parent)
    const isExtractable =
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      (isTopLevelVariableStatement && node.declarationList.declarations.length > 0)

    if (isExtractable) {
      let name: string | undefined
      const targetNode: ts.Node = node

      // For variable statements, iterate ALL declarations (not just the first)
      if (isTopLevelVariableStatement) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            uncertaintyFlags.push("destructuring_binding_skipped")
            continue
          }
          const declName = decl.name.text
          if (!declName) continue

          const declStableKey = parentKey ? `${relativePath}#${parentKey}.${declName}` : `${relativePath}#${declName}`

          const declFullText = getNodeText(decl, sourceFile)
          const { line: declStartLine, character: declStartCol } = sourceFile.getLineAndCharacterOfPosition(
            decl.getStart(sourceFile),
          )
          const { line: declEndLine, character: declEndCol } = sourceFile.getLineAndCharacterOfPosition(decl.getEnd())

          let declSig = ""
          try {
            declSig = getSignature(decl, sourceFile, checker)
          } catch {
            declSig = declName
            uncertaintyFlags.push("type_inference_failure")
          }

          const declBodyText = declFullText.includes("{")
            ? declFullText.substring(declFullText.indexOf("{"))
            : declFullText

          let declNormalizedAstHash: string | undefined
          try {
            declNormalizedAstHash = normalizeForComparison(declBodyText)
          } catch {
            uncertaintyFlags.push("normalization_failure")
          }

          symbols.push({
            stable_key: declStableKey,
            canonical_name: declName,
            kind: classifyKind(node, sourceFile),
            range_start_line: declStartLine + 1,
            range_start_col: declStartCol + 1,
            range_end_line: declEndLine + 1,
            range_end_col: declEndCol + 1,
            signature: declSig,
            ast_hash: sha256(declFullText),
            body_hash: sha256(declBodyText),
            normalized_ast_hash: declNormalizedAstHash,
            visibility: getVisibility(node),
          })

          // `const f = async () => { ... }` bodies used to get NO behavior
          // hints at all — arrow-declared functions are the dominant style in
          // modern TS, so that hole hid most real effects. Same hint pipeline
          // as declared functions: syntactic patterns + type-resolved effects.
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            extractBehaviorHints(
              codeOnlyScanText(decl.initializer, sourceFile),
              declStableKey,
              declStartLine + 1,
              behaviorHints,
            )
            for (const resolved of resolveEffectHints(decl.initializer, sourceFile, checker)) {
              behaviorHints.push({
                symbol_key: declStableKey,
                hint_type: resolved.hint_type,
                detail: resolved.detail,
                line: resolved.line,
              })
            }
          }
        }
      } else if ("name" in node && node.name) {
        name = (node.name as ts.Identifier).getText(sourceFile)
      }

      if (!ts.isVariableStatement(node) && name) {
        const stableKey = parentKey ? `${relativePath}#${parentKey}.${name}` : `${relativePath}#${name}`

        const fullText = getNodeText(node, sourceFile)
        const { line: startLine, character: startCol } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        )
        const { line: endLine, character: endCol } = sourceFile.getLineAndCharacterOfPosition(node.getEnd())

        let sig = ""
        try {
          sig = getSignature(targetNode, sourceFile, checker)
        } catch {
          sig = name
          uncertaintyFlags.push("type_inference_failure")
        }

        // Body text = full text minus the first line (signature)
        const bodyText = fullText.includes("{") ? fullText.substring(fullText.indexOf("{")) : fullText

        // Compute normalized AST hash for structural similarity detection
        let normalizedAstHash: string | undefined
        try {
          normalizedAstHash = normalizeForComparison(bodyText)
        } catch {
          // Fall back gracefully if normalization fails
          uncertaintyFlags.push("normalization_failure")
        }

        symbols.push({
          stable_key: stableKey,
          canonical_name: name,
          kind: classifyKind(node, sourceFile),
          range_start_line: startLine + 1,
          range_start_col: startCol + 1,
          range_end_line: endLine + 1,
          range_end_col: endCol + 1,
          signature: sig,
          ast_hash: sha256(fullText),
          body_hash: sha256(bodyText),
          normalized_ast_hash: normalizedAstHash,
          visibility: getVisibility(node),
        })

        // Extract behavior hints from function/method bodies.
        // External-effect categories come from the TYPE-RESOLVED analyzer;
        // syntactic patterns (on code-only text) fill the local categories.
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
          extractBehaviorHints(codeOnlyScanText(node, sourceFile), stableKey, startLine + 1, behaviorHints)
          for (const resolved of resolveEffectHints(node, sourceFile, checker)) {
            behaviorHints.push({
              symbol_key: stableKey,
              hint_type: resolved.hint_type,
              detail: resolved.detail,
              line: resolved.line,
            })
          }
          extractContractHint(node, sourceFile, checker, stableKey, contractHints, uncertaintyFlags)
        }

        // Extract relations from function/method bodies
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
          extractRelationsFromBody(node, sourceFile, checker, stableKey, relations)
        }

        // Recurse into class body for methods
        if (ts.isClassDeclaration(node)) {
          node.members.forEach((member) => visit(member, name))
          // Extract implements/extends relations
          if (node.heritageClauses) {
            for (const clause of node.heritageClauses) {
              const relType = clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "inherits"
              for (const type of clause.types) {
                relations.push({
                  source_key: stableKey,
                  target_name: type.expression.getText(sourceFile),
                  relation_type: relType as ExtractedRelation["relation_type"],
                })
              }
            }
          }
          return // Don't recurse again
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, parentKey))
  }

  visit(sourceFile)
}

/**
 * Render a node's text with string/template/regex literal CONTENTS and comments
 * blanked out (quotes and newlines preserved, so line numbers and quote-anchored
 * patterns like `.query(\s*"` still work). Behavioral patterns must only fire on
 * code — matching inside literals is how the engine's own pattern table ended up
 * "calling Stripe" in its effect signature.
 *
 * Blanking literals FIRST (via AST, precise) makes the comment regexes safe:
 * any remaining `//` or `/*` can no longer be inside a string.
 */
function codeOnlyScanText(node: ts.Node, sourceFile: ts.SourceFile): string {
  const start = node.getStart(sourceFile)
  const chars = sourceFile.getFullText().slice(start, node.getEnd()).split("")
  const blank = (from: number, to: number): void => {
    for (let i = Math.max(from - start, 0); i < Math.min(to - start, chars.length); i++) {
      if (chars[i] !== "\n") chars[i] = " "
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isRegularExpressionLiteral(n)) {
      blank(n.getStart(sourceFile) + 1, n.getEnd() - 1)
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n)) {
      blank(n.getStart(sourceFile) + 1, n.getEnd() - 2)
    } else if (ts.isTemplateTail(n)) {
      blank(n.getStart(sourceFile) + 1, n.getEnd() - 1)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return chars
    .join("")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
}

function extractBehaviorHints(text: string, symbolKey: string, baseLine: number, hints: BehaviorHint[]): void {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const bp of BEHAVIOR_PATTERNS) {
      if (bp.pattern.test(line)) {
        hints.push({
          symbol_key: symbolKey,
          hint_type: bp.hint_type,
          detail: bp.detail,
          line: baseLine + i,
        })
      }
    }
  }
}

function extractContractHint(
  node: ts.FunctionDeclaration | ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  symbolKey: string,
  hints: ContractHint[],
  uncertaintyFlags: string[],
): void {
  try {
    const inputTypes = node.parameters.map((p) => {
      if (p.type) return p.type.getText(sourceFile)
      return checker.typeToString(checker.getTypeAtLocation(p))
    })

    let outputType = "void"
    if (node.type) {
      outputType = node.type.getText(sourceFile)
    } else {
      const sig = checker.getSignatureFromDeclaration(node)
      if (sig) {
        outputType = checker.typeToString(checker.getReturnTypeOfSignature(sig))
      }
    }

    // Extract thrown types from body
    const thrownTypes: string[] = []
    const text = node.getText(sourceFile)
    const throwMatches = text.matchAll(/throw\s+new\s+(\w+)/g)
    for (const match of throwMatches) {
      if (match[1]) thrownTypes.push(match[1])
    }

    // Extract decorators
    const decorators: string[] = []
    const mods = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined
    if (mods) {
      for (const dec of mods) {
        decorators.push(dec.getText(sourceFile))
      }
    }

    hints.push({
      symbol_key: symbolKey,
      input_types: inputTypes,
      output_type: outputType,
      thrown_types: [...new Set(thrownTypes)],
      decorators,
    })
  } catch {
    uncertaintyFlags.push("type_inference_failure")
  }
}

function extractRelationsFromBody(
  node: ts.FunctionDeclaration | ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  sourceKey: string,
  relations: ExtractedRelation[],
): void {
  /** Extract full dotted chain from a property access expression (e.g. this.service.repo.find → "this.service.repo.find") */
  function extractFullChain(expr: ts.Expression): string {
    if (ts.isIdentifier(expr)) {
      return expr.getText(sourceFile)
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const base = extractFullChain(expr.expression)
      const member = expr.name.getText(sourceFile)
      return base ? `${base}.${member}` : member
    }
    if (ts.isElementAccessExpression(expr)) {
      const base = extractFullChain(expr.expression)
      return base ? `${base}.[dynamic]` : "[dynamic]"
    }
    return expr.getText(sourceFile)
  }

  /**
   * The declaration a call actually reaches, as a `<file>#<name>` key.
   *
   * This is the difference between knowing that something named `query` was
   * called and knowing WHICH `query`. The checker follows the receiver's type
   * and any import alias to the declaration itself, so `db.query(...)` resolves
   * to the method on that class rather than to whichever symbol named `query`
   * happened to be indexed last. Returns undefined for calls that leave the
   * program — node built-ins, untyped dynamic dispatch — where there is no
   * declaration in this repository to point at.
   */
  function resolveDeclarationKey(expr: ts.Expression): string | undefined {
    try {
      let symbol = checker.getSymbolAtLocation(expr)
      if (!symbol) return undefined
      if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
          symbol = checker.getAliasedSymbol(symbol)
        } catch {
          /* not an alias after all */
        }
      }
      const declaration = symbol.declarations?.[0]
      if (!declaration) return undefined
      const declFile = declaration.getSourceFile()
      // Anything inside node_modules or a .d.ts is outside the indexed corpus;
      // emitting a key for it would only produce targets that never resolve.
      if (declFile.isDeclarationFile || declFile.fileName.includes("node_modules")) return undefined
      const name = symbol.getName()
      if (!name || name === "__type" || name === "default") return undefined
      return `${declFile.fileName}#${name}`
    } catch {
      return undefined
    }
  }

  function walkBody(child: ts.Node): void {
    // Detect call expressions
    if (ts.isCallExpression(child)) {
      let targetName: string | undefined
      let fullChain: string | undefined
      let targetKey: string | undefined

      if (ts.isIdentifier(child.expression)) {
        targetName = child.expression.getText(sourceFile)
        targetKey = resolveDeclarationKey(child.expression)
      } else if (ts.isPropertyAccessExpression(child.expression)) {
        // Extract FULL chain (e.g. this.service.repo.find)
        fullChain = extractFullChain(child.expression)
        // Also extract just the method name for backward compatibility
        targetName = child.expression.name.getText(sourceFile)
        // Resolve against the property itself, not the receiver: `a.b.find`
        // must reach the declaration of `find`, not of `a`.
        targetKey = resolveDeclarationKey(child.expression.name)
      }

      // Emit full chain relation (primary — enables dispatch resolution)
      if (fullChain) {
        relations.push({
          source_key: sourceKey,
          target_name: fullChain,
          ...(targetKey ? { target_key: targetKey } : {}),
          relation_type: "calls",
        })
        // Also emit bare method name (enables matching without type inference)
        if (targetName && targetName !== fullChain) {
          relations.push({
            source_key: sourceKey,
            target_name: targetName,
            ...(targetKey ? { target_key: targetKey } : {}),
            relation_type: "calls",
          })
        }
      } else if (targetName) {
        relations.push({
          source_key: sourceKey,
          target_name: targetName,
          ...(targetKey ? { target_key: targetKey } : {}),
          relation_type: "calls",
        })
      }
    }

    // Rendering a component invokes it. `<Header />` is a call to `Header` in
    // every sense that matters here — it runs the function, its props are the
    // arguments, and changing the component's contract breaks the call site —
    // but it is a JsxElement rather than a CallExpression, so a walker looking
    // only for calls records nothing. In a codebase with a UI that silently
    // erases the entire component graph: every component reads as uncalled, and
    // "what breaks if I change this?" answers nothing for the half of the
    // repository a user actually sees.
    if (ts.isJsxSelfClosingElement(child) || ts.isJsxOpeningElement(child)) {
      const tag = child.tagName
      const tagText = tag.getText(sourceFile)
      // Lowercase tags are intrinsic elements (`div`, `span`) — HTML, not a
      // symbol declared anywhere in this repository.
      if (tagText && /^[A-Z]/.test(tagText)) {
        // A tag name may also be a namespaced name (`<svg:rect/>`), which is not
        // an expression and has no declaration to resolve.
        const resolvable = ts.isPropertyAccessExpression(tag) ? tag.name : ts.isIdentifier(tag) ? tag : undefined
        const jsxKey = resolvable ? resolveDeclarationKey(resolvable) : undefined
        relations.push({
          source_key: sourceKey,
          target_name: tagText,
          ...(jsxKey ? { target_key: jsxKey } : {}),
          relation_type: "calls",
        })
      }
    }

    // Detect type references
    if (ts.isTypeReferenceNode(child)) {
      const typeName = child.typeName.getText(sourceFile)
      const typeKey = resolveDeclarationKey(
        ts.isQualifiedName(child.typeName) ? child.typeName.right : child.typeName,
      )
      relations.push({
        source_key: sourceKey,
        target_name: typeName,
        ...(typeKey ? { target_key: typeKey } : {}),
        relation_type: "typed_as",
      })
    }

    ts.forEachChild(child, walkBody)
  }

  if (node.body) {
    ts.forEachChild(node.body, walkBody)
  }
}
