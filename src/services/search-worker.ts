/**
 * ContextZero — Search Worker
 *
 * Runs a code search off the main thread so a caller-supplied regex cannot
 * stall the engine. Node offers no way to time-bound a regex match: once
 * `RegExp.test` starts backtracking it runs to completion, ignoring timers,
 * because the event loop is not involved. The only hard bound available is to
 * run the match on a thread the parent can terminate.
 *
 * The parent (search-service) starts this worker with a ScanParams payload,
 * arms a timer, and calls `worker.terminate()` if the budget is exceeded.
 *
 * There are two tiers, deliberately:
 *   • the scan checks its own deadline between batches, so a merely slow search
 *     returns the matches it did find with timedOut set; and
 *   • the parent's kill timer fires slightly later, for the case that check can
 *     never reach — a single line stuck inside one `RegExp.test`. Terminating
 *     discards the worker's stack, so that case yields no matches at all. That
 *     is the intended trade: an empty, honest `timed_out` beats a hung engine.
 */

import { parentPort, workerData } from "worker_threads"
import { scanFiles, type ScanParams, type SearchMatch } from "./search-scan"

export interface WorkerDoneMessage {
  type: "done"
  matches: SearchMatch[]
  timedOut: boolean
  filesScanned: number
}

export interface WorkerErrorMessage {
  type: "error"
  message: string
}

export type WorkerMessage = WorkerDoneMessage | WorkerErrorMessage

async function main(): Promise<void> {
  if (!parentPort) return
  const port = parentPort
  try {
    const result = await scanFiles(workerData as ScanParams)
    port.postMessage({
      type: "done",
      matches: result.matches,
      timedOut: result.timedOut,
      filesScanned: result.filesScanned,
    } satisfies WorkerDoneMessage)
  } catch (error) {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerErrorMessage)
  }
}

void main()
