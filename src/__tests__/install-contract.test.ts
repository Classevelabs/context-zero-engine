/**
 * What the install promises, read from the scripts that carry it out: nothing for the reader to
 * edit before the engine runs, a database that can hold source code, and a client that starts
 * everything it needs. Each of these was a step people stopped at.
 */
import fs from "fs"
import path from "path"

const read = (relative: string) => fs.readFileSync(path.resolve(__dirname, "../..", relative), "utf8")

describe("install contract", () => {
  test("no placeholder password is written for the reader to replace", () => {
    expect(read("scripts/setup.mjs")).not.toMatch(/CHANGE_ME/)
    expect(read("scripts/doctor.mjs")).not.toMatch(/CHANGE_ME/)
  })

  test("the provisioned cluster and database are UTF-8, not the machine's code page", () => {
    const provisioner = read("scripts/lib/local-postgres.mjs")
    expect(provisioner).toContain('"-E", "UTF8"')
    expect(provisioner).toContain("ENCODING 'UTF8' TEMPLATE template0")
  })

  test("migrations stop on a database that cannot hold source code", () => {
    const migrate = read("db/migrate.ts")
    expect(migrate).toContain("SHOW server_encoding")
    expect(migrate).toMatch(/needs UTF8/)
  })

  test("an MCP client starts the launcher, which starts the database first", () => {
    expect(read("scripts/create-mcp-config.mjs")).toContain("launcherPath")
    const launcher = read("scripts/mcp-start.mjs")
    expect(launcher).toContain("dist/mcp-bridge/index.js")
    // Anything it prints on stdout would be read as an MCP message.
    expect(launcher).not.toMatch(/console\.log/)
  })
})
