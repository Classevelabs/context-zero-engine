/**
 * Unit tests for database connection config hardening.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const ORIGINAL_ENV = process.env

describe("Database config", () => {
  beforeEach(() => {
    jest.resetModules()
    process.env = { ...ORIGINAL_ENV }
    // Empty string prevents dotenv from re-injecting local .env secrets
    // while still exercising the "missing password" config path.
    process.env["DB_PASSWORD"] = ""
    process.env["PGPASSWORD"] = ""
    process.env["CONTEXTZERO_ENV_FILE"] = ""
    // Set API keys to empty to prevent the key-entropy check from interfering
    // with DB-config-focused tests. Using empty string (not delete) because
    // dotenv.config() would re-populate from .env if the var is absent.
    process.env["SCG_API_KEYS"] = ""
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  afterEach(() => {
    jest.dontMock("dotenv")
  })

  test("loads dotenv quietly to preserve stdio transports", async () => {
    jest.resetModules()
    const configMock = jest.fn()
    jest.doMock("dotenv", () => ({
      __esModule: true,
      config: configMock,
    }))

    await import("../db-driver/config")

    expect(configMock).toHaveBeenCalledWith({ quiet: true })
  })

  test("loads explicit CONTEXTZERO_ENV_FILE and overrides inherited DB env", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-env-file-"))
    const envFile = path.join(tempDir, ".env")
    fs.writeFileSync(
      envFile,
      [
        "DB_HOST=env-file-host",
        "DB_PORT=6543",
        "DB_NAME=env_file_db",
        "DB_USER=env_file_user",
        "DB_PASSWORD=env-file-password",
        "",
      ].join("\n"),
    )

    process.env["CONTEXTZERO_ENV_FILE"] = envFile
    process.env["DB_HOST"] = "inherited-host"
    process.env["DB_PASSWORD"] = "inherited-password"

    const { getConnectionConfig } = await import("../db-driver/config")
    const config = getConnectionConfig()
    expect(config.host).toBe("env-file-host")
    expect(config.port).toBe(6543)
    expect(config.database).toBe("env_file_db")
    expect(config.user).toBe("env_file_user")
    expect(config.password).toBe("env-file-password")
  })

  test("allows empty password outside production", async () => {
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(getConnectionConfig().password).toBe("")
  })

  test("does not partially parse malformed database ports", async () => {
    process.env["DB_PORT"] = "6543garbage"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(getConnectionConfig().port).toBe(5432)
  })

  test("rejects database ports outside the TCP range", async () => {
    process.env["DB_PORT"] = "70000"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(() => getConnectionConfig()).toThrow("port is out of range")
  })

  test("rejects missing password in production", async () => {
    process.env["NODE_ENV"] = "production"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(() => getConnectionConfig()).toThrow("DB_PASSWORD")
  })

  test("rejects insecure production passwords", async () => {
    process.env["NODE_ENV"] = "production"
    process.env["DB_PASSWORD"] = "postgres"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(() => getConnectionConfig()).toThrow("insecure database password")
  })

  test("accepts explicit secure password in production", async () => {
    process.env["NODE_ENV"] = "production"
    process.env["DB_PASSWORD"] = "s3cure-prod-password"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(getConnectionConfig().password).toBe("s3cure-prod-password")
  })

  test("rejects remote production database without SSL by default", async () => {
    process.env["NODE_ENV"] = "production"
    process.env["DB_HOST"] = "postgres"
    process.env["DB_PASSWORD"] = "s3cure-prod-password"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(() => getConnectionConfig()).toThrow("remote database without SSL")
  })

  test("allows explicit private-network SSL opt-out for container deployments", async () => {
    process.env["NODE_ENV"] = "production"
    process.env["DB_HOST"] = "postgres"
    process.env["DB_PASSWORD"] = "s3cure-prod-password"
    process.env["DB_SSL_ALLOW_INSECURE_PRIVATE_NETWORK"] = "true"
    const { getConnectionConfig } = await import("../db-driver/config")
    expect(getConnectionConfig().ssl).toBe(false)
  })
})
