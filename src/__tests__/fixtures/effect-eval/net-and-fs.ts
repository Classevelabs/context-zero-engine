/* eslint-disable */
// Effect-eval fixture: network + filesystem TRUE positives.
// Expected labels live in expected.json — keep function names in sync.
import axios from "axios"
import { readFileSync } from "fs"
import * as fsp from "fs/promises"

export async function fetchUsers(): Promise<unknown> {
  const res = await fetch("https://api.example.com/users")
  return res.json()
}

export async function downloadWithAxios(url: string): Promise<unknown> {
  const res = await axios.get(url)
  return res.data
}

export function readConfig(path: string): string {
  return readFileSync(path, "utf-8")
}

export async function appendAudit(line: string): Promise<void> {
  await fsp.appendFile("audit.log", line + "\n")
}

export function openSocket(url: string): unknown {
  const ws = new WebSocket(url)
  return ws
}
