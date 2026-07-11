/**
 * Type-resolved effect analysis for TypeScript/JavaScript.
 *
 * Instead of guessing effects from text patterns, resolve every call's callee
 * through the TypeScript checker back to the MODULE it comes from (node:fs,
 * pg, axios, ...) and classify the effect from a curated module map. A call
 * is only tagged as an external effect when its receiver provably originates
 * from an effectful module or a known effectful global (fetch, WebSocket).
 *
 * Why: pattern matching over source text cannot tell `pool.query(...)` from
 * `zodSchema.query(...)`, or a real Stripe call from the word "stripe" in a
 * pattern table. Import resolution can.
 *
 * Coverage notes (measured by scripts/effect-eval.ts, reported in
 * BENCHMARKS.md):
 *  - Calls on values whose origin the checker cannot see (untyped `any`
 *    receivers, dependency-injected clients without type annotations) are NOT
 *    tagged here. That recall loss is deliberate — the adapter's syntactic
 *    heuristics remain for local categories, and the eval quantifies the
 *    trade-off instead of hand-waving it.
 *  - The module map is exact-match on normalized specifiers (node: prefix and
 *    subpaths stripped), so "fs/promises" classifies as "fs" and a package
 *    that merely CONTAINS a known name (e.g. "not-axios") does not match.
 */

import * as ts from "typescript"
import * as path from "path"
import type { BehaviorHint } from "../../types"

type HintType = BehaviorHint["hint_type"]

/** How a module's member calls should be classified. */
interface ModuleEffect {
  /** Direct classification, or a dynamic refiner for db/file modules. */
  classify: HintType | "db_dynamic" | "file_dynamic"
  /** Short label used in hint details, e.g. "pg", "fs", "axios". */
  label: string
}

/** Normalized module specifier → effect classification. */
const MODULE_EFFECT_MAP: Record<string, ModuleEffect> = {
  // ── Filesystem ──
  fs: { classify: "file_dynamic", label: "fs" },
  "fs-extra": { classify: "file_dynamic", label: "fs-extra" },
  "graceful-fs": { classify: "file_dynamic", label: "graceful-fs" },
  chokidar: { classify: "file_io", label: "chokidar" },
  glob: { classify: "file_io", label: "glob" },
  "fast-glob": { classify: "file_io", label: "fast-glob" },
  tmp: { classify: "file_io", label: "tmp" },

  // ── Network / HTTP ──
  http: { classify: "network_call", label: "node_http" },
  https: { classify: "network_call", label: "node_http" },
  http2: { classify: "network_call", label: "node_http" },
  net: { classify: "network_call", label: "node_net" },
  tls: { classify: "network_call", label: "node_tls" },
  dgram: { classify: "network_call", label: "node_dgram" },
  dns: { classify: "network_call", label: "node_dns" },
  undici: { classify: "network_call", label: "undici" },
  axios: { classify: "network_call", label: "axios" },
  "node-fetch": { classify: "network_call", label: "node-fetch" },
  got: { classify: "network_call", label: "got" },
  ky: { classify: "network_call", label: "ky" },
  superagent: { classify: "network_call", label: "superagent" },
  ws: { classify: "network_call", label: "websocket" },
  "socket.io": { classify: "network_call", label: "socket.io" },
  "socket.io-client": { classify: "network_call", label: "socket.io" },
  nodemailer: { classify: "network_call", label: "nodemailer" },
  stripe: { classify: "network_call", label: "stripe" },
  twilio: { classify: "network_call", label: "twilio" },
  "@sendgrid/mail": { classify: "network_call", label: "sendgrid" },
  openai: { classify: "network_call", label: "openai" },
  "@anthropic-ai/sdk": { classify: "network_call", label: "anthropic" },
  "@aws-sdk/client-s3": { classify: "network_call", label: "aws-s3" },
  "@aws-sdk/client-dynamodb": { classify: "db_dynamic", label: "dynamodb" },
  "@octokit/rest": { classify: "network_call", label: "github" },

  // ── Databases / ORMs ──
  pg: { classify: "db_dynamic", label: "pg" },
  "pg-pool": { classify: "db_dynamic", label: "pg" },
  mysql: { classify: "db_dynamic", label: "mysql" },
  mysql2: { classify: "db_dynamic", label: "mysql" },
  sqlite3: { classify: "db_dynamic", label: "sqlite" },
  "better-sqlite3": { classify: "db_dynamic", label: "sqlite" },
  knex: { classify: "db_dynamic", label: "knex" },
  "@prisma/client": { classify: "db_dynamic", label: "prisma" },
  typeorm: { classify: "db_dynamic", label: "typeorm" },
  sequelize: { classify: "db_dynamic", label: "sequelize" },
  mongodb: { classify: "db_dynamic", label: "mongodb" },
  mongoose: { classify: "db_dynamic", label: "mongoose" },
  "drizzle-orm": { classify: "db_dynamic", label: "drizzle" },
  kysely: { classify: "db_dynamic", label: "kysely" },
  firebase: { classify: "db_dynamic", label: "firebase" },
  "firebase-admin": { classify: "db_dynamic", label: "firebase" },
  "@supabase/supabase-js": { classify: "db_dynamic", label: "supabase" },

  // ── Caches ──
  redis: { classify: "cache_op", label: "redis" },
  ioredis: { classify: "cache_op", label: "redis" },
  memcached: { classify: "cache_op", label: "memcached" },
  keyv: { classify: "cache_op", label: "keyv" },
  "node-cache": { classify: "cache_op", label: "node-cache" },

  // ── Processes / concurrency ──
  child_process: { classify: "concurrency", label: "child_process" },
  execa: { classify: "concurrency", label: "execa" },
  "cross-spawn": { classify: "concurrency", label: "spawn" },
  worker_threads: { classify: "concurrency", label: "worker_threads" },
  cluster: { classify: "concurrency", label: "cluster" },

  // ── Auth / crypto-adjacent auth ──
  jsonwebtoken: { classify: "auth_check", label: "jwt" },
  bcrypt: { classify: "auth_check", label: "bcrypt" },
  bcryptjs: { classify: "auth_check", label: "bcrypt" },
  argon2: { classify: "auth_check", label: "argon2" },
  passport: { classify: "auth_check", label: "passport" },

  // ── Validation ──
  zod: { classify: "validation", label: "zod" },
  joi: { classify: "validation", label: "joi" },
  yup: { classify: "validation", label: "yup" },
  ajv: { classify: "validation", label: "ajv" },

  // ── Logging ──
  winston: { classify: "logging", label: "winston" },
  pino: { classify: "logging", label: "pino" },
  bunyan: { classify: "logging", label: "bunyan" },
  log4js: { classify: "logging", label: "log4js" },
  debug: { classify: "logging", label: "debug" },
}

/** Effectful globals from the default TS libs (no import statement involved). */
const GLOBAL_EFFECT_MAP: Record<string, { classify: HintType; detail: string }> = {
  fetch: { classify: "network_call", detail: "fetch" },
  WebSocket: { classify: "network_call", detail: "websocket" },
  XMLHttpRequest: { classify: "network_call", detail: "xhr" },
  EventSource: { classify: "network_call", detail: "event_source" },
  localStorage: { classify: "cache_op", detail: "web_storage" },
  sessionStorage: { classify: "cache_op", detail: "web_storage" },
  indexedDB: { classify: "db_read", detail: "indexeddb" },
}

const DB_READ_VERBS =
  /^(find|get|select|count|aggregate|list|first|head|search|scan|fetch|read|load|peek|exists|has|distinct|pluck|raw)/i
const DB_WRITE_VERBS =
  /^(insert|update|delete|save|create|upsert|destroy|remove|write|set|add|push|put|patch|truncate|drop|increment|decrement|bulk|batch|merge|replace)/i
const FILE_READ_VERBS = /^(read|stat|lstat|fstat|access|exists|opendir|readdir|realpath|watch|createReadStream|glob)/i
const FILE_WRITE_VERBS =
  /^(write|append|mkdir|rm|rmdir|unlink|rename|copy|chmod|chown|truncate|link|symlink|utimes|createWriteStream|open)/i
const SQL_WRITE_RE = /^\s*(insert|update|delete|create|drop|alter|truncate|merge|grant|revoke)\b/i
const SQL_TXN_RE = /^\s*(begin|commit|rollback|start\s+transaction|savepoint)\b/i

/** Strip node: prefix and subpaths: "node:fs/promises" → "fs". */
export function normalizeModuleSpecifier(spec: string): string {
  let s = spec.startsWith("node:") ? spec.slice(5) : spec
  if (s.startsWith("@")) {
    // Scoped package: keep scope + name ("@prisma/client/runtime" → "@prisma/client")
    const parts = s.split("/")
    s = parts.slice(0, 2).join("/")
  } else {
    s = s.split("/")[0] ?? s
  }
  return s
}

/** Extract the module specifier a symbol was imported from, if any. */
function moduleSpecifierForSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): string | null {
  let sym = symbol
  // Follow import aliases to walk through `import { x } from "mod"`
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      const aliased = checker.getAliasedSymbol(sym)
      // If the alias resolves into a real module file, prefer declaration scan
      // on the ORIGINAL symbol (its declaration holds the import statement).
      if (aliased && aliased.declarations?.length) {
        const viaImport = specifierFromDeclarations(sym.declarations ?? [])
        if (viaImport) return viaImport
        sym = aliased
      }
    } catch {
      // unresolved module — the import declaration still names the specifier
    }
  }
  const direct = specifierFromDeclarations(sym.declarations ?? [])
  if (direct) return direct
  // Fall back to the declaring file's package name (node_modules/<pkg>/...)
  const decl = sym.declarations?.[0]
  if (decl) {
    const fileName = decl.getSourceFile().fileName
    const pkg = packageFromFileName(fileName)
    if (pkg) return pkg
  }
  return null
}

/** Find an import/require specifier in a symbol's declarations. */
function specifierFromDeclarations(decls: readonly ts.Declaration[]): string | null {
  for (const decl of decls) {
    // import x from "mod" / import { x } from "mod" / import * as x from "mod"
    let node: ts.Node | undefined = decl
    while (node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        return node.moduleSpecifier.text
      }
      if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference
        if (ts.isExternalModuleReference(ref) && ref.expression && ts.isStringLiteral(ref.expression)) {
          return ref.expression.text
        }
      }
      node = node.parent
    }
    // const x = require("mod") — also require("mod").sub
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const spec = requireSpecifier(decl.initializer)
      if (spec) return spec
    }
  }
  return null
}

function requireSpecifier(expr: ts.Expression): string | null {
  let target = expr
  // unwrap require("m").member  /  require("m") as T
  while (ts.isPropertyAccessExpression(target) || ts.isAsExpression(target) || ts.isParenthesizedExpression(target)) {
    target = target.expression
  }
  if (
    ts.isCallExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "require" &&
    target.arguments.length > 0
  ) {
    const arg = target.arguments[0]
    if (arg && ts.isStringLiteral(arg)) return arg.text
  }
  return null
}

/** node_modules/<pkg>/... or TS default lib → package/global marker. */
function packageFromFileName(fileName: string): string | null {
  const norm = fileName.split(path.sep).join("/")
  const nmIdx = norm.lastIndexOf("node_modules/")
  if (nmIdx >= 0) {
    const rest = norm.slice(nmIdx + "node_modules/".length)
    const parts = rest.split("/")
    if (parts[0] === "@types" && parts[1]) {
      // @types/node → "node:<builtin>" is not recoverable here; treat the
      // typed package name itself ("node" means a builtin — resolved via
      // the import specifier path in practice).
      return parts[1] === "node" ? null : (parts[1] ?? null)
    }
    if (parts[0]?.startsWith("@") && parts[1]) return `${parts[0]}/${parts[1]}`
    return parts[0] ?? null
  }
  return null
}

/** Walk to the leftmost identifier of a callee chain: a.b.c(...) → a; new A() → A. */
function rootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let cur: ts.Expression = expr
  for (;;) {
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression
    } else if (
      ts.isCallExpression(cur) ||
      ts.isNewExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur)
    ) {
      cur = cur.expression
    } else if (ts.isAwaitExpression(cur)) {
      cur = cur.expression
    } else if (ts.isIdentifier(cur)) {
      return cur
    } else {
      return null
    }
  }
}

/**
 * True when this call's RESULT is immediately invoked further down a member
 * chain — e.g. the `knex("orders")` in `knex("orders").where(...).update(...)`.
 * Such intermediate calls acquire a handle; the OUTERMOST member call is the
 * one that carries the effect, so fallback classification skips these.
 */
function isIntermediateChainCall(call: ts.CallExpression): boolean {
  let p: ts.Node | undefined = call.parent
  // call ─ propertyAccess(.where) ─ call(...) …
  while (p && (ts.isPropertyAccessExpression(p) || ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p))) {
    if (ts.isPropertyAccessExpression(p) && p.parent && ts.isCallExpression(p.parent)) return true
    p = p.parent
  }
  return false
}

/** The member being invoked: a.b.c(...) → "c"; f(...) → "f". */
function invokedMemberName(callee: ts.Expression): string {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isIdentifier(callee)) return callee.text
  return ""
}

function classifyDbCall(member: string, call: ts.CallExpression, label: string): { type: HintType; detail: string }[] {
  // SQL sniffing on the first string argument beats verb guessing for raw query APIs
  const firstArg = call.arguments[0]
  if (firstArg && (ts.isStringLiteral(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg))) {
    const sql = firstArg.text
    if (SQL_TXN_RE.test(sql)) return [{ type: "transaction", detail: `${label}.${member}` }]
    if (SQL_WRITE_RE.test(sql)) return [{ type: "db_write", detail: `${label}.${member}` }]
    if (/^\s*(select|with|show|explain)\b/i.test(sql)) return [{ type: "db_read", detail: `${label}.${member}` }]
  }
  if (member === "transaction" || member === "$transaction") {
    return [{ type: "transaction", detail: `${label}.transaction` }]
  }
  if (DB_WRITE_VERBS.test(member)) return [{ type: "db_write", detail: `${label}.${member}` }]
  if (DB_READ_VERBS.test(member)) return [{ type: "db_read", detail: `${label}.${member}` }]
  // Unknown member on a DB module: still a DB touch UNLESS it's an
  // intermediate handle-acquisition in a builder chain (knex("t").where()…)
  // — there the outermost member call carries the classification.
  if (isIntermediateChainCall(call)) return []
  return [{ type: "db_read", detail: `${label}.${member || "call"}` }]
}

function classifyFileCall(member: string, label: string): { type: HintType; detail: string }[] {
  if (FILE_WRITE_VERBS.test(member)) return [{ type: "file_io", detail: `write_file` }]
  if (FILE_READ_VERBS.test(member)) return [{ type: "file_io", detail: `read_file` }]
  return [{ type: "file_io", detail: `${label}_operation` }]
}

export interface ResolvedEffectHint {
  hint_type: HintType
  detail: string
  line: number
  method: "type_resolved"
}

/**
 * Resolve type-backed effect hints for every call/new expression inside
 * `bodyNode`. Purely additive and safe: anything unresolvable produces no
 * hint (the adapter's syntactic heuristics cover local categories).
 */
export function resolveEffectHints(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ResolvedEffectHint[] {
  const hints: ResolvedEffectHint[] = []

  const record = (type: HintType, detail: string, node: ts.Node): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    hints.push({ hint_type: type, detail, line: line + 1, method: "type_resolved" })
  }

  const classifyCallee = (callee: ts.Expression, callNode: ts.CallExpression | ts.NewExpression): void => {
    const root = rootIdentifier(callee)
    if (!root) return
    const member = invokedMemberName(callee)

    // 1) Effectful globals (fetch, WebSocket, localStorage...)
    const globalHit = GLOBAL_EFFECT_MAP[root.text]
    if (globalHit) {
      const sym = checker.getSymbolAtLocation(root)
      const declaredInLib =
        !sym ||
        (sym.declarations ?? []).some((d) => {
          const f = d.getSourceFile().fileName
          return f.includes("typescript/lib/lib.") || f.includes("@types/node") || f.includes("@types/web")
        })
      // Only tag when the identifier is genuinely the global (not a local shadow)
      if (declaredInLib) {
        record(globalHit.classify, globalHit.detail, callNode)
        return
      }
    }

    // 2) Module-backed values
    const sym = checker.getSymbolAtLocation(root)
    if (!sym) return
    let spec = moduleSpecifierForSymbol(sym, checker)
    if (!spec) {
      // The root may be a local variable initialized from a module value:
      //   const client = new Redis()  /  const p = pool  — follow one hop.
      const decl = sym.valueDeclaration
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const viaRequire = requireSpecifier(decl.initializer)
        if (viaRequire) {
          spec = viaRequire
        } else {
          const initRoot = rootIdentifier(decl.initializer)
          if (initRoot) {
            const initSym = checker.getSymbolAtLocation(initRoot)
            if (initSym) spec = moduleSpecifierForSymbol(initSym, checker)
          }
        }
      }
    }
    if (!spec) return

    const entry = MODULE_EFFECT_MAP[normalizeModuleSpecifier(spec)]
    if (!entry) return

    if (entry.classify === "db_dynamic") {
      if (ts.isCallExpression(callNode)) {
        for (const h of classifyDbCall(member, callNode, entry.label)) record(h.type, h.detail, callNode)
      } else {
        record("db_read", `${entry.label}.connect`, callNode)
      }
    } else if (entry.classify === "file_dynamic") {
      for (const h of classifyFileCall(member, entry.label)) record(h.type, h.detail, callNode)
    } else {
      const detail = member && member !== root.text ? `${entry.label}.${member}` : entry.label
      record(entry.classify, detail, callNode)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      classifyCallee(node.expression, node)
    } else if (ts.isNewExpression(node) && node.expression) {
      classifyCallee(node.expression, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(bodyNode)

  return hints
}
