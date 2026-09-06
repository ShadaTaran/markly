/**
 * Tracks overlapping async operations — a React effect that dev Strict Mode
 * double-invokes, a fast retry while a prior call is still in flight, or a
 * network response that simply lands out of order — so only the most
 * recently started one is ever allowed to act on its result.
 *
 * Usage: call `start()` when beginning a new attempt (this aborts whatever
 * was previously in flight and hands back a signal to pass to `fetch`), then
 * call `isCurrent(token)` right before touching state with the result —
 * including inside a catch block, since an aborted or superseded request can
 * still resolve. Call `cancel()` from an effect's cleanup to abort whatever
 * is currently in flight (a real unmount, or Strict Mode's simulated one).
 *
 * Deliberately has no permanent "disposed" state: React Strict Mode's dev
 * double-invoke calls an effect's cleanup and then runs the effect AGAIN on
 * the same still-alive component — a *simulated* unmount, not a real one. A
 * guard that latched "disposed" on `cancel()` would incorrectly poison every
 * later `start()` too, since `isCurrent()` would gate on a flag that never
 * gets cleared, leaving the real request's own eventual success or error
 * silently ignored forever. `cancel()` only needs to abort what's currently
 * in flight — the abort turns that fetch into a rejected AbortError, which
 * callers already treat as "ignore, nothing to show" — so a true final
 * unmount is still handled correctly with no separate flag required.
 */
export interface RequestToken {
  readonly id: number;
  readonly signal: AbortSignal;
}

export class LatestRequestGuard {
  private currentId = 0;
  private controller: AbortController | null = null;

  start(): RequestToken {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.currentId;
    return { id, signal: controller.signal };
  }

  isCurrent(token: RequestToken): boolean {
    return token.id === this.currentId;
  }

  cancel(): void {
    this.controller?.abort();
  }
}
