/**
 * Guards the type-resolved effect analyzer against regression using the same
 * hand-labeled fixture suite scripts/effect-eval.ts measures. If this fails,
 * the numbers published in BENCHMARKS.md are stale — re-run the eval.
 */
import * as fs from "fs"
import * as path from "path"

jest.mock("../db-driver", () => ({
  db: {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    batchInsert: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("../db-driver/core_data", () => ({
  coreDataService: { upsertBehavioralProfile: jest.fn(), insertContractProfile: jest.fn() },
}))

import { extractFromTypeScript } from "../adapters/ts/index"
import type { BehaviorHint } from "../types"

const FIXTURE_DIR = path.join(__dirname, "fixtures", "effect-eval")
const SCORED = new Set([
  "db_read",
  "db_write",
  "network_call",
  "file_io",
  "cache_op",
  "transaction",
  "concurrency",
  "auth_check",
])

describe("type-resolved effect analysis (ground-truth fixtures)", () => {
  test("matches the labeled expectations exactly", async () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf-8")) as Record<
      string,
      string[]
    >
    const fixtureFiles = fs
      .readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(FIXTURE_DIR, f))

    const result = await extractFromTypeScript(fixtureFiles)

    const predicted = new Map<string, Set<string>>()
    for (const hint of result.behavior_hints as BehaviorHint[]) {
      if (!SCORED.has(hint.hint_type)) continue
      const hashIdx = hint.symbol_key.lastIndexOf("#")
      const key = `${path.basename(hint.symbol_key.slice(0, hashIdx))}#${hint.symbol_key.slice(hashIdx + 1)}`
      const set = predicted.get(key) ?? new Set<string>()
      set.add(hint.hint_type)
      predicted.set(key, set)
    }

    const mismatches: string[] = []
    for (const [fnKey, expectedCats] of Object.entries(expected)) {
      if (fnKey.startsWith("_")) continue
      const got = predicted.get(fnKey) ?? new Set<string>()
      const exp = new Set(expectedCats)
      const same = got.size === exp.size && [...exp].every((c) => got.has(c))
      if (!same) {
        mismatches.push(`${fnKey}: expected [${[...exp].join(",")}] got [${[...got].join(",")}]`)
      }
    }

    expect(mismatches).toEqual([])
  }, 60_000)
})
