import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockWatch = jest.fn()

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  watch: (...args: unknown[]) => mockWatch(...args),
}))

const mockQuery = jest.fn()
const mockTryAdvisoryLock = jest.fn()
const mockIngestIncremental = jest.fn()

jest.mock("../db-driver", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    tryAdvisoryLock: (...args: unknown[]) => mockTryAdvisoryLock(...args),
  },
}))

jest.mock("../ingestor", () => {
  const actual = jest.requireActual("../ingestor")
  return {
    LANGUAGE_MAP: actual.LANGUAGE_MAP,
    SKIP_DIRS: actual.SKIP_DIRS,
    ingestor: { ingestIncremental: (...args: unknown[]) => mockIngestIncremental(...args) },
  }
})

jest.mock("../incremental-target", () => ({
  resolveLatestIndexedSnapshot: jest.fn(async () => "snap-001"),
  toRepoRelativePaths: jest.fn((_base: string, paths: string[]) => paths),
}))

import { isIndexablePath, Watcher } from "../watcher"

describe("isIndexablePath", () => {
  test("accepts source files the ingestor has an adapter for", () => {
    expect(isIndexablePath("src/app.ts")).toBe(true)
    expect(isIndexablePath("lib/handler.py")).toBe(true)
    expect(isIndexablePath("cmd/main.go")).toBe(true)
  })

  test("rejects files with no adapter, so a batch never carries unparseable paths", () => {
    expect(isIndexablePath("README.md")).toBe(false)
    expect(isIndexablePath("assets/logo.png")).toBe(false)
    expect(isIndexablePath("data/rows.csv")).toBe(false)
  })

  test("rejects paths inside skipped directories", () => {
    // node_modules churns constantly; watching it would drown every real edit.
    expect(isIndexablePath("node_modules/left-pad/index.js")).toBe(false)
    expect(isIndexablePath(".git/hooks/pre-commit.py")).toBe(false)
    expect(isIndexablePath("dist/bundle.js")).toBe(false)
    expect(isIndexablePath("src/.hidden/secret.ts")).toBe(false)
  })

  test("rejects dotfiles but not dotted extensions", () => {
    expect(isIndexablePath(".eslintrc.js")).toBe(false)
    expect(isIndexablePath("src/component.test.ts")).toBe(true)
  })

  test("treats Windows and POSIX separators alike", () => {
    expect(isIndexablePath("src\\app.ts")).toBe(true)
    expect(isIndexablePath("node_modules\\pkg\\index.ts")).toBe(false)
  })

  test("shares its rules with the ingestor rather than copying them", () => {
    // A private copy drifts silently the moment either list changes.
    const ingestorModule = jest.requireActual("../ingestor")
    expect(ingestorModule.SKIP_DIRS.has("node_modules")).toBe(true)
    expect(ingestorModule.LANGUAGE_MAP[".ts"]).toBe("typescript")
  })
})

describe("Watcher", () => {
  let tempRoot: string
  let release: jest.Mock
  let emit: ((filename: string) => void) | null

  /**
   * Drive the debounce forward without waiting on a clock.
   *
   * These tests used to write a real file and sleep past the debounce, which
   * meant they were really waiting on recursive fs.watch to deliver an OS event
   * — latency that is not bounded and stretches under parallel load, where this
   * suite ran 5.7s against 2.0s alone. The wait was sized for the debounce it
   * was named after (30ms) but had to be an order of magnitude longer (250ms)
   * to cover the event, and it still raced.
   *
   * Injecting the change through the captured fs.watch callback removes the OS
   * from the loop, so what each test asserts is the debounce, coalescing and
   * retry behaviour itself, at whatever speed the machine happens to run.
   */
  const advance = async (ms: number): Promise<void> => {
    await jest.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contextzero-watch-"))
    fs.mkdirSync(path.join(tempRoot, "src"), { recursive: true })

    emit = null
    // Capture the change callback instead of subscribing to the filesystem.
    // start() still calls fs.existsSync on the real temp directory, so the
    // path-presence check keeps its meaning.
    mockWatch.mockImplementation(
      (_target: unknown, _options: unknown, listener: (event: string, filename: string) => void) => {
        emit = (filename: string) => listener("change", filename)
        return { on: jest.fn(), close: jest.fn() }
      },
    )

    release = jest.fn(async () => {})
    mockTryAdvisoryLock.mockResolvedValue({ release })
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repositories")) {
        return { rows: [{ repo_id: "repo-001", name: "demo", base_path: tempRoot }] }
      }
      return { rows: [] }
    })
    mockIngestIncremental.mockResolvedValue({
      symbolsUpdated: 3,
      relationsUpdated: 5,
      files_failed: 0,
      failed_paths: [],
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  test("subscribes to the whole repository in one recursive watch", async () => {
    // The OS subscription is the one thing the injected callback cannot check,
    // so assert its shape directly: one recursive watch per repository, rather
    // than a periodic walk or a watch per directory.
    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0 })
    await watcher.start()

    expect(mockWatch).toHaveBeenCalledTimes(1)
    const [target, options] = mockWatch.mock.calls[0] as [string, { recursive: boolean }]
    expect(target).toBe(tempRoot)
    expect(options.recursive).toBe(true)

    await watcher.stop()
  })

  test("indexes a batch after the debounce window", async () => {
    const batches: unknown[] = []
    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0, onBatch: (b) => batches.push(b) })
    const watched = await watcher.start()
    expect(watched).toHaveLength(1)

    emit!("src/app.ts")
    // Nothing may run before the window closes, or a burst would be indexed
    // file by file.
    expect(mockIngestIncremental).not.toHaveBeenCalled()

    await advance(30)

    expect(mockIngestIncremental).toHaveBeenCalled()
    const [, , paths, options] = mockIngestIncremental.mock.calls[0] as [string, string, string[], { refine: string }]
    expect(paths.some((p) => p.endsWith("app.ts"))).toBe(true)
    // Edit-time indexing must use the fast tier; the full tier is minutes.
    expect(options.refine).toBe("deferred")

    await watcher.stop()
  })

  test("coalesces a burst of edits into a single pass", async () => {
    const watcher = new Watcher({ debounceMs: 60, refineAfterIdleMs: 0 })
    await watcher.start()

    // Spread the burst across the window so each edit restarts the debounce,
    // which is the case that would fire five passes if it did not.
    for (let i = 0; i < 5; i++) {
      emit!(`src/mod${i}.ts`)
      await advance(20)
    }
    expect(mockIngestIncremental).not.toHaveBeenCalled()

    await advance(60)

    // A formatter sweep or branch switch must cost one pass, not one per file.
    expect(mockIngestIncremental).toHaveBeenCalledTimes(1)
    const [, , paths] = mockIngestIncremental.mock.calls[0] as [string, string, string[]]
    expect(paths).toHaveLength(5)

    await watcher.stop()
  })

  test("does not watch a repository another process already holds", async () => {
    mockTryAdvisoryLock.mockResolvedValue(null)

    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0 })
    const watched = await watcher.start()

    // Two watchers on one snapshot would each lose batches to the other's lock.
    expect(watched).toHaveLength(0)
    expect(mockWatch).not.toHaveBeenCalled()
    await watcher.stop()
  })

  test("skips a repository whose path is absent on this machine", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM repositories")) {
        return { rows: [{ repo_id: "repo-404", name: "gone", base_path: path.join(tempRoot, "missing") }] }
      }
      return { rows: [] }
    })

    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0 })
    expect(await watcher.start()).toHaveLength(0)
    await watcher.stop()
  })

  test("releases its advisory lock on stop", async () => {
    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0 })
    await watcher.start()
    await watcher.stop()

    // Without this the next process finds the repo permanently "already watched".
    expect(release).toHaveBeenCalled()
  })

  test("retries a batch the ingestion lock refused instead of dropping it", async () => {
    mockIngestIncremental
      .mockResolvedValueOnce({ error: "Ingestion is already running", error_code: "INGEST_LOCK_HELD" })
      .mockResolvedValue({ symbolsUpdated: 1, relationsUpdated: 0, files_failed: 0, failed_paths: [] })

    const watcher = new Watcher({ debounceMs: 30, refineAfterIdleMs: 0 })
    await watcher.start()

    emit!("src/retry.ts")
    await advance(30)
    expect(mockIngestIncremental).toHaveBeenCalledTimes(1)

    // The refusal reschedules the same files one debounce later. The files are
    // genuinely unindexed; reporting success would strand them.
    await advance(30)
    expect(mockIngestIncremental).toHaveBeenCalledTimes(2)
    const [, , retried] = mockIngestIncremental.mock.calls[1] as [string, string, string[]]
    expect(retried.some((p) => p.endsWith("retry.ts"))).toBe(true)

    await watcher.stop()
  })

  test("ignores churn inside skipped directories", async () => {
    const watcher = new Watcher({ debounceMs: 40, refineAfterIdleMs: 0 })
    await watcher.start()

    emit!("node_modules/pkg/index.ts")
    await advance(200)

    expect(mockIngestIncremental).not.toHaveBeenCalled()

    await watcher.stop()
  })
})
