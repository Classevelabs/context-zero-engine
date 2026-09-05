import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { loadEnvFile } from "../load-env"

// The installer points CONTEXTZERO_ENV_FILE at an install-specific .env, so
// that path is the whole configuration. Both config modules used to load it
// quietly and discard the result: a path that did not resolve produced no error
// and no log line, and the process failed later with "SASL: client password
// must be a string", which named neither the file nor that it was never read.
describe("loadEnvFile", () => {
  const ORIGINAL_ENV = process.env
  let tempDir: string

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env["CONTEXTZERO_ENV_FILE"]
    delete process.env["CZ_TEST_LOADED_VALUE"]
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-env-"))
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test("an explicit file that does not exist fails at startup and names the file", () => {
    const missing = path.join(tempDir, "does-not-exist.env")
    process.env["CONTEXTZERO_ENV_FILE"] = missing

    expect(() => loadEnvFile()).toThrow(missing)
    expect(() => loadEnvFile()).toThrow("CONTEXTZERO_ENV_FILE")
  })

  test("an explicit file that exists is loaded and overrides the ambient value", () => {
    const file = path.join(tempDir, "install.env")
    fs.writeFileSync(file, "CZ_TEST_LOADED_VALUE=from-file\n", "utf8")
    process.env["CONTEXTZERO_ENV_FILE"] = file
    // The installer's file is chosen deliberately; a stale ambient value must
    // not win over it.
    process.env["CZ_TEST_LOADED_VALUE"] = "ambient"

    loadEnvFile()

    expect(process.env["CZ_TEST_LOADED_VALUE"]).toBe("from-file")
  })

  test("an explicit path to a directory is a read error, not a silent no-op", () => {
    process.env["CONTEXTZERO_ENV_FILE"] = tempDir

    expect(() => loadEnvFile()).toThrow(/could not be read|does not exist/)
  })

  test("with no explicit file, an absent .env is permitted — Docker supplies the environment", () => {
    const cwd = process.cwd()
    process.chdir(tempDir)
    try {
      expect(() => loadEnvFile()).not.toThrow()
    } finally {
      process.chdir(cwd)
    }
  })
})
