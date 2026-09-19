// Jest re-evaluates tree-sitter's wrapper in every test file but loads its native addon once per
// worker; a second evaluation reads back the first one's prototype patches and parses rootless trees.
/* eslint-disable @typescript-eslint/no-require-imports */
import * as path from "path"

const dir = path.dirname(require.resolve("tree-sitter/package.json"))
const addon: Record<symbol, unknown> = require(require.resolve("node-gyp-build", { paths: [dir] }))(dir)
const wrapper = Symbol.for("contextzero.tree-sitter.wrapper")
addon[wrapper] ??= require(path.join(dir, "index.js"))

export = addon[wrapper]
