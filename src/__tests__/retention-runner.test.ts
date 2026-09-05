import { RetentionRunner } from "../retention-runner"

/** A promise the test resolves by hand, so ordering is asserted, not timed. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Whether a promise has settled by the time the microtask queue drains. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true),
  )
  for (let i = 0; i < 4; i++) await Promise.resolve()
  return done
}

describe("RetentionRunner", () => {
  test("runs the pass when triggered", async () => {
    const pass = jest.fn(async () => undefined)
    const runner = new RetentionRunner(pass, () => {})

    expect(runner.trigger()).toBe(true)
    await runner.stop()

    expect(pass).toHaveBeenCalledTimes(1)
  })

  test("never overlaps two passes", async () => {
    const gate = deferred()
    const pass = jest.fn(() => gate.promise)
    const runner = new RetentionRunner(pass, () => {})

    expect(runner.trigger()).toBe(true)
    // The timer fires again while the startup pass is still running.
    expect(runner.trigger()).toBe(false)
    expect(pass).toHaveBeenCalledTimes(1)

    gate.resolve()
    await runner.stop()
  })

  test("stop() waits for the running pass before resolving", async () => {
    // This is the shutdown ordering that was broken: the pool was closed while
    // the startup pass was inside it. stop() must not resolve — and so the pool
    // must not close — until the pass has returned.
    const gate = deferred()
    const runner = new RetentionRunner(() => gate.promise, () => {})
    runner.trigger()

    const stopping = runner.stop()
    expect(await settled(stopping)).toBe(false)
    expect(runner.running).toBe(true)

    gate.resolve()
    await stopping
    expect(runner.running).toBe(false)
  })

  test("a pass can see the stop request between its phases", async () => {
    const seen: boolean[] = []
    const gate = deferred()
    const runner = new RetentionRunner(async (control) => {
      seen.push(control.stopping)
      await gate.promise
      seen.push(control.stopping)
    }, () => {})
    runner.trigger()

    const stopping = runner.stop()
    gate.resolve()
    await stopping

    expect(seen).toEqual([false, true])
  })

  test("trigger after stop starts nothing", async () => {
    const pass = jest.fn(async () => undefined)
    const runner = new RetentionRunner(pass, () => {})

    await runner.stop()

    expect(runner.trigger()).toBe(false)
    expect(pass).not.toHaveBeenCalled()
  })

  test("a failing pass reaches onError and does not reject stop()", async () => {
    const onError = jest.fn()
    const runner = new RetentionRunner(async () => {
      throw new Error("pool exhausted")
    }, onError)
    runner.trigger()

    await expect(runner.stop()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "pool exhausted" }))
    expect(runner.running).toBe(false)
  })

  test("a pass that throws synchronously is reported the same way", async () => {
    const onError = jest.fn()
    const runner = new RetentionRunner(() => {
      throw new Error("bad config")
    }, onError)
    expect(runner.trigger()).toBe(true)

    await runner.stop()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad config" }))
  })
})
