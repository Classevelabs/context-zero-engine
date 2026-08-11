import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const envPath = path.join(repoRoot, ".env")
const bridgePath = path.join(repoRoot, "dist", "mcp-bridge", "index.js")

const args = process.argv.slice(2)
const options = {
  client: "all",
  dryRun: false,
  force: false,
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === "--dry-run") options.dryRun = true
  else if (arg === "--force") options.force = true
  else if (arg === "--client") options.client = args[++index] || "all"
  else if (arg.startsWith("--client=")) options.client = arg.slice("--client=".length)
  else {
    console.error(`Unknown option: ${arg}`)
    process.exit(2)
  }
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const parsed = {}
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    parsed[match[1]] = value
  }

  return parsed
}

function pickEnv(source) {
  if (fs.existsSync(envPath)) {
    return {
      CONTEXTZERO_ENV_FILE: envPath,
    }
  }

  const keys = [
    "CONTEXTZERO_ENV_FILE",
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "DB_SSL_MODE",
    "DB_SSL_CA",
    "NODE_ENV",
    "LOG_LEVEL",
    "SCG_ALLOWED_BASE_PATHS",
    "SCG_MCP_AUTH_ENABLED",
    "SCG_MCP_SECRET",
    "SCG_MCP_ADMIN_SECRET",
    "SCG_MCP_MUTATIONS_ENABLED",
    "SCG_ALLOW_UNSANDBOXED_EXECUTION",
    "SCG_MAX_FILES_PER_REPO",
    "SCG_MAX_FILE_SIZE_BYTES",
    "SCG_INGEST_WORKERS",
    "SCG_PYTHON_TIMEOUT_MS",
    "PYTHON_BIN",
  ]

  const env = {}
  for (const key of keys) {
    if (typeof source[key] === "string" && source[key].length > 0) {
      env[key] = source[key]
    }
  }

  env.NODE_ENV ??= "development"
  env.LOG_LEVEL ??= "info"
  env.SCG_ALLOWED_BASE_PATHS ??= repoRoot
  env.SCG_MAX_FILES_PER_REPO ??= "20000"
  env.SCG_MAX_FILE_SIZE_BYTES ??= "1048576"
  env.SCG_INGEST_WORKERS ??= "4"
  env.SCG_PYTHON_TIMEOUT_MS ??= "30000"
  return env
}

function buildServer() {
  const fileEnv = parseEnvFile(envPath)
  const effectiveEnv = { ...fileEnv, ...process.env }
  return {
    command: process.execPath,
    args: [bridgePath],
    env: pickEnv(effectiveEnv),
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  const backupPath = `${filePath}.contextzero-backup-${timestamp()}`
  if (!options.dryRun) fs.copyFileSync(filePath, backupPath)
  return backupPath
}

function atomicWrite(filePath, content) {
  if (options.dryRun) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, content, "utf8")
  fs.renameSync(tempPath, filePath)
}

function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const raw = fs.readFileSync(filePath, "utf8").trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Refusing to modify invalid JSON config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function installJsonMcpClient({ name, filePath, rootKey, server }) {
  const config = readJsonConfig(filePath)
  const next = { ...config }
  const servers = { ...(next[rootKey] && typeof next[rootKey] === "object" ? next[rootKey] : {}) }
  servers.contextzero = server
  next[rootKey] = servers

  const content = `${JSON.stringify(next, null, 2)}\n`
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : ""
  if (current === content) {
    console.log(`${name}: already configured at ${filePath}`)
    return
  }

  const backupPath = backupFile(filePath)
  atomicWrite(filePath, content)
  console.log(`${name}: ${options.dryRun ? "would install" : "installed"} contextzero at ${filePath}`)
  if (backupPath) console.log(`${name}: ${options.dryRun ? "would back up to" : "backup"} ${backupPath}`)
}

function tomlString(value) {
  return JSON.stringify(value)
}

function codexTomlSnippet(server) {
  const envEntries = Object.entries(server.env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")
  return [
    "[mcp_servers.contextzero]",
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
    `env = { ${envEntries} }`,
    "",
  ].join("\n")
}

function removeCodexSection(existing) {
  const lines = existing.split(/\r?\n/)
  const next = []
  let skipping = false

  for (const line of lines) {
    if (/^\s*\[mcp_servers\.contextzero\]\s*$/.test(line)) {
      skipping = true
      continue
    }

    if (skipping && /^\s*\[[^\]]+\]\s*$/.test(line)) {
      skipping = false
    }

    if (!skipping) next.push(line)
  }

  return next.join("\n").replace(/\s+$/u, "")
}

function installCodex(server) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const filePath = path.join(codexHome, "config.toml")
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : ""
  const withoutSection = removeCodexSection(current)
  const content = `${withoutSection ? `${withoutSection}\n\n` : ""}${codexTomlSnippet(server)}`

  if (current === content) {
    console.log(`Codex: already configured at ${filePath}`)
    return
  }

  const backupPath = backupFile(filePath)
  atomicWrite(filePath, content)
  console.log(`Codex: ${options.dryRun ? "would install" : "installed"} contextzero at ${filePath}`)
  if (backupPath) console.log(`Codex: ${options.dryRun ? "would back up to" : "backup"} ${backupPath}`)
}

function claudeConfigPath() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "Claude",
      "claude_desktop_config.json",
    )
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json")
}

function cursorConfigPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json")
}

const server = buildServer()
if (!fs.existsSync(bridgePath)) {
  console.error(`MCP bridge is not built: ${bridgePath}`)
  console.error("Run npm run build before installing client configs.")
  process.exit(1)
}

const clients = options.client
  .split(",")
  .map((client) => client.trim().toLowerCase())
  .filter(Boolean)
const targetClients = clients.includes("all") ? ["claude", "codex", "cursor"] : clients
const validClients = new Set(["claude", "codex", "cursor"])

try {
  for (const client of targetClients) {
    if (!validClients.has(client)) {
      throw new Error(`Unsupported client "${client}". Use claude, codex, cursor, or all.`)
    }

    if (client === "claude") {
      installJsonMcpClient({
        name: "Claude Desktop",
        filePath: claudeConfigPath(),
        rootKey: "mcpServers",
        server,
      })
    } else if (client === "codex") {
      installCodex(server)
    } else if (client === "cursor") {
      installJsonMcpClient({
        name: "Cursor",
        filePath: cursorConfigPath(),
        rootKey: "mcpServers",
        server,
      })
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
