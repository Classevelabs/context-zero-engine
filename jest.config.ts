import type { Config } from "jest"

const config: Config = {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  // uuid v13+ ships ESM — mock it for CJS compatibility in tests
  moduleNameMapper: {
    "^uuid$": "<rootDir>/src/__tests__/__mocks__/uuid.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**", "!src/mcp-interface/index.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov"],
  coverageThreshold: {
    global: {
      branches: 32,
      functions: 52,
      lines: 44,
      statements: 43,
    },
  },
  setupFiles: [],
  testTimeout: 10000,
  // Runs the tree-sitter-memory-sensitive files (workspace symbol search) on a
  // fresh worker before a heavy parser can share the process — see
  // jest.sequencer.js.
  testSequencer: "<rootDir>/jest.sequencer.js",
}

export default config
