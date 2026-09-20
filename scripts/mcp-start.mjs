#!/usr/bin/env node
/**
 * What an MCP client starts. It makes sure the database is running before the bridge needs it, then
 * becomes the bridge in this same process, so the client still supervises exactly one child.
 *
 * A client launches its servers when it starts and kills them when it exits; the database must not
 * be something the user remembers to start first, or the install is not finished.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isListening, readState, start } from "./lib/local-postgres.mjs"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Nothing here may write to stdout: the client is speaking MCP over it.
const note = (message) => process.stderr.write(`${message}\n`)

const envFile = process.env["CONTEXTZERO_ENV_FILE"] || path.join(repoRoot, ".env")
const configuredPort = (() => {
  try {
    const match = fs.readFileSync(envFile, "utf-8").match(/^\s*DB_PORT\s*=\s*['"]?(\d+)/m)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
})()

const state = readState()
// Only the database this engine provisioned is ours to start; a database the operator configured
// is theirs, and starting something on their behalf would be a surprise.
if (state && (configuredPort === null || configuredPort === state.port)) {
  if (!(await isListening(state.port))) {
    try {
      await start({ log: note })
      note(`ContextZero: started its database on 127.0.0.1:${state.port}`)
    } catch (error) {
      note(`ContextZero: could not start its database — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

await import(new URL("../dist/mcp-bridge/index.js", import.meta.url).href)
