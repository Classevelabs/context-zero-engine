const mockParse = jest.fn()

jest.mock("tree-sitter", () =>
  class MockParser {
    setLanguage(): void {}
    parse(source: string): unknown {
      return mockParse(source)
    }
  },
)

jest.mock("tree-sitter-go", () => ({}), { virtual: true })
jest.mock("../logger", () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    startTimer: jest.fn().mockReturnValue(jest.fn()),
  })),
}))

import { extractWithTreeSitter } from "../adapters/universal"

describe("universal adapter parser bounds", () => {
  beforeEach(() => mockParse.mockReset())

  test("rejects oversized source before invoking the parser", () => {
    const result = extractWithTreeSitter("large.go", "x".repeat(5 * 1024 * 1024 + 1), "go")

    expect(result).toMatchObject({ symbols: [], parse_confidence: 0, uncertainty_flags: ["source_too_large"] })
    expect(mockParse).not.toHaveBeenCalled()
  })

  test("rejects an excessive parse tree before recursive walkers", () => {
    mockParse.mockReturnValue({ rootNode: { descendantCount: 1_000_001 } })

    const result = extractWithTreeSitter("dense.go", "package main", "go")

    expect(result).toMatchObject({ symbols: [], parse_confidence: 0, uncertainty_flags: ["parse_tree_too_large"] })
    expect(mockParse).toHaveBeenCalledTimes(1)
  })
})
