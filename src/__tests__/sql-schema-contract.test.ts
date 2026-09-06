import * as fs from "fs"
import * as path from "path"

// Every column the engine's SQL names must exist in the schema it ships.
//
// Two tools had been broken since they were written: scg_explain_relation
// joined evidence_bundles on a column that table never had, and
// scg_review_homolog set inferred_relations.updated_at, which does not exist.
// No unit test could catch either — the driver is mocked — and the real
// database gate never called them. This reads every SQL literal in the source
// and checks each `alias.column`, `UPDATE ... SET column` and
// `INSERT INTO table (columns)` against db/schema.sql, which is generated from
// the migrations and held current by schema-freshness.test.ts.
//
// Aliases bound to subqueries or CTEs are unknown tables and are skipped, as
// are `${...}` interpolations and `alias.*`. That leaves a checker that found
// exactly the two real defects across 384 literals and nothing else.

const ROOT = path.resolve(__dirname, "..", "..")

const CONSTRAINT_WORDS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "EXCLUDE", "LIKE"])
const NOT_AN_ALIAS =
  /^(?:ON|SET|WHERE|USING|LEFT|RIGHT|INNER|CROSS|LATERAL|VALUES|SELECT|GROUP|ORDER|LIMIT|WITH|RETURNING|AS|JOIN|FROM)$/i

/** Tables and their columns, applying migrations' column changes in document order. */
export function tablesFromSchema(schema: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const m of schema.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const cols = tables.get(m[1]!) ?? new Set<string>()
    for (const raw of m[2]!.split("\n")) {
      const line = raw.replace(/--.*$/, "").trim()
      if (!line) continue
      const first = line.match(/^"?(\w+)"?/)?.[1]
      if (!first || CONSTRAINT_WORDS.has(first.toUpperCase())) continue
      cols.add(first.toLowerCase())
    }
    tables.set(m[1]!, cols)
  }
  // A migration may drop a column and add it back with another type, so
  // add-then-drop and drop-then-add differ: apply them in the order written.
  for (const m of schema.matchAll(/ALTER TABLE (\w+)\s+([^;]*);/g)) {
    const cols = tables.get(m[1]!)
    if (!cols) continue
    for (const op of m[2]!.matchAll(
      /(ADD COLUMN(?: IF NOT EXISTS)?|DROP COLUMN(?: IF EXISTS)?|RENAME COLUMN)\s+(\w+)(?:\s+TO\s+(\w+))?/g,
    )) {
      if (op[1]!.startsWith("ADD")) cols.add(op[2]!.toLowerCase())
      else if (op[1]!.startsWith("DROP")) cols.delete(op[2]!.toLowerCase())
      else {
        cols.delete(op[2]!.toLowerCase())
        if (op[3]) cols.add(op[3].toLowerCase())
      }
    }
  }
  for (const m of schema.matchAll(/DROP TABLE(?: IF EXISTS)? (\w+)/g)) tables.delete(m[1]!)
  return tables
}

/** Column references in one SQL literal that name a column the schema lacks. */
export function unknownColumnsIn(sql: string, tables: Map<string, Set<string>>): string[] {
  const text = sql.replace(/\$\{[^}]*\}/g, " __PH__ ")
  const aliases = new Map<string, string>()
  for (const a of text.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(\w+)(?:\s+(?:AS\s+)?([a-z_]\w*))?/gi)) {
    const table = a[1]!
    if (!tables.has(table)) continue
    aliases.set(table.toLowerCase(), table)
    if (a[2] && !NOT_AN_ALIAS.test(a[2])) aliases.set(a[2].toLowerCase(), table)
  }
  const findings: string[] = []
  const check = (table: string, column: string, what: string): void => {
    const col = column.toLowerCase()
    if (col === "*" || col === "__ph__") return
    if (!tables.get(table)!.has(col)) findings.push(`${what} ${table}.${col}`)
  }
  for (const r of text.matchAll(/\b([a-z_]\w*)\.(\w+|\*)/gi)) {
    const table = aliases.get(r[1]!.toLowerCase())
    if (table) check(table, r[2]!, "column")
  }
  for (const u of text.matchAll(/\bUPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/gi)) {
    if (!tables.has(u[1]!)) continue
    for (const assign of u[2]!.split(/,(?![^(]*\))/)) {
      const col = assign.trim().match(/^"?(\w+)"?\s*=/)?.[1]
      if (col) check(u[1]!, col, "SET")
    }
  }
  for (const i of text.matchAll(/\bINSERT INTO\s+(\w+)\s*\(([^)]*)\)/gi)) {
    if (!tables.has(i[1]!)) continue
    for (const col of i[2]!.split(",")) {
      const c = col.trim().replace(/"/g, "")
      if (/^\w+$/.test(c)) check(i[1]!, c, "INSERT")
    }
  }
  return findings
}

describe("every column the engine's SQL names exists in the shipped schema", () => {
  const tables = tablesFromSchema(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf8"))
  const dirs = [
    "src/services",
    "src/analysis-engine",
    "src/mcp-bridge",
    "src/db-driver",
    "src/ingestor",
    "src/homolog-engine",
    "src/semantic-engine",
    "src/transactional-editor",
    "src/watcher",
    "src/mcp-interface",
  ]

  test("the schema parser sees the tables the engine writes to", () => {
    expect(tables.get("inferred_relations")).toContain("evidence_bundle_id")
    expect(tables.get("evidence_bundles")).not.toContain("inferred_relation_id")
    // Dropped and re-added by migrations 023 and 025: order matters.
    expect(tables.get("semantic_vectors")).toContain("sparse_vector")
    expect(tables.get("semantic_vectors")).not.toContain("vector_id")
  })

  test("the checker reports a column that is not there, and not one that is", () => {
    const toy = new Map([["things", new Set(["thing_id", "name"])]])
    expect(unknownColumnsIn("SELECT t.name FROM things t WHERE t.thing_id = $1", toy)).toEqual([])
    expect(unknownColumnsIn("UPDATE things SET updated_at = NOW() WHERE thing_id = $1", toy)).toEqual([
      "SET things.updated_at",
    ])
    expect(unknownColumnsIn("SELECT x.missing FROM things x", toy)).toEqual(["column things.missing"])
    expect(unknownColumnsIn("INSERT INTO things (thing_id, colour) VALUES ($1, $2)", toy)).toEqual([
      "INSERT things.colour",
    ])
  })

  test("no SQL literal in the source names an unknown column", () => {
    const findings: string[] = []
    let literals = 0
    for (const dir of dirs) {
      for (const file of fs.readdirSync(path.join(ROOT, dir))) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
        const rel = `${dir}/${file}`
        const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
        for (const m of text.matchAll(/`([^`]*)`/g)) {
          if (!/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(m[1]!)) continue
          literals++
          const line = text.slice(0, m.index).split("\n").length
          for (const f of unknownColumnsIn(m[1]!, tables)) findings.push(`${rel}:${line} ${f}`)
        }
      }
    }
    expect(literals).toBeGreaterThan(300)
    expect(findings).toEqual([])
  })
})
