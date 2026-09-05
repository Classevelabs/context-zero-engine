/**
 * ContextZero — TypeScript extraction worker.
 *
 * Runs one extraction and exits, so the operating system reclaims what the
 * TypeScript compiler allocated. See extractFromTypeScript for why that exit is
 * the point: V8 releases the compiler's objects but does not return the pages,
 * leaving a long-lived parent permanently large.
 *
 * Invoked as `node worker.js <job.json>`, where the job names the files to
 * extract and the file to write the result to. Both sides of the exchange are
 * files rather than pipes because the result reaches tens of megabytes.
 *
 * Nothing is written to stdout: the parent reads the result file, and keeping
 * the pipe empty means a chatty dependency cannot deadlock the child by filling
 * a buffer nobody drains.
 */

import * as fs from "fs"
import { extractFromTypeScriptInProcess } from "./index"

interface ExtractionJob {
  filePaths: string[]
  tsconfigPath?: string
  outFile: string
}

async function main(): Promise<void> {
  const jobFile = process.argv[2]
  if (!jobFile) {
    process.stderr.write("usage: worker.js <job.json>\n")
    process.exit(2)
  }

  const job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as ExtractionJob
  const result = await extractFromTypeScriptInProcess(job.filePaths, job.tsconfigPath)

  // Write through a temporary name and rename into place, so the parent can
  // never observe a half-written result if this process dies mid-write.
  const partial = `${job.outFile}.partial`
  fs.writeFileSync(partial, JSON.stringify(result), "utf8")
  fs.renameSync(partial, job.outFile)
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(1)
  },
)
