/**
 * Unit tests for sandbox environment sanitization.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildSanitizedEnv, isRepositoryExecutionAllowed, sandboxExec } from "../transactional-editor/sandbox"

const ORIGINAL_ENV = process.env

describe("Sandbox environment", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      HOME: "/home/leaky-user",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      PYTHONPATH: "/secret/python",
      VIRTUAL_ENV: "/secret/venv",
      npm_config_cache: "/secret/npm-cache",
    }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  test("isolates host home and strips sensitive runtime variables", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-sandbox-test-"))
    const env = buildSanitizedEnv(cwd, { CUSTOM_VAR: "1" })

    expect(env["HOME"]).not.toBe("/home/leaky-user")
    expect(env["HOME"]).toContain("contextzero-sandbox")
    expect(env["npm_config_cache"]).toContain("contextzero-sandbox")
    expect(env["PYTHONPATH"]).toBeUndefined()
    expect(env["VIRTUAL_ENV"]).toBeUndefined()
    expect(env["CUSTOM_VAR"]).toBe("1")
    expect(fs.existsSync(env["HOME"]!)).toBe(true)
    expect(fs.existsSync(env["npm_config_cache"]!)).toBe(true)

    fs.rmSync(env["HOME"]!, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  test("strips dangerous extra environment variables case-insensitively", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-sandbox-test-"))
    const env = buildSanitizedEnv(cwd, {
      node_options: "--require ./attacker.js",
      Ld_PrElOaD: "/tmp/attacker.so",
      SAFE_VALUE: "kept",
    })

    expect(Object.keys(env).find((key) => key.toUpperCase() === "NODE_OPTIONS")).toBeUndefined()
    expect(Object.keys(env).find((key) => key.toUpperCase() === "LD_PRELOAD")).toBeUndefined()
    expect(env["SAFE_VALUE"]).toBe("kept")

    fs.rmSync(env["HOME"]!, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})

describe("Repository execution gate", () => {
  test("fails closed unless the operator explicitly opts in", () => {
    expect(isRepositoryExecutionAllowed({ NODE_ENV: "production" })).toBe(false)
    expect(
      isRepositoryExecutionAllowed({
        NODE_ENV: "production",
        SCG_ALLOW_UNSANDBOXED_EXECUTION: "true",
      }),
    ).toBe(true)
  })

  test("allows the isolated unit-test harness", () => {
    expect(isRepositoryExecutionAllowed({ NODE_ENV: "test" })).toBe(true)
  })

  test("rejects before an untrusted command can create a marker file", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-exec-gate-"))
    const marker = path.join(cwd, "spawned.txt")
    const previousNodeEnv = process.env["NODE_ENV"]
    const previousOptIn = process.env["SCG_ALLOW_UNSANDBOXED_EXECUTION"]
    process.env["NODE_ENV"] = "production"
    delete process.env["SCG_ALLOW_UNSANDBOXED_EXECUTION"]
    try {
      await expect(
        sandboxExec(process.execPath, ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], {
          cwd,
          timeoutMs: 5_000,
          maxOutputBytes: 1_024,
        }),
      ).rejects.toThrow("Repository command execution is disabled")
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      if (previousNodeEnv === undefined) delete process.env["NODE_ENV"]
      else process.env["NODE_ENV"] = previousNodeEnv
      if (previousOptIn === undefined) delete process.env["SCG_ALLOW_UNSANDBOXED_EXECUTION"]
      else process.env["SCG_ALLOW_UNSANDBOXED_EXECUTION"] = previousOptIn
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
