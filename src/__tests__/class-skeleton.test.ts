/**
 * A class that would take more than a third of the budget ships as its
 * header, one signature line per member, and the closing brace; the member
 * bodies stay behind fetch handles.
 */

jest.mock("../db-driver", () => ({ db: { query: jest.fn(), batchInsert: jest.fn(), transaction: jest.fn() } }))
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), startTimer: () => () => {} })),
}))

import { classSkeleton } from "../analysis-engine/capsule-compiler"

const code = [
  "export class Cart {", // line 10
  "  private items: Item[] = []", // 11
  "", // 12
  "  add(item: Item): void {", // 13
  "    this.items.push(item)",
  "  }", // 15
  "", // 16
  "  total(): number {", // 17
  "    return this.items.reduce((a, i) => a + i.price, 0)",
  "  }", // 19
  "}", // 20
].join("\n")

const member = (name: string, start: number, end: number, signature: string) => ({
  symbol_version_id: `sv-${name}`,
  symbol_id: `id-${name}`,
  canonical_name: name,
  kind: "method",
  signature,
  range_start_line: start,
  range_end_line: end,
  byte_length: 40,
})

describe("classSkeleton", () => {
  test("keeps the header up to the first member, one line per member, and the closing brace", () => {
    const out = classSkeleton(code, 10, [member("add", 13, 15, "add(item: Item): void"), member("total", 17, 19, "total(): number")])
    const lines = out.split("\n")
    expect(lines[0]).toBe("export class Cart {")
    expect(lines[1]).toBe("  private items: Item[] = []")
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}add\(item: Item\): void {2}\/\/ method, lines 13-15, body by fetch handle$/))
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}total\(\): number {2}\/\/ method/))
    expect(lines[lines.length - 1]).toBe("}")
    expect(out).not.toContain("this.items.push")
    expect(out.length).toBeLessThan(code.length)
  })

  test("caps the header at eight lines and takes only a signature's first line", () => {
    const longHeader = Array.from({ length: 12 }, (_, i) => `// header ${i}`).join("\n") + "\n" + code
    const out = classSkeleton(longHeader, 1, [member("add", 25, 27, "add(\n  item: Item\n): void")])
    const lines = out.split("\n")
    expect(lines.slice(0, 8).every((l) => l.startsWith("// header"))).toBe(true)
    expect(lines[8]).toMatch(/^ {2}add\( {2}\/\/ method/)
  })
})
