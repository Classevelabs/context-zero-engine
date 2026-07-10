/**
 * Bounded-concurrency map. Runs `fn` over `items` with at most `limit` in
 * flight at once, preserving input order in the result array.
 *
 * Exists because unbounded `Promise.all(items.map(...))` over DB-touching work
 * floods the pool's wait queue and trips the driver's overload rejection —
 * a single tool call can DoS the engine's own database (seen live: homolog
 * scoring fired 100+ concurrent queries against a 40-slot queue).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()))
  return results
}
