import * as fs from "fs"
import * as path from "path"

// In a Python class body the last definition of a name wins silently. The
// extractor carried two dead copies of two methods — the first
// `_extract_contract_hint` and `_collect_raised_exceptions` were never called
// — and an edit to either dead copy changed nothing while reading as a fix.
describe("the Python extractor defines each class-level method once", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../adapters/py/extractor.py"), "utf8")

  test("no class-level method name is defined twice", () => {
    const seen = new Map<string, number>()
    const duplicates: string[] = []
    let currentClass: string | null = null
    source.split("\n").forEach((line, index) => {
      const cls = line.match(/^class (\w+)/)
      if (cls) {
        currentClass = cls[1]!
        seen.clear()
        return
      }
      const method = line.match(/^    def (\w+)\(/)
      if (!method || !currentClass) return
      const name = `${currentClass}.${method[1]}`
      if (seen.has(name)) duplicates.push(`${name} at lines ${seen.get(name)} and ${index + 1}`)
      else seen.set(name, index + 1)
    })
    expect(duplicates).toEqual([])
  })
})
