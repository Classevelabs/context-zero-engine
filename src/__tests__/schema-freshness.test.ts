import * as fs from "fs"
import * as path from "path"

// db/schema.sql is generated from db/migrations/*.sql and shipped in the
// package as the one-file view of the schema. Nothing regenerated it when a
// migration was added: 026 landed with the schema file still ending at 025, so
// the reference document disagreed with the database every install actually
// gets. A stale file is worse than none — it reads as authoritative.
describe("db/schema.sql is generated from the current migrations", () => {
  const migrationsDir = path.resolve(__dirname, "../../db/migrations")
  const schema = fs.readFileSync(path.resolve(__dirname, "../../db/schema.sql"), "utf8")
  const migrations = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()

  test("every migration appears in the generated schema, in order", () => {
    let cursor = 0
    for (const file of migrations) {
      const marker = `-- >>> ${file}`
      const at = schema.indexOf(marker, cursor)
      expect(at === -1 ? `${file} missing from db/schema.sql — run npm run db:generate-schema` : file).toBe(file)
      cursor = at
    }
  })

  test("the schema carries no migration that no longer exists", () => {
    const listed = [...schema.matchAll(/^-- >>> (\d{3}_[a-z0-9_]+\.sql)$/gm)].map((m) => m[1])
    expect(listed).toEqual(migrations)
  })
})
