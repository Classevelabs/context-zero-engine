/**
 * Tests for the search scan core and its execution bound.
 *
 * These run against a real temporary directory — no fs mocks — because the
 * thing under test is partly the interaction with the filesystem and partly
 * the containment of a runaway regex, and neither survives being mocked.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Worker } from "worker_threads"
import { scanFiles, type ScanParams } from "../services/search-scan"

let tempRoot: string

function write(relPath: string, content: string): void {
  const full = path.join(tempRoot, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
}

function params(overrides: Partial<ScanParams> = {}): ScanParams {
  return {
    realBase: fs.realpathSync(tempRoot),
    files: [],
    patternSource: "needle",
    patternFlags: "gi",
    maxResults: 30,
    contextLines: 2,
    deadlineMs: 5_000,
    ...overrides,
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-scan-"))
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe("scanFiles", () => {
  test("finds matches with surrounding context", async () => {
    write("src/a.ts", ["const x = 1", "const needle = 2", "const y = 3"].join("\n"))

    const result = await scanFiles(params({ files: ["src/a.ts"] }))

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.file).toBe("src/a.ts")
    expect(result.matches[0]!.line).toBe(2)
    expect(result.matches[0]!.context).toContain("> 2: const needle = 2")
    expect(result.matches[0]!.context).toContain("  1: const x = 1")
    expect(result.timedOut).toBe(false)
  })

  test("stops at maxResults", async () => {
    write("src/many.ts", Array.from({ length: 40 }, () => "needle").join("\n"))

    const result = await scanFiles(params({ files: ["src/many.ts"], maxResults: 5 }))

    expect(result.matches).toHaveLength(5)
  })

  test("skips unreadable files and reports them instead of failing the scan", async () => {
    write("src/real.ts", "needle")
    const unreadable: string[] = []

    const result = await scanFiles(params({ files: ["src/missing.ts", "src/real.ts"] }), (file) =>
      unreadable.push(file),
    )

    expect(result.matches).toHaveLength(1)
    expect(unreadable).toEqual(["src/missing.ts"])
  })

  test("refuses a post-index replacement larger than the scan read bound", async () => {
    write("src/replaced.ts", "x".repeat(2 * 1024 * 1024 + 1) + "needle")
    const errors: string[] = []

    const result = await scanFiles(params({ files: ["src/replaced.ts"] }), (_file, error) => errors.push(error))

    expect(result.matches).toHaveLength(0)
    expect(errors).toEqual(["indexed file exceeds search size limit"])
  })

  test("refuses to read outside the repository root", async () => {
    // A traversal path must be rejected by path containment, surfaced through
    // the unreadable callback rather than silently reading the file.
    const outside = path.join(os.tmpdir(), `contextzero-outside-${process.pid}.txt`)
    fs.writeFileSync(outside, "needle", "utf-8")
    const errors: string[] = []

    try {
      const result = await scanFiles(params({ files: [`../${path.basename(outside)}`] }), (_f, e) => errors.push(e))

      expect(result.matches).toHaveLength(0)
      expect(errors[0]).toMatch(/Path traversal attempt blocked/)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  test("honours its deadline between batches and reports partial results", async () => {
    // Non-matching content, so the scan runs to the deadline rather than
    // stopping early on maxResults. With the budget already spent, the batch
    // boundary check must stop it well short of all 300 files.
    for (let i = 0; i < 300; i++) write(`src/f${i}.ts`, "haystack")
    const files = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`)

    const result = await scanFiles(params({ files, deadlineMs: 0 }))

    expect(result.timedOut).toBe(true)
    expect(result.matches).toHaveLength(0)
    expect(result.filesScanned).toBeLessThan(300)
  })

  test("scans every file when the budget is ample", async () => {
    for (let i = 0; i < 120; i++) write(`src/f${i}.ts`, i === 119 ? "needle" : "haystack")
    const files = Array.from({ length: 120 }, (_, i) => `src/f${i}.ts`)

    const result = await scanFiles(params({ files, deadlineMs: 30_000 }))

    expect(result.timedOut).toBe(false)
    expect(result.filesScanned).toBe(120)
    expect(result.matches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Execution bound.
//
// A regex that backtracks catastrophically never yields to the event loop, so
// scanFiles' own between-batch deadline check can never run — the only hard
// bound is to run the match on a thread the parent can terminate. That is what
// search-service does in a built install.
//
// Worker threads load JavaScript only, so this needs the compiled worker. CI
// builds before running tests; a bare `npx jest` from source will skip.
// ---------------------------------------------------------------------------

const compiledWorker = path.resolve(__dirname, "..", "..", "dist", "services", "search-worker.js")
const workerAvailable = fs.existsSync(compiledWorker)
const describeWorker = workerAvailable ? describe : describe.skip

describeWorker("search worker containment", () => {
  /** No groups, so the static ReDoS detector cannot see it — the residual case. */
  const CATASTROPHIC = "a*".repeat(24) + "$"

  function runWorker(scanParams: ScanParams, killAfterMs: number | null): Promise<{ msg: unknown; ms: number }> {
    const started = Date.now()
    const worker = new Worker(compiledWorker, { workerData: scanParams })
    return new Promise((resolve) => {
      let settled = false
      const done = (msg: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve({ msg, ms: Date.now() - started })
      }
      const timer = setTimeout(
        () => done({ killed: true }),
        killAfterMs === null ? 8_000 : killAfterMs,
      )
      worker.on("message", done)
      worker.on("error", () => done({ error: true }))
    })
  }

  test("an adversarial line runs past the scan's own deadline", async () => {
    write("payload.txt", "a".repeat(400) + "!")

    // Deadline of 500ms, but we wait 8s: the scan cannot self-terminate here,
    // because control never returns from RegExp.test.
    const { msg } = await runWorker(
      params({ files: ["payload.txt"], patternSource: CATASTROPHIC, deadlineMs: 500 }),
      null,
    )

    expect(msg).toEqual({ killed: true })
  }, 20_000)

  test("terminating the worker bounds it, and the main thread keeps running", async () => {
    write("payload.txt", "a".repeat(400) + "!")

    const tick = Date.now()
    let timerFired = -1
    const timerCheck = new Promise<void>((r) =>
      setTimeout(() => {
        timerFired = Date.now() - tick
        r()
      }, 100),
    )

    const { msg, ms } = await runWorker(
      params({ files: ["payload.txt"], patternSource: CATASTROPHIC, deadlineMs: 1_000 }),
      1_250,
    )
    await timerCheck

    expect(msg).toEqual({ killed: true })
    expect(ms).toBeLessThan(5_000)
    // The main thread was never blocked — a 100ms timer fired roughly on time.
    expect(timerFired).toBeGreaterThanOrEqual(0)
    expect(timerFired).toBeLessThan(1_000)
  }, 20_000)

  test("a normal pattern still returns real results through the worker", async () => {
    write("src/a.ts", ["const x = 1", "const needle = 2"].join("\n"))

    const { msg } = await runWorker(params({ files: ["src/a.ts"], patternSource: "needle" }), null)

    expect(msg).toMatchObject({ type: "done", timedOut: false })
    expect((msg as { matches: unknown[] }).matches).toHaveLength(1)
  }, 20_000)
})

if (!workerAvailable) {
  // Make the gap visible rather than silently reporting a green suite.
  // eslint-disable-next-line no-console
  console.warn(
    `[search-scan.test] Skipping worker containment tests — ${compiledWorker} not found. Run "npm run build" first.`,
  )
}
