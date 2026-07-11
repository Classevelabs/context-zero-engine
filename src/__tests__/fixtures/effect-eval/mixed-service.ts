/* eslint-disable */
// Effect-eval fixture: mixed effects, arrow-function coverage, cache/auth/process.
import Redis from "ioredis"
import jwt from "jsonwebtoken"
import { spawn } from "child_process"
import { Pool } from "pg"

const redis = new Redis()
const pool = new Pool()

export const syncAll = async (): Promise<void> => {
  const remote = await fetch("https://api.example.com/state")
  const body = await remote.json()
  await pool.query("UPDATE state SET blob = $1 WHERE id = 1", [JSON.stringify(body)])
}

export function spawnWorkerJob(cmd: string): void {
  spawn(cmd, { stdio: "ignore" })
}

export async function cacheUser(id: string, blob: string): Promise<void> {
  await redis.set(`user:${id}`, blob, "EX", 3600)
}

export function verifySession(token: string): unknown {
  return jwt.verify(token, "secret")
}

export const loadCachedUser = async (id: string): Promise<string | null> => {
  return redis.get(`user:${id}`)
}
