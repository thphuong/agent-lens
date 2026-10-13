// Queues intents and sends them as one batch per frame. A later seek replaces
// an earlier one in the same frame, so dragging along the track sends only
// where it ended.

import type { Intent, IntentBatch } from '../../types'

export class Outbox {
  private queue: Intent[] = []

  push(...intents: Intent[]): void {
    for (const it of intents) {
      if (it.type === 'seek') this.queue = this.queue.filter(q => q.type !== 'seek')
      this.queue.push(it)
    }
  }

  get size(): number {
    return this.queue.length
  }

  /** Takes the batch to post, or undefined when nothing is queued. */
  take(): IntentBatch | undefined {
    if (this.queue.length === 0) return undefined
    const batch = { intents: this.queue }
    this.queue = []
    return batch
  }
}
