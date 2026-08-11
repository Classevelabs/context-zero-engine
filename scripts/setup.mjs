import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

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

function escapeEnvValue(value) {
  return /[\s#"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function ensureEnvFile() {
  if (fs.existsSync(envPath)) {
    console.log(`Using existing .env: ${envPath}`)
    return
  }

  const allowedBasePath = process.env.SCG_ALLOWED_BASE_PATHS || path.dirname(repoRoot)
  const apiKey = process.env.SCG_API_KEYS || crypto.randomBytes(32).toString("hex")
  const adminApiKey = process.env.SCG_ADMIN_API_KEYS || crypto.randomBytes(32).toString("hex")
  const lines = [
    "# ContextZero local configuration",
    `DB_HOST=${process.env.DB_HOST || "localhost"}`,
    `DB_PORT=${process.env.DB_PORT || "5432"}`,
    `DB_NAME=${process.env.DB_NAME || "scg_v2"}`,
    `DB_USER=${process.env.DB_USER || "postgres"}`,
    `DB_PASSWORD=${escapeEnvValue(process.env.DB_PASSWORD || "CHANGE_ME_BEFORE_RUNNING")}`,
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
  console.log("Edit DB_PASSWORD if your local PostgreSQL password is different.")
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

  if (!args.has("--migrate")) {
    console.log("\nDatabase migrations were not run. To apply them during setup, run:")
    console.log("npm run setup -- --migrate")
  }
}

ensureEnvFile()
ensureLocalDirectories()

if (!fs.existsSync(path.join(repoRoot, "node_modules"))) {
  console.log("node_modules is missing. Installing dependencies first.")
  runNpm(["ci"])
}

runNpm(["run", "build"])

if (args.has("--migrate")) {
  runNpm(["run", "db:migrate"])
}

runNpm(["run", "mcp:config"])
if (installMcpClient) {
  runNpm(["run", "mcp:install", "--", "--client", installMcpClient])
}
const doctorStatus = runNpm(["run", "doctor"], { allowFailure: true })
printNextSteps(doctorStatus)
process.exit(doctorStatus)
