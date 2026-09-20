/**
 * The database the engine brings with it, for a machine that has no PostgreSQL.
 *
 * Installing and administering a database server — a service, a role, a password the operator has
 * to find — was the whole of ContextZero's setup, and the step people stopped at. This provisions
 * a private server under the user's own data directory instead: one initdb, one port nobody else
 * uses, a password generated here that no human ever types, and a database the engine owns.
 *
 * A machine that already has PostgreSQL never comes here. This is the fallback, not the default.
 */
import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

/** Where a private server keeps its binaries, data and log, outside the repository. */
export function baseDir() {
  if (process.env["CONTEXTZERO_HOME"]) return path.resolve(process.env["CONTEXTZERO_HOME"])
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local")
    return path.join(local, "ContextZero")
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "ContextZero")
  const share = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share")
  return path.join(share, "contextzero")
}

export const paths = () => {
  const base = baseDir()
  return {
    base,
    runtime: path.join(base, "runtime"),
    dataDir: path.join(base, "postgres", "data"),
    logFile: path.join(base, "postgres", "server.log"),
    statePath: path.join(base, "postgres", "server.json"),
  }
}

/** The platform package that carries the PostgreSQL binaries for this machine. */
export function binaryPackage() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch
  if (!["windows", "darwin", "linux"].includes(platform)) return null
  if (!["x64", "arm64", "arm", "ia32", "ppc64"].includes(arch)) return null
  return `@embedded-postgres/${platform}-${arch}`
}

export function binDir() {
  const pkg = binaryPackage()
  if (!pkg) return null
  const dir = path.join(paths().runtime, "node_modules", ...pkg.split("/"), "native", "bin")
  return fs.existsSync(dir) ? dir : null
}

export const exe = (dir, name) => path.join(dir, process.platform === "win32" ? `${name}.exe` : name)

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(paths().statePath, "utf-8"))
  } catch {
    return null
  }
}

const writeState = (state) => {
  fs.mkdirSync(path.dirname(paths().statePath), { recursive: true })
  // It holds the generated password, so this user is the only one who can read it.
  fs.writeFileSync(paths().statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
}

/** A database name is an identifier, not a value: it cannot be passed as a parameter. */
const quoteIdentifier = (name) => `"${String(name).replace(/"/g, '""')}"`

export function isListening(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (answer) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

async function freePort(start = 55432) {
  for (let port = start; port < start + 50; port++) {
    if (!(await isListening(port, 300))) return port
  }
  throw new Error("no free port for the private database in 55432-55482")
}

/**
 * Fetch the PostgreSQL binaries for this platform, once, into the user's data directory — not into
 * the repository, where the next `npm ci` would remove them and leave a running server with no
 * binaries to restart it.
 */
export function ensureBinaries({ log = console.log } = {}) {
  const existing = binDir()
  if (existing) return existing
  const pkg = binaryPackage()
  if (!pkg) throw new Error(`no PostgreSQL binaries are published for ${process.platform}-${process.arch}`)

  const { runtime } = paths()
  fs.mkdirSync(runtime, { recursive: true })
  log(`Fetching a private PostgreSQL for ${process.platform}-${process.arch} (one time, ~100 MB)...`)
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  const args = ["install", "--prefix", runtime, "--no-audit", "--no-fund", "--loglevel=error", pkg]
  const result = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync("npm", args, { stdio: "inherit", shell: false, windowsHide: true })
  if (result.status !== 0) throw new Error(`could not fetch ${pkg} (npm exited ${result.status ?? "null"})`)

  const dir = binDir()
  if (!dir) throw new Error(`${pkg} installed but its binaries are missing`)
  return dir
}

/** Every PostgreSQL process needs its own bin directory on PATH: on Windows a backend that cannot
 * load its DLLs dies with 0xC0000142 and takes the server down with it. */
const withBin = (dir) => ({ ...process.env, PATH: `${dir}${path.delimiter}${process.env["PATH"] || ""}` })

export function isInitialised() {
  return fs.existsSync(path.join(paths().dataDir, "PG_VERSION"))
}

/**
 * UTF-8 and the C collation are chosen here rather than inherited: initdb otherwise takes the
 * machine's code page, and a WIN1252 cluster rejects the schema's own text — and any source file
 * holding a character outside it.
 */
export function initialise({ user, password, log = console.log }) {
  const dir = binDir() ?? ensureBinaries({ log })
  const { dataDir } = paths()
  fs.mkdirSync(path.dirname(dataDir), { recursive: true })
  const pwFile = path.join(os.tmpdir(), `contextzero-pw-${crypto.randomBytes(8).toString("hex")}`)
  fs.writeFileSync(pwFile, password, { encoding: "utf-8", mode: 0o600 })
  try {
    const result = spawnSync(
      exe(dir, "initdb"),
      ["-D", dataDir, "-U", user, `--pwfile=${pwFile}`, "-E", "UTF8", "--locale=C", "--auth=scram-sha-256"],
      { env: withBin(dir), encoding: "utf-8", windowsHide: true },
    )
    if (result.status !== 0) throw new Error(`initdb failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`)
  } finally {
    fs.rmSync(pwFile, { force: true })
  }
}

/** Start the server so it outlives whoever started it: an MCP client's bridge exits with the
 * client, and the database it uses must not. */
export async function start({ log = console.log } = {}) {
  const state = readState()
  if (!state) throw new Error("no private database is provisioned here")
  if (await isListening(state.port)) return state

  const dir = binDir() ?? ensureBinaries({ log })
  const { dataDir, logFile } = paths()
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  // pg_ctl opens the log file itself and holds it exclusively on Windows, so nothing else may.
  const child = spawn(exe(dir, "pg_ctl"), ["-D", dataDir, "-o", `-p ${state.port}`, "-l", logFile, "start"], {
    env: withBin(dir),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()

  for (let attempt = 0; attempt < 80; attempt++) {
    if (await isListening(state.port)) return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`the private database did not start; see ${logFile}`)
}

export function stop() {
  const dir = binDir()
  const state = readState()
  if (!dir || !state) return false
  const result = spawnSync(exe(dir, "pg_ctl"), ["-D", paths().dataDir, "-m", "fast", "stop"], {
    env: withBin(dir),
    encoding: "utf-8",
    windowsHide: true,
  })
  return result.status === 0
}

/**
 * An open port is not a ready server: PostgreSQL accepts the connection and answers "the database
 * system is starting up" while it recovers, so readiness is a query that succeeds.
 */
async function waitUntilReady({ state, pg, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const client = new pg.Client({
      host: "127.0.0.1",
      port: state.port,
      user: state.user,
      password: state.password,
      database: "postgres",
      connectionTimeoutMillis: 3_000,
    })
    try {
      await client.connect()
      await client.query("SELECT 1")
      await client.end()
      return
    } catch (error) {
      last = error
      await client.end().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`the private database never became ready: ${last instanceof Error ? last.message : String(last)}`)
}

/** The database itself, created UTF-8 from template0 so it cannot inherit a template's encoding. */
async function ensureDatabase({ state, pg }) {
  const admin = new pg.Client({
    host: "127.0.0.1",
    port: state.port,
    user: state.user,
    password: state.password,
    database: "postgres",
  })
  await admin.connect()
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [state.database])
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(state.database)} ENCODING 'UTF8' TEMPLATE template0`)
    }
  } finally {
    await admin.end()
  }

  const client = new pg.Client({
    host: "127.0.0.1",
    port: state.port,
    user: state.user,
    password: state.password,
    database: state.database,
  })
  await client.connect()
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    const encoding = await client.query("SHOW server_encoding")
    if (encoding.rows[0].server_encoding !== "UTF8") {
      throw new Error(`the private database came up as ${encoding.rows[0].server_encoding}, not UTF8`)
    }
  } finally {
    await client.end()
  }
}

/**
 * Provision, or adopt, the private server and hand back the connection the engine should use.
 * Safe to call again: an initialised cluster is started, not rebuilt.
 */
export async function provision({ pg, database = "scg_v2", log = console.log } = {}) {
  if (!pg) throw new Error("provision needs the pg module")
  let state = readState()
  if (!state || !isInitialised()) {
    ensureBinaries({ log })
    const port = await freePort()
    state = {
      port,
      user: "contextzero",
      password: crypto.randomBytes(24).toString("hex"),
      database,
      createdAt: new Date().toISOString(),
    }
    log("Creating a private PostgreSQL for ContextZero (no install, no password to remember)...")
    initialise({ user: state.user, password: state.password, log })
    writeState(state)
  }
  await start({ log })
  await waitUntilReady({ state, pg })
  await ensureDatabase({ state, pg })
  return state
}
