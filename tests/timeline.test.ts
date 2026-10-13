import { describe, expect, test } from 'claude-code/testing'

import { derive, foldAll } from '../hooks/model/fold'
import { compressGap, SPEED, Timeline, UNDATED_STEP_MS } from '../hooks/model/timeline'
import type { Fact } from '../hooks/model/facts'
import { large, reference, rng, Session } from './fixtures/generate'

const timelineOf = (facts: Fact[]) => {
  const t = new Timeline()
  t.setFacts(facts)
  return t
}

describe('seek', () => {
  test('the model at every playhead equals a fold of the facts before it', () => {
    const t = timelineOf(reference().numbered())
    const r = rng(3)
    const positions = [...Array.from({ length: t.length + 1 }, (_, i) => i), ...Array.from({ length: t.length + 1 }, (_, i) => t.length - i)]
    for (let k = 0; k < 40; k++) positions.push(Math.floor(r() * (t.length + 1)))
    for (const i of positions) {
      t.seek(i)
      expect(JSON.stringify(derive(t.model()))).toBe(JSON.stringify(derive(foldAll(t.order.slice(0, i)))))
    }
  })

  test('seek clamps and leaves live; reaching the end goes live again', () => {
    const t = timelineOf(reference().numbered())
    t.seek(1e9)
    expect(t.playhead).toBe(t.length)
    expect(t.mode).toBe('live')
    t.seek(-5)
    expect(t.playhead).toBe(0)
    expect(t.mode).toBe('paused')
    t.seek(Number.NaN)
    expect(t.playhead).toBe(0)
  })

  test('undated history comes first, dated facts after by time', () => {
    const facts: Fact[] = [
      { seq: 1, at: 50, agent: 'main', kind: 'toolStart', call: 'b', tool: 'X' },
      { seq: 2, agent: 'main', kind: 'toolStart', call: 'a', tool: 'X' },
      { seq: 3, at: 10, agent: 'main', kind: 'toolStart', call: 'c', tool: 'X' },
    ]
    expect(timelineOf(facts).order.map(f => f.seq)).toEqual([2, 3, 1])
  })
})

describe('pacing', () => {
  test('gaps up to the knee are kept; longer ones compress logarithmically', () => {
    expect(compressGap(0.5)).toBe(0.5)
    expect(compressGap(0.8)).toBe(0.8)
    expect(Math.abs(compressGap(1.6) - (0.8 + 0.6 * Math.log(2)))).toBeLessThan(1e-9)
    expect(Math.abs(compressGap(8.8) - (0.8 + 0.6 * Math.log(11)))).toBeLessThan(1e-9)
  })

  test('faithful pacing is the gap divided by the speed', () => {
    const facts: Fact[] = [
      { seq: 1, at: 0, agent: 'main', kind: 'toolStart', call: 'a', tool: 'X' },
      { seq: 2, at: 16_000, agent: 'main', kind: 'toolStart', call: 'b', tool: 'X' },
    ]
    const t = timelineOf(facts)
    t.toggleCompress()
    expect(t.stepMs(1)).toBe(16_000 / SPEED)
    t.toggleCompress()
    expect(Math.abs(t.stepMs(1) - (compressGap(2) * 1000))).toBeLessThan(1e-9)
  })

  test('tick steps undated facts at a fixed pace and stops at the edge', () => {
    const facts: Fact[] = [1, 2, 3, 4].map(i => ({ seq: i, agent: 'main', kind: 'toolStart' as const, call: `c${i}`, tool: 'X' }))
    const t = timelineOf(facts)
    t.seek(0)
    t.togglePlay()
    expect(t.mode).toBe('playing')
    t.tick(UNDATED_STEP_MS * 2)
    expect(t.playhead).toBe(2)
    t.tick(10_000)
    expect(t.playhead).toBe(4)
    expect(t.mode).toBe('live')
    t.togglePlay()
    expect(t.tick(1000)).toBe(false)
  })
})

describe('navigation and markers', () => {
  test('prompt seek moves to just after each prompt and then live', () => {
    const s = new Session()
    s.prompt('one')
    s.call(undefined, 'Read')
    s.prompt('two')
    s.call(undefined, 'Read')
    const t = timelineOf(s.numbered())
    const [p1, p2] = t.markers().prompts
    t.seek(0)
    t.seekPrompt(1)
    expect(t.playhead).toBe(p1! + 1)
    t.seekPrompt(1)
    expect(t.playhead).toBe(p2! + 1)
    t.seekPrompt(1)
    expect(t.mode).toBe('live')
    t.seekPrompt(-1)
    expect(t.playhead).toBe(p2! + 1)
  })

  test('markers find spawns, failures, long gaps and prompts', () => {
    const s = reference()
    s.tick(90_000)
    s.call(undefined, 'Read')
    const m = timelineOf(s.numbered()).markers()
    expect(m.spawns.length).toBeGreaterThanOrEqual(6)
    expect(m.fails.length).toBeGreaterThanOrEqual(2)
    expect(m.gaps).toHaveLength(1)
    expect(m.prompts).toHaveLength(2)
  })

  test('transport reads live, idle, paused, history and playing', () => {
    const t = timelineOf(reference().numbered())
    const last = t.order.at(-1)!.at!
    expect(t.transport(last + 1000)).toBe('live')
    expect(t.transport(last + 120_000)).toBe('idle')
    t.seek(t.length - 1)
    expect(t.transport(last)).toBe('paused')
    t.seek(1)
    t.togglePlay()
    expect(t.transport(last)).toBe('playing')
    const undated = timelineOf([{ seq: 1, agent: 'main', kind: 'agent', agentKind: 'main' }, { seq: 2, agent: 'main', kind: 'truncated' }])
    undated.seek(1)
    expect(undated.transport(0)).toBe('history')
  })
})

describe('benchmark', () => {
  test('100 random seeks on a 10k-fact session average under 8 ms', () => {
    const facts = large(400, 3600).numbered()
    expect(facts.length).toBeGreaterThan(10_000)
    const t = timelineOf(facts)
    const r = rng(11)
    const t0 = performance.now()
    for (let k = 0; k < 100; k++) {
      t.seek(Math.floor(r() * t.length))
      derive(t.model())
    }
    const avg = (performance.now() - t0) / 100
    expect(avg).toBeLessThan(8)
  })
})
