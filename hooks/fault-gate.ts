// Decides when a Client that keeps failing is left out of its pane: on the
// second failure within the window, until the person asks again.

export const FAULT_WINDOW_MS = 60_000

export class FaultGate {
  private times: number[] = []
  isPaused = false

  /** Records a failure at `now`; answers true when this one pauses the Client. */
  record(now: number): boolean {
    this.times = [...this.times.filter(t => now - t < FAULT_WINDOW_MS), now]
    if (this.times.length < 2 || this.isPaused) return false
    this.isPaused = true
    return true
  }

  /** Clears the history; answers whether the Client had been paused. */
  reset(): boolean {
    const was = this.isPaused
    this.times = []
    this.isPaused = false
    return was
  }
}
