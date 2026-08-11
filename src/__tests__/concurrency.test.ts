import { mapWithConcurrency } from "../concurrency"

describe("mapWithConcurrency", () => {
  test("preserves input order while bounding active work", async () => {
    let active = 0
    let peak = 0
    const result = await mapWithConcurrency([3, 1, 2, 0], 2, async (value) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, value))
      active--
      return value * 2
    })

    expect(result).toEqual([6, 2, 4, 0])
    expect(peak).toBeLessThanOrEqual(2)
  })

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid limit %s instead of silently dropping work",
    async (limit) => {
      await expect(mapWithConcurrency([1], limit, async (value) => value)).rejects.toThrow("Concurrency limit")
    },
  )
})
