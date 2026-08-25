/**
 * TypeScript Adapter Unit Tests
 *
 * Tests the core extraction pipeline:
 * - Behavioral hint pattern matching (positive + negative cases)
 * - Symbol extraction from TypeScript source
 * - False positive prevention (crypto, Map, Set operations)
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

jest.mock("../db-driver", () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    batchInsert: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("../db-driver/core_data", () => ({
  coreDataService: { upsertBehavioralProfile: jest.fn(), insertContractProfile: jest.fn() },
}))

import { extractFromTypeScript } from "../adapters/ts/index"

let tmpDir: string
let counter = 0

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scg-ts-test-"))
})
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function extract(source: string) {
  const fp = path.join(tmpDir, `t${++counter}.ts`)
  fs.writeFileSync(fp, source, "utf-8")
  return extractFromTypeScript([fp])
}

async function hints(source: string) {
  return (await extract(source)).behavior_hints
}
async function symbols(source: string) {
  return (await extract(source)).symbols
}
function ofType(h: any[], t: string) {
  return h.filter((x: any) => x.hint_type === t)
}

// ── Behavioral Hints: Positive Cases ──

describe("Behavioral Hints — Positive", () => {
  test("detects .findOne() on a typed ORM client (type-resolved)", async () => {
    const src = [
      'import knex from "knex"',
      'const db = knex({ client: "pg" })',
      'async function f() { return db("users").where({ id: 1 }).first(); }',
    ].join("\n")
    expect(ofType(await hints(src), "db_read").length).toBeGreaterThan(0)
  })

  test("does NOT tag .findOne() on an unresolvable receiver", async () => {
    expect(ofType(await hints("function f(db: any) { return db.findOne({ id: 1 }); }"), "db_read").length).toBe(0)
  })
  test('detects pool.query("SELECT ...") (type-resolved, SQL-sniffed)', async () => {
    const src = [
      'import { Pool } from "pg"',
      "const pool = new Pool()",
      'async function f() { return pool.query("SELECT 1"); }',
    ].join("\n")
    expect(ofType(await hints(src), "db_read").length).toBeGreaterThan(0)
  })
  test("detects insertOne() on a typed mongo collection (type-resolved)", async () => {
    const src = [
      'import { MongoClient } from "mongodb"',
      "const mongo = new MongoClient(\"mongodb://localhost\")",
      "async function f() { return mongo.insertOne({ x: 1 }); }",
    ].join("\n")
    expect(ofType(await hints(src), "db_write").length).toBeGreaterThan(0)
  })
  test("detects pg pool UPDATE (type-resolved)", async () => {
    const src = [
      'import { Pool } from "pg"',
      "const pool = new Pool()",
      'async function f() { return pool.query("UPDATE users SET x = 1"); }',
    ].join("\n")
    expect(ofType(await hints(src), "db_write").length).toBeGreaterThan(0)
  })

  test("does NOT tag .update() on an unresolvable receiver (was a guess before)", async () => {
    expect(ofType(await hints("function f(db: any) { return db.update({ x: 1 }); }"), "db_write").length).toBe(0)
  })
  test("detects deleteOne() on a typed mongo collection (type-resolved)", async () => {
    const src = [
      'import { MongoClient } from "mongodb"',
      "const mongo = new MongoClient(\"mongodb://localhost\")",
      "async function f() { return mongo.deleteOne({ id: 1 }); }",
    ].join("\n")
    expect(ofType(await hints(src), "db_write").length).toBeGreaterThan(0)
  })
  test("detects updateMany() on a typed mongo collection (type-resolved)", async () => {
    const src = [
      'import { MongoClient } from "mongodb"',
      "const mongo = new MongoClient(\"mongodb://localhost\")",
      "async function f() { return mongo.updateMany({ a: true }); }",
    ].join("\n")
    expect(ofType(await hints(src), "db_write").length).toBeGreaterThan(0)
  })
  test("detects fetch()", async () => {
    expect(
      ofType(await hints('async function f() { return fetch("https://api.com"); }'), "network_call").length,
    ).toBeGreaterThan(0)
  })
  test("detects axios.get() via import (type-resolved)", async () => {
    const src = ['import axios from "axios"', 'async function f() { return axios.get("/api"); }'].join("\n")
    expect(ofType(await hints(src), "network_call").length).toBeGreaterThan(0)
  })
  test("detects readFileSync() via fs import (type-resolved)", async () => {
    const src = ['import { readFileSync } from "fs"', 'function f() { return readFileSync("f.txt"); }'].join("\n")
    expect(ofType(await hints(src), "file_io").length).toBeGreaterThan(0)
  })
  test("detects fs.writeFile() via fs import (type-resolved)", async () => {
    const src = ['import * as fs from "fs"', 'function f() { fs.writeFile("o.txt", "d", () => {}); }'].join("\n")
    expect(ofType(await hints(src), "file_io").length).toBeGreaterThan(0)
  })
  test("detects .transaction()", async () => {
    expect(
      ofType(await hints("async function f() { return db.transaction(async (t: any) => {}); }"), "transaction").length,
    ).toBeGreaterThan(0)
  })
  test("detects throw new Error", async () => {
    expect(ofType(await hints('function f() { throw new Error("bad"); }'), "throws").length).toBeGreaterThan(0)
  })
  test("detects catch", async () => {
    expect(ofType(await hints("function f() { try {} catch(e) { console.error(e); } }"), "catches").length).toBeGreaterThan(0)
  })
  test("detects this.x =", async () => {
    expect(ofType(await hints("class C { n = 0; m() { this.n = 5; } }"), "state_mutation").length).toBeGreaterThan(0)
  })
  test("detects console.log", async () => {
    expect(ofType(await hints('function f() { console.log("hi"); }'), "logging").length).toBeGreaterThan(0)
  })
})

// ── Behavioral Hints: Negative (False Positive Prevention) ──

describe("Behavioral Hints — False Positives", () => {
  test("Map.get() is NOT db_read", async () => {
    expect(
      ofType(await hints('function f() { const m = new Map<string,string>(); return m.get("k"); }'), "db_read").length,
    ).toBe(0)
  })
  test("crypto.update() is NOT db_write", async () => {
    expect(
      ofType(
        await hints(
          'import * as crypto from "crypto";\nfunction sha(s: string) { return crypto.createHash("sha256").update(s).digest("hex"); }',
        ),
        "db_write",
      ).length,
    ).toBe(0)
  })
  test("Map.delete() is NOT db_write", async () => {
    expect(
      ofType(await hints('function f() { const m = new Map<string,string>(); m.delete("k"); }'), "db_write").length,
    ).toBe(0)
  })
  test("Set.delete() is NOT db_write", async () => {
    expect(ofType(await hints('function f() { const s = new Set<string>(); s.delete("i"); }'), "db_write").length).toBe(0)
  })
})

// ── Symbol Extraction ──

describe("Symbol Extraction", () => {
  test("extracts function", async () => {
    const fn = (await symbols('export function greet(name: string): string { return "hi " + name; }')).find(
      (s) => s.canonical_name === "greet",
    )
    expect(fn).toBeDefined()
    expect(fn!.kind).toBe("function")
    expect(fn!.visibility).toBe("public")
  })
  test("extracts class", async () => {
    const cls = (await symbols("export class Svc { run() { return 1; } }")).find((s) => s.canonical_name === "Svc")
    expect(cls).toBeDefined()
    expect(cls!.kind).toBe("class")
  })
  test("extracts interface", async () => {
    const i = (await symbols("export interface Cfg { host: string; }")).find((s) => s.canonical_name === "Cfg")
    expect(i).toBeDefined()
    expect(i!.kind).toBe("interface")
  })
  test("generates AST hash (64-char hex)", async () => {
    const fn = (await symbols("function add(a: number, b: number) { return a + b; }")).find(
      (s) => s.canonical_name === "add",
    )
    expect(fn).toBeDefined()
    expect(fn!.ast_hash).toMatch(/^[0-9a-f]{64}$/)
  })
  test("generates body hash (64-char hex)", async () => {
    const fn = (await symbols("function compute() { return 42; }")).find((s) => s.canonical_name === "compute")
    expect(fn).toBeDefined()
    expect(fn!.body_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("call targets resolve to a declaration, not a name", () => {
  function extractMulti(files: { name: string; source: string }[]) {
    const dir = fs.mkdtempSync(path.join(tmpDir, "multi-"))
    const paths = files.map((f) => {
      const p = path.join(dir, f.name)
      fs.writeFileSync(p, f.source, "utf-8")
      return p
    })
    return extractFromTypeScript(paths)
  }

  test("a method call carries the declaration site of the method it reaches", async () => {
    // `db.query(...)` names only `query`. Any real repository has several
    // symbols called `query`, so the name alone cannot say which one runs.
    const result = await extractMulti([
      { name: "db.ts", source: `export class Db { query(sql: string): number { return sql.length } }\n` },
      {
        name: "use.ts",
        source: `import { Db } from "./db"\nconst db = new Db()\nexport function runIt(): number { return db.query("select 1") }\n`,
      },
    ])

    const call = result.relations.find((r) => r.target_name === "query" && r.source_key.includes("runIt"))
    expect(call).toBeDefined()
    expect(call?.target_key).toBeDefined()
    expect(call?.target_key).toContain("db.ts")
    expect(call?.target_key).toContain("#query")
  })

  test("two same-named methods resolve to different declarations", async () => {
    // The case that silently collapsed: one name, two symbols. Without a
    // declaration key both calls land on whichever was indexed last, so one
    // symbol collects callers it never had and the other looks dead.
    const result = await extractMulti([
      { name: "a.ts", source: `export class A { run(): number { return 1 } }\n` },
      { name: "b.ts", source: `export class B { run(): number { return 2 } }\n` },
      {
        name: "caller.ts",
        source:
          `import { A } from "./a"\nimport { B } from "./b"\n` +
          `export function callA(): number { return new A().run() }\n` +
          `export function callB(): number { return new B().run() }\n`,
      },
    ])

    const fromA = result.relations.find((r) => r.source_key.includes("callA") && r.target_name === "run")
    const fromB = result.relations.find((r) => r.source_key.includes("callB") && r.target_name === "run")

    expect(fromA?.target_key).toContain("a.ts")
    expect(fromB?.target_key).toContain("b.ts")
    expect(fromA?.target_key).not.toEqual(fromB?.target_key)
  })

  test("calls leaving the program carry no declaration key", async () => {
    // A key pointing outside the indexed corpus would only ever fail to
    // resolve; absence is the honest answer.
    const result = await extractMulti([
      { name: "ext.ts", source: `export function f(): string { return JSON.stringify({ a: 1 }) }\n` },
    ])
    const call = result.relations.find((r) => r.target_name === "stringify")
    if (call) expect(call.target_key).toBeUndefined()
  })
})

describe("JSX component usage is a call", () => {
  test("rendering a component records an edge to its declaration", async () => {
    // `<Header />` runs Header. Without this the component graph is empty and
    // every component in the repository reads as uncalled.
    const dir = fs.mkdtempSync(path.join(tmpDir, "jsx-"))
    const header = path.join(dir, "header.tsx")
    const page = path.join(dir, "page.tsx")
    fs.writeFileSync(header, `export function Header() { return null }\n`, "utf-8")
    fs.writeFileSync(
      page,
      `import { Header } from "./header"\nexport function Page() { return <Header /> }\n`,
      "utf-8",
    )

    const result = await extractFromTypeScript([header, page])
    const edge = result.relations.find((r) => r.target_name === "Header" && r.source_key.includes("Page"))

    expect(edge).toBeDefined()
    expect(edge?.relation_type).toBe("calls")
    expect(edge?.target_key).toContain("header.tsx")
  })

  test("intrinsic HTML elements are not treated as symbols", async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "jsx2-"))
    const p = path.join(dir, "d.tsx")
    fs.writeFileSync(p, `export function D() { return <div><span /></div> }\n`, "utf-8")

    const result = await extractFromTypeScript([p])
    expect(result.relations.some((r) => r.target_name === "div")).toBe(false)
    expect(result.relations.some((r) => r.target_name === "span")).toBe(false)
  })
})

describe("every symbol contributes its references", () => {
  function extractOne(name: string, source: string) {
    const dir = fs.mkdtempSync(path.join(tmpDir, "cov-"))
    const p = path.join(dir, name)
    fs.writeFileSync(p, source, "utf-8")
    return extractFromTypeScript([p])
  }

  test("an arrow function assigned to a const emits its calls", async () => {
    // The dominant style in modern TypeScript. Restricting extraction to
    // declared functions left these symbols indexed but silent, which is worse
    // than missing: they look present and contribute nothing.
    const result = await extractOne(
      "arrow.ts",
      `function helper(): number { return 1 }\nexport const run = () => helper()\n`,
    )
    const fromArrow = result.relations.filter((r) => r.source_key.includes("#run"))
    expect(fromArrow.some((r) => r.target_name === "helper")).toBe(true)
  })

  test("an arrow with an expression body still emits calls", async () => {
    const result = await extractOne(
      "expr.ts",
      `function load(): number { return 2 }\nexport const get = () => load()\n`,
    )
    expect(result.relations.some((r) => r.source_key.includes("#get") && r.target_name === "load")).toBe(true)
  })

  test("a class property initializer emits its calls", async () => {
    const result = await extractOne(
      "prop.ts",
      `function make(): number { return 3 }\nexport class Holder { value = make() }\n`,
    )
    expect(result.relations.some((r) => r.target_name === "make")).toBe(true)
  })

  test("an interface emits the types it references", async () => {
    const result = await extractOne(
      "iface.ts",
      `export interface Inner { a: number }\nexport interface Outer { inner: Inner }\n`,
    )
    const fromOuter = result.relations.filter((r) => r.source_key.includes("#Outer"))
    expect(fromOuter.some((r) => r.target_name === "Inner" && r.relation_type === "typed_as")).toBe(true)
  })

  test("a class is not credited with the calls made by its own methods", async () => {
    // Methods are symbols in their own right; walking the whole class would
    // attribute everything they do to the class as well.
    const result = await extractOne(
      "cls.ts",
      `function inner(): number { return 4 }\nexport class C { go(): number { return inner() } }\n`,
    )
    const classEdges = result.relations.filter((r) => /#C$/.test(r.source_key) && r.target_name === "inner")
    expect(classEdges).toHaveLength(0)
    expect(result.relations.some((r) => r.source_key.includes("go") && r.target_name === "inner")).toBe(true)
  })
})
