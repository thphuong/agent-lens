// The session's fact log: an in-memory array mirrored to `$.state` in chunks,
// so it survives hot reloads and worker respawns. Appends dedupe and are
// flushed in one batch shortly after a burst.

import type { LogMeta } from '../types'
import { dedupeKey, type Fact, type NewFact } from './model/facts'

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
  facts: Fact[] = []
  sessionId = ''
  private seq = 0
  private keys = new Map<string, number>()
  private dirty = new Set<number>()
  private isScheduled = false
  private writing: Promise<void> = Promise.resolve()

  /** Restores the log for `sessionId`; a log kept for another session is dropped. */
  async load(port: LogPort, sessionId: string): Promise<void> {
    const meta = await port.readMeta()
    this.clear(sessionId)
    if (!meta || meta.sessionId !== sessionId) return
    for (let i = 0; i < meta.chunks; i++) this.facts.push(...((await port.readChunk(i)) ?? []))
    this.seq = this.facts.reduce((m, f) => Math.max(m, f.seq), meta.seq)
    this.facts.forEach((f, i) => {
      const key = dedupeKey(f)
      if (key !== undefined) this.keys.set(key, i)
    })
  }

  /** Empties the log and starts it over for `sessionId`, persisting the reset. */
  reset(port: LogPort, sessionId: string): void {
    this.clear(sessionId)
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
        this.dirty.add(Math.floor(at / CHUNK))
        changed.push(fact)
        continue
      }
      const fact = { ...f, seq: ++this.seq } as Fact
      if (key !== undefined) this.keys.set(key, this.facts.length)
      this.dirty.add(Math.floor(this.facts.length / CHUNK))
      this.facts.push(fact)
      changed.push(fact)
    }
    if (changed.length > 0) this.schedule(port)
    return changed
  }

  /** Whether a fact with this key is logged. */
  has(key: string): boolean {
    return this.keys.has(key)
  }

  /** Writes every pending chunk now; resolves once written. */
  flush(port: LogPort): Promise<void> {
    this.isScheduled = false
    const dirty = [...this.dirty].filter(i => i >= 0).sort((a, b) => a - b)
    this.dirty.clear()
    const meta: LogMeta = { sessionId: this.sessionId, chunks: Math.ceil(this.facts.length / CHUNK), seq: this.seq }
    const slices = dirty.map(i => [i, this.facts.slice(i * CHUNK, (i + 1) * CHUNK)] as const)
    this.writing = this.writing.then(async () => {
      for (const [i, facts] of slices) await port.writeChunk(i, facts)
      await port.writeMeta(meta)
    })
    return this.writing
  }

  private clear(sessionId: string) {
    this.sessionId = sessionId
    this.facts = []
    this.seq = 0
    this.keys.clear()
    this.dirty.clear()
  }

  private schedule(port: LogPort) {
    if (this.isScheduled) return
    this.isScheduled = true
    port.after(FLUSH_MS, () => void this.flush(port))
  }
}
