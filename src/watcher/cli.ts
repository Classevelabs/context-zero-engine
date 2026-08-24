/**
 * `npm run watch` — keep every registered repository's graph current.
 *
 * Runs until interrupted. Editor-agnostic and client-agnostic by design: the
 * filesystem is the only thing it needs to observe, so it works the same whether
 * the code is being edited by an IDE, a coding agent, a script, or a branch
 * switch.
 */

import { db } from "../db-driver"
import { Logger } from "../logger"
import { Watcher } from "./index"

const log = new Logger("watch-cli")

async function main(): Promise<void> {
  const watcher = new Watcher({
    onBatch: (batch) => {
      const failed =
        batch.files_failed > 0 ? ` — ${batch.files_failed} failed: ${batch.failed_paths.join(", ")}` : ""
      process.stdout.write(
        `${batch.repo}: ${batch.files} file(s) · ` +
          `${batch.symbols_updated} symbols · ${batch.relations_updated} relations${failed}\n`,
      )
    },
  })

  const watched = await watcher.start()
  if (watched.length === 0) {
    process.stdout.write(
      "No repositories to watch. Register one with scg_register_repo and ingest it first.\n",
    )
    await db.close()
    return
  }

  process.stdout.write(`Watching ${watched.length} repository(ies):\n`)
  for (const repo of watched) process.stdout.write(`  ${repo.name} — ${repo.base_path}\n`)
  process.stdout.write("Edits are indexed automatically. Ctrl-C to stop.\n")

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("Stopping watcher", { signal })
    await watcher.stop()
    await db.close()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

main().catch(async (err) => {
  log.error("Watcher failed to start", err instanceof Error ? err : new Error(String(err)))
  await db.close().catch(() => {})
  process.exit(1)
})
