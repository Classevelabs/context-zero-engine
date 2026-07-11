/* eslint-disable */
// Effect-eval fixture: every function here is PURE of external effects.
// These are the exact traps that made the pattern-based analyzer lie.
import * as crypto from "node:crypto"

export function mapBookkeeping(key: string): number | undefined {
  const m = new Map<string, number>()
  m.set(key, 1)
  const v = m.get(key)
  m.delete(key)
  return v
}

export function hashPayload(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex")
}

export function commentTrap(): number {
  // TODO: call .destroy() and fetch() the remote list later
  // also consider redis.set for caching and pool.query("INSERT ...")
  return 42
}

export function patternTableLike(): RegExp[] {
  const sqlHint = "SELECT * FROM users WHERE id = $1"
  const services = ["axios.get", "stripe.charges.create", "fs.writeFileSync"]
  void sqlHint
  void services
  return [/\bstripe\./i, /axios\.(get|post)/, /\.insertOne\s*\(/]
}

interface Channel {
  request(payload: string): Promise<string>
  delete(id: string): void
  insert(row: unknown): void
}

export async function localReceiver(chan: Channel): Promise<string> {
  chan.insert({ a: 1 })
  chan.delete("row-1")
  return chan.request("ping")
}

export function typeOnlyWebSocket(sock: WebSocket): string {
  return typeof sock
}

export function setBookkeeping(values: string[]): string[] {
  const s = new Set<string>(values)
  s.delete("gone")
  return [...s]
}
