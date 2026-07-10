import assert from "assert/strict"
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"
import pg from "pg"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const envFile = process.env.CONTEXTZERO_ENV_FILE || path.join(repoRoot, ".env")

dotenv.config({ path: envFile, quiet: true, override: Boolean(process.env.CONTEXTZERO_ENV_FILE) })

const { Pool } = pg
const tableName = `_contextzero_db_smoke_${Date.now()}`
const tableIdent = `"${tableName}"`
let failures = 0

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number.parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME || "scg_v2",
  user: process.env.DB_USER || process.env.USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  max: 5,
  idleTimeoutMillis: 1000,
  connectionTimeoutMillis: 3000,
})

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function expectPgError(name, query, code) {
  await check(name, async () => {
    try {
      await pool.query(query)
    } catch (error) {
      assert.equal(error.code, code)
      return
    }
    throw new Error(`expected PostgreSQL error code ${code}`)
  })
}

await check("connects and returns SELECT 1", async () => {
  const result = await pool.query("SELECT 1 AS val")
  assert.equal(result.rows[0].val, 1)
})

await check("pg_trgm extension is installed", async () => {
  const result = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
  assert.equal(result.rows.length, 1)
})

await check("creates smoke table", async () => {
  await pool.query(`CREATE TABLE ${tableIdent} (id serial PRIMARY KEY, val text)`)
})

await check("transaction COMMIT persists data", async () => {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO ${tableIdent} (val) VALUES ($1)`, ["committed"])
    await client.query("COMMIT")
  } finally {
    client.release(true)
  }

  const result = await pool.query(`SELECT val FROM ${tableIdent} WHERE val = 'committed'`)
  assert.equal(result.rows.length, 1)
})

await check("transaction ROLLBACK discards data", async () => {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`INSERT INTO ${tableIdent} (val) VALUES ($1)`, ["rolled_back"])
    await client.query("ROLLBACK")
  } finally {
    client.release(true)
  }

  const result = await pool.query(`SELECT val FROM ${tableIdent} WHERE val = 'rolled_back'`)
  assert.equal(result.rows.length, 0)
})

await check("concurrent transaction isolation uses committed state", async () => {
  const clientA = await pool.connect()
  const clientB = await pool.connect()
  try {
    await clientA.query("BEGIN")
    await clientA.query(`INSERT INTO ${tableIdent} (val) VALUES ($1)`, ["isolated"])
    const beforeCommit = await clientB.query(`SELECT val FROM ${tableIdent} WHERE val = 'isolated'`)
    assert.equal(beforeCommit.rows.length, 0)

    await clientA.query("COMMIT")
    const afterCommit = await clientB.query(`SELECT val FROM ${tableIdent} WHERE val = 'isolated'`)
    assert.equal(afterCommit.rows.length, 1)
  } finally {
    clientA.release(true)
    clientB.release(true)
  }
})

await check("advisory locks block a second acquirer", async () => {
  const lockId = 888888
  const clientA = await pool.connect()
  const clientB = await pool.connect()
  try {
    const first = await clientA.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId])
    assert.equal(first.rows[0].acquired, true)

    const blocked = await clientB.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId])
    assert.equal(blocked.rows[0].acquired, false)

    await clientA.query("SELECT pg_advisory_unlock($1)", [lockId])
    const retry = await clientB.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId])
    assert.equal(retry.rows[0].acquired, true)
    await clientB.query("SELECT pg_advisory_unlock($1)", [lockId])
  } finally {
    clientA.release(true)
    clientB.release(true)
  }
})

await expectPgError("bad SQL reports undefined_table", "SELECT * FROM nonexistent_table_xyz_12345", "42P01")
await expectPgError("syntax error reports 42601", "SELECTT broken syntax", "42601")

await check("parameterized queries treat malicious text as data", async () => {
  const result = await pool.query("SELECT $1::text AS val", ["'; DROP TABLE symbols; --"])
  assert.equal(result.rows[0].val, "'; DROP TABLE symbols; --")
})

try {
  await pool.query(`DROP TABLE IF EXISTS ${tableIdent}`)
} finally {
  await pool.end()
}

if (failures > 0) {
  console.error(`\nReal PostgreSQL smoke failed: ${failures} check(s) failed.`)
  process.exit(1)
}

console.log("\nReal PostgreSQL smoke passed.")
