import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockQuery = jest.fn()
const mockTransaction = jest.fn()
const mockQueryWithClient = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    queryWithClient: (...args: unknown[]) => mockQueryWithClient(...args),
  },
}))

jest.mock("../analysis-engine/behavioral", () => ({ behavioralEngine: {} }))
jest.mock("../analysis-engine/contracts", () => ({ contractEngine: {} }))
jest.mock("../ingestor", () => ({ ingestor: {} }))

import { TransactionalChangeEngine } from "../transactional-editor"

interface BackupRow {
  file_path: string
  original_content: string | null
  original_mode: number | null
}

describe("TransactionalChangeEngine filesystem atomicity", () => {
  let repoRoot: string
  let state: string
  let backups: Map<string, BackupRow>
  let storedPatches: Array<{ file_path: string; new_content: string }>
  let transactionCount: number
  let beforeTransaction: ((count: number) => void | Promise<void>) | undefined
  let afterTransaction: ((count: number) => void | Promise<void>) | undefined

  const transactionRow = () => ({
    txn_id: "txn-001",
    repo_id: "repo-001",
    base_snapshot_id: "snap-001",
    created_by: "test",
    state,
    target_symbol_versions: [],
    patches: storedPatches,
    impact_report_ref: null,
    validation_report_ref: null,
    propagation_report_ref: null,
    created_at: new Date(),
    updated_at: new Date(),
  })

  beforeEach(() => {
    jest.restoreAllMocks()
    mockQuery.mockReset()
    mockTransaction.mockReset()
    mockQueryWithClient.mockReset()
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-atomicity-"))
    fs.mkdirSync(path.join(repoRoot, "src"))
    state = "planned"
    backups = new Map()
    storedPatches = []
    transactionCount = 0
    beforeTransaction = undefined
    afterTransaction = undefined

    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim()
        if (
          normalized.startsWith("SELECT state") &&
          normalized.includes("FROM change_transactions") &&
          normalized.includes("FOR UPDATE")
        ) {
          return { rows: [{ state, patches: storedPatches }], rowCount: 1 }
        }
        if (normalized.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 }
        if (normalized.includes("set_config('idle_in_transaction_session_timeout'")) {
          return { rows: [{}], rowCount: 1 }
        }
        if (normalized.startsWith("INSERT INTO transaction_file_backups")) {
          backups.set(String(params[2]), {
            file_path: String(params[2]),
            original_content: (params[3] as string | null) ?? null,
            original_mode: (params[4] as number | null) ?? null,
          })
          return { rows: [], rowCount: 1 }
        }
        if (normalized.startsWith("SELECT file_path") && normalized.includes("FROM transaction_file_backups")) {
          return { rows: [...backups.values()], rowCount: backups.size }
        }
        if (normalized.includes("SET patches = $1, state = 'patched'")) {
          storedPatches = JSON.parse(String(params[0]))
          state = "patched"
          return { rows: [], rowCount: 1 }
        }
        if (normalized.startsWith("UPDATE change_transactions SET state = $1")) {
          state = String(params[0])
          if (typeof params[2] === "string") storedPatches = JSON.parse(params[2])
          return { rows: [], rowCount: 1 }
        }
        if (normalized.includes("SET state = 'rolled_back'")) {
          state = "rolled_back"
          return { rows: [], rowCount: 1 }
        }
        if (normalized.startsWith("DELETE FROM transaction_file_backups")) {
          backups.clear()
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unexpected client SQL in test: ${normalized}`)
      }),
    }

    mockQueryWithClient.mockImplementation(
      (passedClient: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, sql: string, params?: unknown[]) =>
        passedClient.query(sql, params),
    )
    mockTransaction.mockImplementation(async (callback: (value: typeof client) => Promise<unknown>) => {
      transactionCount++
      const count = transactionCount
      await beforeTransaction?.(count)
      const result = await callback(client)
      await afterTransaction?.(count)
      return result
    })
    mockQuery.mockImplementation(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim()
      if (normalized.includes("FROM change_transactions WHERE txn_id")) {
        return { rows: [transactionRow()], rowCount: 1 }
      }
      if (normalized.includes("SELECT r.base_path")) {
        return { rows: [{ base_path: repoRoot }], rowCount: 1 }
      }
      throw new Error(`Unexpected pooled SQL in test: ${normalized}`)
    })
  })

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  })

  test("compensates earlier renames when a later file in the batch fails", async () => {
    const first = path.join(repoRoot, "src", "first.ts")
    const second = path.join(repoRoot, "src", "second.ts")
    fs.writeFileSync(first, "old-first")
    fs.writeFileSync(second, "old-second")

    const engine = new TransactionalChangeEngine()
    const originalEnsure = (engine as any).ensureSafeParent.bind(engine)
    let ensureCalls = 0
    jest.spyOn(engine as any, "ensureSafeParent").mockImplementation(async (...args: unknown[]) => {
      ensureCalls++
      if (ensureCalls === 4) throw new Error("simulated second rename failure")
      return originalEnsure(...args)
    })

    await expect(
      engine.applyPatch(
        "txn-001",
        [
          { file_path: "src/first.ts", new_content: "new-first" },
          { file_path: "src/second.ts", new_content: "new-second" },
        ],
        repoRoot,
      ),
    ).rejects.toThrow("simulated second rename failure")

    expect(fs.readFileSync(first, "utf8")).toBe("old-first")
    expect(fs.readFileSync(second, "utf8")).toBe("old-second")
    expect(state).toBe("failed")
    expect(backups.size).toBe(2)
    expect(fs.readdirSync(path.join(repoRoot, "src")).filter((name) => name.includes(".scg-"))).toEqual([])
  })

  test("rejects a concurrent edit made between durable backup and file write", async () => {
    const target = path.join(repoRoot, "src", "target.ts")
    fs.writeFileSync(target, "original")
    afterTransaction = (count) => {
      if (count === 1) fs.writeFileSync(target, "external-edit")
    }

    const engine = new TransactionalChangeEngine()
    await expect(
      engine.applyPatch(
        "txn-001",
        [{ file_path: "src/target.ts", new_content: "our-edit" }],
        repoRoot,
      ),
    ).rejects.toThrow("Patch conflict")

    expect(fs.readFileSync(target, "utf8")).toBe("external-edit")
    expect(state).toBe("rolled_back")
    expect(backups.size).toBe(0)
  })

  test("preserves executable file permissions across atomic replacement", async () => {
    if (process.platform === "win32") return
    const target = path.join(repoRoot, "src", "tool.sh")
    fs.writeFileSync(target, "old")
    fs.chmodSync(target, 0o755)

    const engine = new TransactionalChangeEngine()
    await engine.applyPatch(
      "txn-001",
      [{ file_path: "src/tool.sh", new_content: "new" }],
      repoRoot,
    )

    expect(fs.readFileSync(target, "utf8")).toBe("new")
    expect(fs.statSync(target).mode & 0o777).toBe(0o755)
    expect(backups.get("src/tool.sh")?.original_mode).toBe(0o755)
  })

  test("rejects case-variant duplicate targets on case-insensitive filesystems", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      const engine = new TransactionalChangeEngine()
      await expect(
        (engine as any).preparePatches(repoRoot, [
          { file_path: "src/Target.ts", new_content: "first" },
          { file_path: "src/target.ts", new_content: "second" },
        ]),
      ).rejects.toThrow("Duplicate patch target")
    } finally {
      if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor)
    }
  })

  test("detects a parent symlink swap before creating missing directories", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-outside-"))
    try {
      const engine = new TransactionalChangeEngine()
      const [prepared] = await (engine as any).preparePatches(repoRoot, [
        { file_path: "src/nested/target.ts", new_content: "content" },
      ])
      fs.rmSync(path.join(repoRoot, "src"), { recursive: true })
      fs.symlinkSync(outside, path.join(repoRoot, "src"), process.platform === "win32" ? "junction" : "dir")

      await expect(
        (engine as any).ensureSafeParent(repoRoot, prepared.filePath, prepared.fullPath),
      ).rejects.toThrow(/symlink escape|changed during validation/)
      expect(fs.existsSync(path.join(outside, "nested"))).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  test("rechecks the locked row before rollback and never restores a committed transaction", async () => {
    const target = path.join(repoRoot, "src", "target.ts")
    fs.writeFileSync(target, "committed-content")
    state = "patched"
    backups.set("src/target.ts", {
      file_path: "src/target.ts",
      original_content: "old-content",
      original_mode: 0o600,
    })
    beforeTransaction = () => {
      state = "committed"
    }

    const engine = new TransactionalChangeEngine()
    await expect(engine.rollback("txn-001")).rejects.toThrow("Cannot rollback transaction")

    expect(fs.readFileSync(target, "utf8")).toBe("committed-content")
    expect(backups.size).toBe(1)
  })

  test("rollback preserves an external edit that matches neither original nor patch", async () => {
    const target = path.join(repoRoot, "src", "target.ts")
    fs.writeFileSync(target, "external-edit")
    state = "failed"
    storedPatches = [{ file_path: "src/target.ts", new_content: "transaction-edit" }]
    backups.set("src/target.ts", {
      file_path: "src/target.ts",
      original_content: "original",
      original_mode: 0o600,
    })

    const engine = new TransactionalChangeEngine()
    await expect(engine.rollback("txn-001")).rejects.toThrow("Rollback incomplete")

    expect(fs.readFileSync(target, "utf8")).toBe("external-edit")
    expect(state).toBe("failed")
    expect(backups.size).toBe(1)
  })
})
