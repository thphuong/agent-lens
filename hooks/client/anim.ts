// Presentation time: the clocks animation ages in. State comes from the facts;
// how long a chip has glowed comes from a clock that runs only while the view
// is live or playing, so a paused view keeps its chips where they stand. The
// pulse of a running card and the ants on its edge come from a clock that
// always runs, so an agent in progress keeps moving at any playhead.

import type { RunState, ViewRun } from '../../types'

/** How long a settled chip glows before it fades out; an error lingers longer. */
export const CHIP_TTL_MS = 2500
export const CHIP_TTL_ERR_MS = 4000
export const GLOW_LEVELS = 4
const PULSE_STEP_MS = 120
const PULSE_LEVELS = 6
const ANT_STEP_MS = 80
const BLINK_MS = 500

const ttlOf = (state: RunState) => (state === 'err' ? CHIP_TTL_ERR_MS : CHIP_TTL_MS)

export class Presentation {
  watchMs = 0
  /** Always advancing: motion that shows an agent is still at work. */
  motionMs = 0
  /** When each run last gained a member, in presentation time, and how many it had then. */
  private glow = new Map<string, { anchor: number; count: number }>()
  /** Runs settled at or below this seq are history: they never flash. */
  private baseline = 0

  advance(dtMs: number, isRunning: boolean): void {
    const dt = Math.max(0, dtMs)
    this.motionMs += dt
    if (isRunning) this.watchMs += dt
  }

  /** Treats everything up to `seq` as already seen: on mount, and on a seek. */
  adoptBaseline(seq: number): void {
    this.baseline = seq
    this.glow.clear()
  }

  /** Anchors the glow of runs that are new past the baseline or gained a member. */
  observe(runs: readonly ViewRun[]): void {
    for (const r of runs) {
      if (r.lastSeq <= this.baseline) continue
      const g = this.glow.get(r.key)
      if (!g || g.count !== r.count) this.glow.set(r.key, { anchor: this.watchMs, count: r.count })
    }
  }

  /** A chip's glow, 3 brightest to 0 faintest, or undefined once faded or never new. A running chip is always bright. */
  chipGlow(r: ViewRun): number | undefined {
    if (r.state === 'run') return GLOW_LEVELS - 1
    const g = this.glow.get(r.key)
    if (!g) return undefined
    const age = this.watchMs - g.anchor
    const ttl = ttlOf(r.state)
    if (age >= ttl) return undefined
    return GLOW_LEVELS - 1 - Math.floor((age / ttl) * GLOW_LEVELS)
  }

  /** A triangle wave over six steps, 0..3..0, for running card borders. */
  pulse(): number {
    const k = Math.floor(this.motionMs / PULSE_STEP_MS) % PULSE_LEVELS
    return k <= PULSE_LEVELS / 2 ? k : PULSE_LEVELS - k
  }

  antPhase(): number {
    return Math.floor(this.motionMs / ANT_STEP_MS)
  }

  isDotLit(): boolean {
    return Math.floor(this.watchMs / BLINK_MS) % 2 === 0
  }

  /** Whether any chip still glows. */
  isGlowing(runs: readonly ViewRun[]): boolean {
    return runs.some(r => r.state !== 'run' && this.chipGlow(r) !== undefined)
  }
}
