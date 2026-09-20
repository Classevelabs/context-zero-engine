import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawnSync } from "child_process"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { isListening, paths as dbPaths, provision, readState } from "./lib/local-postgres.mjs"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const envPath = path.join(repoRoot, ".env")
const args = new Set(process.argv.slice(2))
const installMcpArg = process.argv.slice(2).find((arg) => arg.startsWith("--install-mcp="))
const installMcpClient = installMcpArg ? installMcpArg.slice("--install-mcp=".length) : ""
const supportedMcpClients = new Set(["claude", "codex", "cursor", "all"])

if (installMcpClient && !supportedMcpClients.has(installMcpClient)) {
  console.error(`Unsupported MCP client: ${installMcpClient}`)
  process.exit(2)
}

function run(command, commandArgs, options = {}) {
  console.log(`\n> ${[command, ...commandArgs].join(" ")}`)
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
    shell: false,
    windowsHide: true,
  })

  if (result.error) {
    console.error(result.error.message)
  }

  if (result.status !== 0 && !options.allowFailure) {
    process.exit(result.status ?? 1)
  }

  return result.status ?? 1
}

function runNpm(npmArgs, options = {}) {
  const configuredNpmCli = (process.env.npm_execpath || "").trim()
  const bundledNpmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  const npmCli = configuredNpmCli || (fs.existsSync(bundledNpmCli) ? bundledNpmCli : "")
  if (npmCli) {
    return run(process.execPath, [npmCli, ...npmArgs], options)
  }
  if (process.platform === "win32") {
    console.error("Unable to locate npm-cli.js. Run setup through `npm run setup`.")
    process.exit(1)
  }
  return run("npm", npmArgs, options)
}

// dotenv strips one layer of quotes and expands \n and \r inside double quotes.
// It does not unescape \" or \\, so the previous `"${value.replace(/"/g,'\\"')}"`
// wrote a password containing a quote back out as the literal \" — the engine
// then authenticated with a different string than the operator typed. Single
// quotes are taken literally by dotenv and are the only container that can hold
// a double quote, so pick the container instead of escaping inside it.
function escapeEnvValue(value) {
  if (/[\n\r]/.test(value)) {
    throw new Error("value contains a newline and cannot be written to .env")
  }
  if (!/[\s#"'\\]/.test(value)) return value
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"')) return `"${value}"`
  throw new Error("value contains both ' and \" and cannot be written to .env — set it by hand")
}

/**
 * The database this install will use. An operator who configured one in the environment keeps it;
 * anyone else gets the private server, because "install PostgreSQL, then find its password" was
 * the step this project lost people at.
 */
async function resolveDatabase() {
  const configured = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || "5432",
    name: process.env.DB_NAME || "scg_v2",
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  }
  if (configured.host && configured.user && configured.password) {
    return { ...configured, source: "environment" }
  }
  if (args.has("--no-private-database")) {
    throw new Error("No database in the environment and --no-private-database was given. Set DB_HOST, DB_USER and DB_PASSWORD.")
  }
  const require = createRequire(import.meta.url)
  const state = await provision({ pg: require(path.join(repoRoot, "node_modules", "pg")) })
  return {
    host: "127.0.0.1",
    port: String(state.port),
    name: state.database,
    user: state.user,
    password: state.password,
    source: "private",
  }
}

/** An .env that already points at the private server means it exists; it still has to be running. */
async function startPrivateDatabaseIfConfigured() {
  const state = readState()
  if (!state) return
  const configuredPort = (fs.readFileSync(envPath, "utf8").match(/^\s*DB_PORT\s*=\s*['"]?(\d+)/m) || [])[1]
  if (configuredPort && Number(configuredPort) !== state.port) return
  if (await isListening(state.port)) return
  const require = createRequire(import.meta.url)
  await provision({ pg: require(path.join(repoRoot, "node_modules", "pg")) })
  console.log(`Started the private database on 127.0.0.1:${state.port}`)
}

async function ensureEnvFile() {
  if (fs.existsSync(envPath)) {
    console.log(`Using existing .env: ${envPath}`)
    await startPrivateDatabaseIfConfigured()
    return
  }

  const db = await resolveDatabase()

  const allowedBasePath = process.env.SCG_ALLOWED_BASE_PATHS || path.dirname(repoRoot)
  const apiKey = process.env.SCG_API_KEYS || crypto.randomBytes(32).toString("hex")
  const adminApiKey = process.env.SCG_ADMIN_API_KEYS || crypto.randomBytes(32).toString("hex")
  const lines = [
    "# ContextZero local configuration",
    `DB_HOST=${db.host}`,
    `DB_PORT=${db.port}`,
    `DB_NAME=${db.name}`,
    `DB_USER=${db.user}`,
    `DB_PASSWORD=${escapeEnvValue(db.password)}`,
    `NODE_ENV=${process.env.NODE_ENV || "development"}`,
    `LOG_LEVEL=${process.env.LOG_LEVEL || "info"}`,
    `SCG_API_KEYS=${escapeEnvValue(apiKey)}`,
    `SCG_ADMIN_API_KEYS=${escapeEnvValue(adminApiKey)}`,
    `SCG_ALLOWED_BASE_PATHS=${escapeEnvValue(allowedBasePath)}`,
    `SCG_MAX_FILES_PER_REPO=${process.env.SCG_MAX_FILES_PER_REPO || "20000"}`,
    `SCG_MAX_FILE_SIZE_BYTES=${process.env.SCG_MAX_FILE_SIZE_BYTES || "1048576"}`,
    `SCG_INGEST_WORKERS=${process.env.SCG_INGEST_WORKERS || "4"}`,
    `SCG_PYTHON_TIMEOUT_MS=${process.env.SCG_PYTHON_TIMEOUT_MS || "30000"}`,
    "",
  ]

  fs.writeFileSync(envPath, lines.join("\n"), "utf8")
  console.log(`Created .env: ${envPath}`)
  console.log(
    db.source === "private"
      ? `Database: the private PostgreSQL on 127.0.0.1:${db.port} — nothing to install, no password to set. Data in ${dbPaths().dataDir}`
      : `Database: ${db.host}:${db.port}, from the environment.`,
  )
}

function ensureLocalDirectories() {
  fs.mkdirSync(path.join(repoRoot, ".contextzero", "mcp"), { recursive: true })
}

function printNextSteps(doctorStatus) {
  console.log("\nContextZero setup result")
  console.log("========================")
  if (doctorStatus === 0) {
    console.log("Doctor passed. The MCP bridge is ready to connect from a local MCP client.")
  } else {
    console.log("Doctor found blockers. Fix the FAIL items above, then run npm run doctor.")
  }

  console.log("\nUseful files:")
  console.log(`- ${path.join(repoRoot, ".contextzero", "mcp", "claude-desktop.json")}`)
  console.log(`- ${path.join(repoRoot, ".contextzero", "mcp", "codex-config.toml")}`)
  console.log(`- ${path.join(repoRoot, "docs", "OPERATIONS.md")}`)
  console.log(`- ${path.join(repoRoot, "docs", "RELEASE_READINESS.md")}`)
  if (!installMcpClient) {
    console.log("\nTo install MCP config directly into a supported client, run:")
    console.log("npm run mcp:install -- --client claude")
    console.log("npm run mcp:install -- --client codex")
  }

  if (args.has("--no-migrate")) {
    console.log("\nDatabase migrations were skipped. Apply them with: npm run db:migrate")
  }
}

try {
  await ensureEnvFile()
} catch (error) {
  console.error(`Could not write ${envPath}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
ensureLocalDirectories()

if (!fs.existsSync(path.join(repoRoot, "node_modules"))) {
  console.log("node_modules is missing. Installing dependencies first.")
  runNpm(["ci"])
}

runNpm(["run", "build"])

// An install that stops before the schema exists is not an install.
if (!args.has("--no-migrate")) {
  runNpm(["run", "db:migrate"])
}

runNpm(["run", "mcp:config"])
if (installMcpClient) {
  runNpm(["run", "mcp:install", "--", "--client", installMcpClient])
}
const doctorStatus = runNpm(["run", "doctor"], { allowFailure: true })
printNextSteps(doctorStatus)
process.exit(doctorStatus)
