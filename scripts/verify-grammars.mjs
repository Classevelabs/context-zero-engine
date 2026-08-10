/**
 * Assert every tree-sitter grammar actually loaded.
 *
 * The grammars are native addons. They were hard `dependencies`, which meant a
 * platform without prebuilt binaries — Windows, where most Claude Desktop users
 * are — had `npm ci` fail outright on a source build that needs Visual Studio.
 * The whole engine was uninstallable there because one language grammar could
 * not compile.
 *
 * They are `optionalDependencies` now, so an install succeeds with whatever
 * builds and getGrammar() reports a clear per-language error for anything
 * missing. That is the right trade for a user, and a silent trap for a release:
 * "optional" must never quietly become "absent" on the platform we build and
 * verify on.
 *
 * So this runs where the grammars are expected to be complete and fails if any
 * is not loadable. Windows degrades; Linux does not get to.
 *
 * Run: node scripts/verify-grammars.mjs
 */
import { createRequire } from "module"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const expected = Object.keys(pkg.optionalDependencies || {})
  .filter((name) => name.startsWith("tree-sitter-"))
  .sort()

if (expected.length === 0) {
  console.error("no tree-sitter grammars declared — expected the optionalDependencies block to list them")
  process.exit(1)
}

let missing = 0
for (const name of expected) {
  try {
    const grammar = require(name)
    if (!grammar) throw new Error("module resolved to a falsy value")
    console.log(`  ok      ${name}`)
  } catch (error) {
    missing++
    console.error(`  MISSING ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${expected.length - missing}/${expected.length} grammars loadable`)

if (missing > 0) {
  console.error(
    "\nOne or more grammars did not load on a platform where all of them are expected.\n" +
      "They are optional so that installs survive a platform without prebuilds — not so that\n" +
      "a release can quietly ship without the languages it claims to parse.",
  )
  process.exit(1)
}
