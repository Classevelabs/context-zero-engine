import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const npmCli = (process.env.npm_execpath || "").trim()
if (!npmCli || !fs.existsSync(npmCli)) {
  console.error("npm CLI path is unavailable; run this check through `npm run package:verify`.")
  process.exit(1)
}

const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
  shell: false,
})
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout)
  process.exit(result.status ?? 1)
}

// npm <=11 reports an array of packed tarballs; npm 12 reports an object keyed
// by package name. Read both, or this gate crashes on the newer client and
// reads as a broken package boundary when the boundary is intact.
let report
try {
  const parsed = JSON.parse(result.stdout)
  report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
} catch {
  console.error("Unable to parse npm pack JSON output.")
  process.stderr.write(result.stdout)
  process.exit(1)
}
if (!report || !Array.isArray(report.files)) {
  console.error("npm pack JSON carried no file list; cannot verify the package boundary.")
  process.stderr.write(result.stdout)
  process.exit(1)
}

const files = new Set(report.files.map((entry) => entry.path.replaceAll("\\", "/")))
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "dist/mcp-interface/index.js",
  "dist/mcp-bridge/index.js",
  "dist/adapters/py/extractor.py",
  "db/schema.sql",
  "scripts/doctor.mjs",
]
const missing = required.filter((file) => !files.has(file))
const forbiddenPrefixes = ["src/", "coverage/", ".github/", ".contextzero/"]
const forbidden = [...files].filter(
  (file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) || file === ".env",
)

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) console.error(`Package is missing required files: ${missing.join(", ")}`)
  if (forbidden.length > 0) console.error(`Package contains internal files: ${forbidden.join(", ")}`)
  process.exit(1)
}

const MAX_PACKED_BYTES = 4 * 1024 * 1024
if (report.size > MAX_PACKED_BYTES) {
  console.error(`Packed artifact is unexpectedly large: ${report.size} bytes (limit ${MAX_PACKED_BYTES}).`)
  process.exit(1)
}

console.log(
  JSON.stringify({
    filename: report.filename,
    files: report.entryCount,
    packed_bytes: report.size,
    unpacked_bytes: report.unpackedSize,
  }),
)
