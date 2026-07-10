import { ingestor } from "../src/ingestor"
import { db } from "../src/db-driver"

;(async () => {
  const repoPath = process.env.BENCH_REPO_PATH || process.cwd()
  const repoName = process.env.BENCH_REPO_NAME || "contextzero-bench"
  const start = Date.now()
  const result = await ingestor.ingestRepo(repoPath, repoName, "workspace-bench-" + Date.now())
  const dur = Date.now() - start
  console.log(`\nINGEST DURATION: ${dur}ms`)
  console.log(
    `symbols=${result.symbols_extracted} relations=${result.relations_extracted} files=${result.files_processed}`,
  )
  console.log(`reported duration_ms=${result.duration_ms}`)
  await db.close()
})().catch((e) => {
  console.error("FAIL:", e)
  process.exit(1)
})
