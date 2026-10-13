// One event-indexed timeline over the log: a playhead counting how many
// facts are shown, replayed with gaps compressed so quiet stretches pass
// quickly and bursts stay legible.

import type { Fact } from './facts'
import { foldAll, type SessionModel } from './fold'

/** Replay runs this many times faster than it happened. */
export const SPEED = 8
/** Gaps up to the knee (seconds, after speed-up) play as they are; longer ones grow logarithmically. */
export const KNEE_SECS = 0.8
export const COMPRESS_SCALE = 0.6
/** A gap this long (seconds, real time) is marked on the scrubber. */
export const GAP_MARKER_SECS = 60
/** Backfilled facts have no times; replay steps through them at this pace. */
export const UNDATED_STEP_MS = 50
/** A live session quiet this long reads as idle. */
export const IDLE_MS = 60_000

export const compressGap = (secs: number): number =>
  secs <= KNEE_SECS ? secs : KNEE_SECS + COMPRESS_SCALE * Math.log(1 + (secs - KNEE_SECS) / KNEE_SECS)

export type Mode = 'live' | 'playing' | 'paused'
export type Transport = 'live' | 'playing' | 'paused' | 'history' | 'idle'

export type Markers = { spawns: number[]; fails: number[]; gaps: number[]; prompts: number[] }

/** Undated facts first in seq order, then dated ones by time. */
const ordered = (facts: readonly Fact[]): Fact[] =>
  [...facts].sort((a, b) => {
    if (a.at === undefined || b.at === undefined) return a.at === undefined ? (b.at === undefined ? a.seq - b.seq : -1) : 1
    return a.at - b.at || a.seq - b.seq
  })

export class Timeline {
  /** The log's facts in replay order. */
  order: Fact[] = []
  /** How many facts of `order` are shown. */
  playhead = 0
  mode: Mode = 'live'
  speed = SPEED
  compress = true
  private budgetMs = 0
  private memo?: { playhead: number; version: number; model: SessionModel }
  private version = 0

  /** Replaces the facts (after an append or reset); live mode follows the end. */
  setFacts(facts: readonly Fact[]): void {
    this.order = ordered(facts)
    this.version += 1
    if (this.mode === 'live' || this.playhead > this.order.length) this.playhead = this.order.length
  }

  get length(): number {
    return this.order.length
  }

  seek(i: number): void {
    this.playhead = Math.max(0, Math.min(this.order.length, Math.round(Number.isFinite(i) ? i : this.playhead)))
    this.budgetMs = 0
    if (this.mode === 'live' && this.playhead < this.order.length) this.mode = 'paused'
    if (this.playhead === this.order.length && this.mode === 'paused') this.mode = 'live'
  }

  /** Moves to just after the previous (-1) or next (+1) prompt. */
  seekPrompt(dir: 1 | -1): void {
    const ends = this.markers().prompts.map(i => i + 1)
    const target = dir > 0 ? ends.find(p => p > this.playhead) : ends.filter(p => p < this.playhead).at(-1)
    if (target !== undefined) this.seek(target)
    else if (dir > 0) this.goLive()
    else this.seek(0)
  }

  goLive(): void {
    this.mode = 'live'
    this.playhead = this.order.length
    this.budgetMs = 0
  }

  togglePlay(): void {
    if (this.mode === 'playing') this.mode = 'paused'
    else if (this.mode === 'paused') {
      if (this.playhead >= this.order.length) this.playhead = 0
      this.mode = 'playing'
    } else {
      this.mode = 'paused'
    }
    this.budgetMs = 0
  }

  toggleCompress(): void {
    this.compress = !this.compress
  }

  /** Milliseconds of replay before fact `i` (0-based in `order`) shows, after the fact before it. */
  stepMs(i: number): number {
    const prev = this.order[i - 1]
    const next = this.order[i]
    if (!next) return Infinity
    if (prev?.at === undefined || next.at === undefined) return UNDATED_STEP_MS
    const secs = Math.max(0, next.at - prev.at) / 1000 / this.speed
    return (this.compress ? compressGap(secs) : secs) * 1000
  }

  /** Advances replay by `dtMs` of presentation time; reaching the end goes live. Answers whether the playhead moved. */
  tick(dtMs: number): boolean {
    if (this.mode !== 'playing') return false
    const from = this.playhead
    this.budgetMs += dtMs
    while (this.playhead < this.order.length) {
      const cost = this.stepMs(this.playhead)
      if (this.budgetMs < cost) break
      this.budgetMs -= cost
      this.playhead += 1
    }
    if (this.playhead >= this.order.length) this.goLive()
    return this.playhead !== from
  }

  transport(now: number): Transport {
    if (this.mode === 'playing') return 'playing'
    if (this.mode === 'paused') return this.order[this.playhead - 1]?.at === undefined ? 'history' : 'paused'
    const last = this.order.at(-1)?.at
    return last !== undefined && now - last > IDLE_MS ? 'idle' : 'live'
  }

  markers(): Markers {
    const m: Markers = { spawns: [], fails: [], gaps: [], prompts: [] }
    this.order.forEach((f, i) => {
      if (f.kind === 'spawn' && !f.agent.startsWith('wf:')) m.spawns.push(i)
      else if ((f.kind === 'toolEnd' && f.outcome === 'err') || (f.kind === 'ended' && f.status === 'failed')) m.fails.push(i)
      else if (f.kind === 'prompt') m.prompts.push(i)
      const prev = this.order[i - 1]
      if (prev?.at !== undefined && f.at !== undefined && f.at - prev.at >= GAP_MARKER_SECS * 1000) m.gaps.push(i)
    })
    return m
  }

  /** The model as of the playhead, memoised for the last playhead. */
  model(): SessionModel {
    if (this.memo && this.memo.playhead === this.playhead && this.memo.version === this.version) return this.memo.model
    const model = foldAll(this.order, this.playhead)
    this.memo = { playhead: this.playhead, version: this.version, model }
    return model
  }

  /** The model after the first `i` facts of `order`. */
  modelAt(i: number): SessionModel {
    return foldAll(this.order, i)
  }
}
