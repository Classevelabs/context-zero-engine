/**
 * Runs one maintenance pass at a time, and lets shutdown wait for the pass
 * that is running before the resources it uses are closed.
 *
 * Both server entrypoints fire retention without awaiting it — on startup in
 * the stdio bridge, on a timer in both — because a pass must never delay a
 * tool call or take the process down. That is right while the process runs
 * and wrong at the end of it. Shutdown cleared the timers and closed the
 * connection pool while the startup pass was still inside it, so every
 * remaining phase of that pass failed with "Database driver has been closed":
 * four error lines on every short session. A session that answers only
 * `initialize` and `tools/list`, which is what the CI cold-start smoke is,
 * is exactly that short.
 *
 * The runner owns the in-flight promise. `stop()` refuses new passes and
 * resolves once the running one has finished, so the caller can close the pool
 * afterwards. A pass that reads {@link RetentionRunner.stopping} between its
 * phases returns instead of starting the next one, which bounds the wait to
 * one phase rather than a whole pass.
 *
 * A pure module so the ordering can be tested without importing either server
 * entrypoint, both of which start serving on import.
 */

/** What a pass may read while it runs. */
export interface PassControl {
  /** True once stop() has been called. Check it before each phase. */
  readonly stopping: boolean
}

export class RetentionRunner implements PassControl {
  private inFlight: Promise<void> | null = null
  private stopRequested = false

  constructor(
    private readonly pass: (control: PassControl) => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get stopping(): boolean {
    return this.stopRequested
  }

  /** True while a pass is running. */
  get running(): boolean {
    return this.inFlight !== null
  }

  /**
   * Start a pass. Returns false, and starts nothing, while a pass is already
   * running or after stop() — two passes at once would contend for the same
   * advisory lock and one of them would only log that it lost.
   */
  trigger(): boolean {
    if (this.stopRequested || this.inFlight) return false
    // The pass starts now, not on the next microtask: its first stop check
    // must see the state at trigger time, and a caller that triggers twice in
    // one tick must find the first pass already running.
    let run: Promise<unknown>
    try {
      run = this.pass(this)
    } catch (error) {
      this.onError(error)
      return true
    }
    this.inFlight = run
      .then(
        () => undefined,
        (error: unknown) => this.onError(error),
      )
      .finally(() => {
        this.inFlight = null
      })
    return true
  }

  /**
   * Refuse further passes and resolve when the running one, if any, is done.
   * Never rejects: a failed pass has already been reported through onError.
   */
  async stop(): Promise<void> {
    this.stopRequested = true
    if (this.inFlight) await this.inFlight
  }
}
