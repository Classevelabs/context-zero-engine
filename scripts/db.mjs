#!/usr/bin/env node
/**
 * The private database, from the command line.
 *
 *   npm run db:up        start it (provisioning it the first time)
 *   npm run db:status    where it is and whether it is running
 *   npm run db:stop      stop it
 */
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isListening, paths, provision, readState, start, stop } from "./lib/local-postgres.mjs"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const command = process.argv[2] || "up"

try {
  if (command === "up" || command === "provision") {
    const pg = require(path.join(repoRoot, "node_modules", "pg"))
    const state = await provision({ pg })
    console.log(`Database ready on 127.0.0.1:${state.port}, database ${state.database}, user ${state.user}.`)
    console.log(`Data: ${paths().dataDir}`)
  } else if (command === "stop") {
    console.log(stop() ? "Database stopped." : "No private database to stop.")
  } else if (command === "status") {
    const state = readState()
    if (!state) {
      console.log("No private database here. `npm run db:up` creates one.")
      process.exit(0)
    }
    const running = await isListening(state.port)
    console.log(`Private database on 127.0.0.1:${state.port}: ${running ? "running" : "stopped"}`)
    console.log(`Data: ${paths().dataDir}`)
    console.log(`Log:  ${paths().logFile}`)
    if (!running) process.exit(1)
  } else if (command === "start") {
    const state = await start()
    console.log(`Database running on 127.0.0.1:${state.port}.`)
  } else {
    console.error(`Unknown command: ${command}. Use up, status, stop.`)
    process.exit(2)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
