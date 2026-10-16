// The session's fact log. History imported from the transcript is kept in
// memory only and read again on every load; the facts seen live are mirrored
// to `$.state` in chunks, so they survive hot reloads and worker respawns.
// Appends dedupe and are flushed in one batch shortly after a burst.

import type { LogMeta } from '../types'
import { dedupeKey, type Fact, type NewFact } from './model/facts'
import { ordered } from './model/timeline'

export const CHUNK = 500
export const FLUSH_MS = 250

/** Where the log is kept: register.tsx backs it with `$.state` and `$.clock`. */
export type LogPort = {
  readMeta: () => Promise<LogMeta | undefined>
  writeMeta: (meta: LogMeta) => Promise<void>
  readChunk: (i: number) => Promise<Fact[] | undefined>
  writeChunk: (i: number, facts: Fact[]) => Promise<void>
  after: (ms: number, fn: () => void) => void
}

export class FactLog {
  /** History first, then the facts seen live; seqs are unique across both. */
  facts: Fact[] = []
  sessionId = ''
  /** When this log began recording live: history before it is imported, after it observed. */
  liveSince = 0
  /** Whether the pane asked for the session's history, so every load reads it again. */
  imported = false
  /** How many times `adopt` renumbered the log in this module's life. */
  renumbered = 0
  /** How many facts at the front of `facts` are history, which is never persisted. */
  private history = 0
  private seq = 0
  private keys = new Map<string, number>()
  /** Live chunks to write, by their index in the live group; -1 for the meta alone. */
  private dirty = new Set<number>()
  /** How many chunks `$.state` may hold, so the ones past the live group are emptied. */
  private stored = 0
  private isScheduled = false
  private writing: Promise<void> = Promise.resolve()

  /** Restores the log for `sessionId`; a log kept for another session is dropped, and a new one starts live at `now`. */
  async load(port: LogPort, sessionId: string, now: number): Promise<void> {
    const meta = await port.readMeta()
    this.clear(sessionId, now)
    // Chunks kept for another session are emptied on the next flush too.
    this.stored = meta?.chunks ?? 0
    if (!meta || meta.sessionId !== sessionId) return
    this.liveSince = meta.liveSince ?? now
    this.imported = meta.imported ?? false
    const facts: Fact[] = []
    for (let i = 0; i < meta.chunks; i++) facts.push(...((await port.readChunk(i)) ?? []))
    this.seq = facts.reduce((m, f) => Math.max(m, f.seq), meta.seq)
    // A log kept before history stayed in memory holds its import in its chunks: that part is history now.
    const old = (f: Fact) => this.imported && f.at !== undefined && f.at < this.liveSince
    const history = facts.filter(old)
    this.history = history.length
    this.facts = [...history, ...facts.filter(f => !old(f))]
    this.index()
    if (this.history > 0) this.dirtyAll()
  }

  /** Empties the log and starts it over for `sessionId`, live from `now`, persisting the reset. */
  reset(port: LogPort, sessionId: string, now: number): void {
    this.clear(sessionId, now)
    this.dirty.add(-1)
    this.schedule(port)
  }

  /** Notes that the pane asked for the history, so it is read again on every load of this log. */
  markImported(port: LogPort): void {
    this.imported = true
    this.dirty.add(-1)
    this.schedule(port)
  }

  /**
   * Adds facts, numbering each new one. A fact whose key is already logged is
   * dropped, except that a dated fact replaces an undated one, keeping its seq.
   * Answers the facts that changed the log.
   */
  append(port: LogPort, incoming: readonly NewFact[]): Fact[] {
    const changed: Fact[] = []
    for (const f of incoming) {
      const key = dedupeKey(f)
      const at = key === undefined ? undefined : this.keys.get(key)
      if (at !== undefined) {
        const old = this.facts[at]!
        if (old.at !== undefined || f.at === undefined) continue
        const fact = { ...f, seq: old.seq } as Fact
        this.facts[at] = fact
        if (at >= this.history) this.dirty.add(Math.floor((at - this.history) / CHUNK))
        changed.push(fact)
        continue
      }
      const fact = { ...f, seq: ++this.seq } as Fact
      if (key !== undefined) this.keys.set(key, this.facts.length)
      this.dirty.add(Math.floor((this.facts.length - this.history) / CHUNK))
      this.facts.push(fact)
      changed.push(fact)
    }
    if (changed.length > 0) this.schedule(port)
    return changed
  }

  /**
   * Takes `history`, the session's facts dated before `cutoff`, in place of
   * the history held so far, and moves the boundary to `cutoff`: live facts
   * dated before it, or undated ones from a backfill, are dropped, since the
   * history covers them. The fold and the layout read seq as arrival order,
   * so every fact is numbered again in replay order, history first.
   */
  adopt(port: LogPort, history: readonly NewFact[], cutoff: number): void {
    const live = this.facts.slice(this.history).filter(f => f.at !== undefined && f.at >= cutoff)
    const seen = new Set<string>()
    const fresh = (f: NewFact) => {
      const key = dedupeKey(f)
      if (key === undefined) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    // Numbered in the order given first, which breaks ties between facts of one time.
    const past = ordered(history.filter(fresh).map((f, i) => ({ ...f, seq: i + 1 }) as Fact))
    const kept = [...past, ...ordered(live.filter(fresh))]
    this.history = past.length
    this.liveSince = cutoff
    this.facts = kept.map((f, i) => ({ ...f, seq: i + 1 }))
    this.renumbered += 1
    this.seq = this.facts.length
    this.index()
    this.dirtyAll()
    this.schedule(port)
  }

  /** Whether a fact with this key is logged. */
  has(key: string): boolean {
    return this.keys.has(key)
  }

  /** Writes every pending chunk now; resolves once written. */
  flush(port: LogPort): Promise<void> {
    this.isScheduled = false
    const chunks = Math.ceil((this.facts.length - this.history) / CHUNK)
    const dirty = [...this.dirty].filter(i => i >= 0 && i < chunks).sort((a, b) => a - b)
    this.dirty.clear()
    // Chunks past the live group, left by a reset or by history kept in older logs, are emptied.
    const stale = Array.from({ length: Math.max(0, this.stored - chunks) }, (_, k) => chunks + k)
    this.stored = chunks
    const meta: LogMeta = {
      sessionId: this.sessionId,
      chunks,
      seq: this.seq,
      liveSince: this.liveSince,
      imported: this.imported,
    }
    const from = this.history
    const slices = dirty.map(i => [i, this.facts.slice(from + i * CHUNK, from + (i + 1) * CHUNK)] as const)
    this.writing = this.writing.then(async () => {
      for (const [i, facts] of slices) await port.writeChunk(i, facts)
      for (const i of stale) await port.writeChunk(i, [])
      await port.writeMeta(meta)
    })
    return this.writing
  }

  private clear(sessionId: string, now: number) {
    this.sessionId = sessionId
    this.liveSince = now
    this.imported = false
    this.facts = []
    this.history = 0
    this.seq = 0
    this.keys.clear()
    this.dirty.clear()
  }

  private index() {
    this.keys.clear()
    this.facts.forEach((f, i) => {
      const key = dedupeKey(f)
      if (key !== undefined) this.keys.set(key, i)
    })
  }

  private dirtyAll() {
    this.dirty.add(-1)
    for (let i = 0; i * CHUNK < this.facts.length - this.history; i++) this.dirty.add(i)
  }

  private schedule(port: LogPort) {
    if (this.isScheduled) return
    this.isScheduled = true
    port.after(FLUSH_MS, () => void this.flush(port))
  }
}
