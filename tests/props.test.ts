import { describe, expect, test } from 'claude-code/testing'

import { applyIntents, parseIntents } from '../hooks/intents'
import { Timeline } from '../hooks/model/timeline'
import { BUDGET, buildProps, SPARK_BUCKETS } from '../hooks/props'
import { EMPTY_UI } from '../hooks/uistate'
import type { UiState } from '../types'
import { large, reference, Session } from './fixtures/generate'

const timelineOf = (s: Session) => {
  const t = new Timeline()
  t.setFacts(s.numbered())
  return t
}

describe('size budget', () => {
  test('400 agents and 10k calls with full details stay under 100,000 characters', () => {
    const s = large(400, 10_000)
    const t = timelineOf(s)
    const ui: UiState = { ...EMPTY_UI, overlay: 'info', detailFollow: true }
    const props = buildProps({ timeline: t, ui, now: Date.now(), prompts: new Map([['main', 'p'.repeat(600)]]) })
    const size = JSON.stringify(props).length
    expect(size).toBeLessThan(100_000)
    expect(props.degrade).toBeGreaterThan(0)
    expect(props.view.agents.length).toBe(401)
    expect(props.details).toBeDefined()
  })

  test('400 agents finishing in batches, so most carry a wave, stay under 100,000 characters', () => {
    const t = timelineOf(large(400, 10_000, 7, 4))
    const ui: UiState = { ...EMPTY_UI, overlay: 'info', detailFollow: true }
    const props = buildProps({ timeline: t, ui, now: Date.now(), prompts: new Map([['main', 'p'.repeat(600)]]) })
    expect(props.view.agents.filter(a => a.wave !== undefined).length).toBeGreaterThan(200)
    expect(JSON.stringify(props).length).toBeLessThan(100_000)
  })

  test('the renumber count reaches the Client', () => {
    const t = timelineOf(reference())
    expect(buildProps({ timeline: t, ui: EMPTY_UI, now: 0, prompts: new Map() }).view.renumbered).toBe(0)
    expect(buildProps({ timeline: t, ui: EMPTY_UI, now: 0, prompts: new Map(), renumbered: 2 }).view.renumbered).toBe(2)
  })

  test('a small session needs no shedding', () => {
    const props = buildProps({ timeline: timelineOf(reference()), ui: EMPTY_UI, now: 0, prompts: new Map() })
    expect(props.degrade).toBe(0)
    expect(props.view.runs.length).toBeGreaterThan(0)
  })
})

describe('track window', () => {
  test('zoomed, the spark and markers cover the window and an overview the whole timeline', () => {
    const t = timelineOf(large(20, 2000))
    t.seek(1500)
    const ui: UiState = { ...EMPTY_UI, track: { from: 1200, to: 1600 } }
    const { timeline } = buildProps({ timeline: t, ui, now: 0, prompts: new Map() }).view
    expect(timeline).toMatchObject({ from: 1200, to: 1600, length: t.length })
    const toolStarts = t.order.slice(1200, 1600).filter(f => f.kind === 'toolStart').length
    expect(timeline.spark.reduce((a, b) => a + b, 0)).toBe(toolStarts)
    expect(timeline.overview!.reduce((a, b) => a + b, 0)).toBe(t.order.filter(f => f.kind === 'toolStart').length)
    for (const i of [...timeline.spawns, ...timeline.fails, ...timeline.gaps, ...timeline.prompts]) expect(i >= 1200 && i < 1600).toBe(true)
    expect(timeline.spawns.length).toBeLessThan(t.markers().spawns.length)

    const whole = buildProps({ timeline: t, ui: EMPTY_UI, now: 0, prompts: new Map() }).view.timeline
    expect(whole).toMatchObject({ from: 0, to: t.length })
    expect(whole.overview).toBeUndefined()
  })

  test('a large timeline stays under budget, zoomed or not', () => {
    const t = timelineOf(large(400, 10_000))
    const ui: UiState = { ...EMPTY_UI, overlay: 'info', detailFollow: true }
    for (const track of [undefined, { from: 0, to: 80 }, { from: 5000, to: 9000 }]) {
      const props = buildProps({ timeline: t, ui: { ...ui, track }, now: 0, prompts: new Map([['main', 'p'.repeat(600)]]) })
      expect(JSON.stringify(props).length).toBeLessThan(100_000)
    }
  })

  test('thousands of markers stay bounded: at most one per bucket, exact once zoomed in', () => {
    const s = new Session()
    for (let i = 0; i < 3000; i++) {
      s.prompt(`p${i}`)
      s.call(undefined, 'Read', true)
    }
    const t = timelineOf(s)
    const ui: UiState = { ...EMPTY_UI, overlay: 'info', detailFollow: true }
    const props = buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
    expect(props.view.timeline.prompts.length).toBeLessThanOrEqual(SPARK_BUCKETS)
    expect(props.view.timeline.fails.length).toBeLessThanOrEqual(SPARK_BUCKETS)
    expect(JSON.stringify(props).length).toBeLessThan(BUDGET)
    const all = t.markers().prompts
    const near = buildProps({ timeline: t, ui: { ...ui, track: { from: t.length - 100, to: t.length } }, now: 0, prompts: new Map() }).view.timeline
    expect(near.prompts).toEqual(all.filter(i => i >= t.length - 100))
  })

  test('a track window built before the log was renumbered is dropped', () => {
    const post = { intents: [{ type: 'track', from: 2, to: 9 }, { type: 'live' }], renumbered: 1 }
    expect(parseIntents(post, new Set(), 2)).toEqual([{ type: 'live' }])
    expect(parseIntents(post, new Set(), 1)).toHaveLength(2)
  })

  test('track intents need whole numbers in order, and clear with from null', () => {
    const got = parseIntents(
      {
        intents: [
          { type: 'track', from: 5, to: 5 },
          { type: 'track', from: 9, to: 2 },
          { type: 'track', from: 1.5, to: 9 },
          { type: 'track', from: 1, to: Infinity },
          { type: 'track', from: '1', to: 9 },
          { type: 'track', from: 1 },
          { type: 'track', from: 2, to: 90 },
          { type: 'track', from: null },
        ],
      },
      new Set(),
    )
    expect(got).toEqual([
      { type: 'track', from: 2, to: 90 },
      { type: 'track', from: null },
    ])
    const t = timelineOf(reference())
    expect(applyIntents([got[0]!], t, EMPTY_UI).ui.track).toEqual({ from: 2, to: 90 })
    expect('track' in applyIntents(got, t, EMPTY_UI).ui).toBe(false)
  })
})

describe('redraw', () => {
  test('the selection and its details survive an append', () => {
    const s = reference()
    const t = timelineOf(s)
    const id = buildProps({ timeline: t, ui: EMPTY_UI, now: 0, prompts: new Map() }).view.agents.find(a => a.kind === 'sub')!.id
    const ui: UiState = { ...EMPTY_UI, selected: id }
    s.call(undefined, 'Read')
    t.setFacts(s.numbered())
    const props = buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
    expect(props.details?.agent).toBe(id)
    expect(props.details?.eras.length).toBeGreaterThan(0)
  })
})

describe('intents', () => {
  const agents = new Set(['main', 'a1'])

  test('a batch of two prompt seeks applies both', () => {
    const s = new Session()
    for (const p of ['one', 'two', 'three']) {
      s.prompt(p)
      s.call(undefined, 'Read')
    }
    const t = timelineOf(s)
    t.seek(0)
    const intents = parseIntents({ intents: [{ type: 'seekPrompt', dir: 1 }, { type: 'seekPrompt', dir: 1 }] }, agents)
    expect(intents).toHaveLength(2)
    applyIntents(intents, t, EMPTY_UI)
    expect(t.playhead).toBe(t.markers().prompts[1]! + 1)
  })

  test('malformed, unknown and out-of-range intents are dropped or clamped', () => {
    expect(parseIntents(null, agents)).toEqual([])
    expect(parseIntents({ intents: 'x' }, agents)).toEqual([])
    const got = parseIntents(
      {
        intents: [
          { type: 'seek', to: Number.NaN },
          { type: 'seek', to: 1e9 },
          { type: 'nope' },
          { type: 'select', id: '__proto__' },
          { type: 'select', id: 'a1' },
          { type: 'pin', id: 'a1', x: Infinity, y: 0 },
          { type: 'pin', id: 'a1', x: 3.6, y: 1e12 },
          { type: 'overlay', overlay: 'evil' },
          { type: 'speed', speed: 7 },
          { type: 'step', dir: 2 },
          { type: 'seekMarker' },
          { type: 'step', dir: -1 },
          'junk',
        ],
      },
      agents,
    )
    expect(got).toEqual([
      { type: 'seek', to: 1e9 },
      { type: 'select', id: 'a1' },
      { type: 'pin', id: 'a1', x: 4, y: 100_000 },
      { type: 'step', dir: -1 },
    ])
    const t = timelineOf(reference())
    applyIntents(got.slice(0, -1), t, EMPTY_UI)
    expect(t.playhead).toBe(t.length)
  })

  test('at most 32 intents are read from one post', () => {
    expect(parseIntents({ intents: Array.from({ length: 50 }, () => ({ type: 'live' })) }, agents)).toHaveLength(32)
  })

  test('relayout clears pins; close is reported', () => {
    const t = timelineOf(reference())
    const ui: UiState = { ...EMPTY_UI, pinned: { a1: { x: 1, y: 2 } } }
    const r = applyIntents([{ type: 'relayout' }, { type: 'close' }], t, ui)
    expect(r.ui.pinned).toEqual({})
    expect(r.close).toBe(true)
  })
})
