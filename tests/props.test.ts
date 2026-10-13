import { describe, expect, test } from 'claude-code/testing'

import { applyIntents, parseIntents } from '../hooks/intents'
import { Timeline } from '../hooks/model/timeline'
import { buildProps } from '../hooks/props'
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

  test('a small session needs no shedding', () => {
    const props = buildProps({ timeline: timelineOf(reference()), ui: EMPTY_UI, now: 0, prompts: new Map() })
    expect(props.degrade).toBe(0)
    expect(props.view.runs.length).toBeGreaterThan(0)
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
          'junk',
        ],
      },
      agents,
    )
    expect(got).toEqual([
      { type: 'seek', to: 1e9 },
      { type: 'select', id: 'a1' },
      { type: 'pin', id: 'a1', x: 4, y: 100_000 },
    ])
    const t = timelineOf(reference())
    applyIntents(got, t, EMPTY_UI)
    expect(t.playhead).toBe(t.length)
  })

  test('at most 32 intents are read from one post', () => {
    expect(parseIntents({ intents: Array.from({ length: 50 }, () => ({ type: 'live' })) }, agents)).toHaveLength(32)
  })

  test('relayout clears pins and bumps the relayout counter; close is reported', () => {
    const t = timelineOf(reference())
    const ui: UiState = { ...EMPTY_UI, pinned: { a1: { x: 1, y: 2 } } }
    const r = applyIntents([{ type: 'relayout' }, { type: 'close' }], t, ui)
    expect(r.ui.pinned).toEqual({})
    expect(r.ui.relayoutSeq).toBe(1)
    expect(r.close).toBe(true)
  })
})
