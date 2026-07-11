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
