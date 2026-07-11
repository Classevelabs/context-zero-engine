/* eslint-disable */
// Effect-eval fixture: database TRUE positives with read/write/txn refinement.
import { Pool } from "pg"
import knex from "knex"

const pool = new Pool()
const k = knex({ client: "pg" })

export async function listUsers(): Promise<unknown[]> {
  const result = await pool.query("SELECT user_id, name FROM users")
  return result.rows
}

export async function insertUser(name: string): Promise<void> {
  await pool.query("INSERT INTO users (name) VALUES ($1)", [name])
}

export async function beginTxn(): Promise<void> {
  await pool.query("BEGIN")
}

export async function firstOrder(): Promise<unknown> {
  return k("orders").where({ open: true }).first()
}

export async function bulkArchive(ids: string[]): Promise<void> {
  await k("orders").whereIn("id", ids).update({ archived: true })
}
