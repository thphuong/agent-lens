import { describe, expect, test } from 'claude-code/testing'

import { formatTokens } from '../hooks/client/cards'
import { chipsFor } from '../hooks/client/chips'
import { Grid } from '../hooks/client/grid'
import { needsMinimap } from '../hooks/client/minimap'
import { detailLines } from '../hooks/client/panels'
import { regions } from '../hooks/client/regions'
import { drawStatus } from '../hooks/client/status-bar'
import { trackIndexAt, trackOf } from '../hooks/client/timeline-panel'
import { Timeline } from '../hooks/model/timeline'
import { buildProps } from '../hooks/props'
import { EMPTY_UI } from '../hooks/uistate'
import type { Transport, ViewRun } from '../types'
import { reference } from './fixtures/generate'

const PANE = {
  plugin: 'session-viz',
  component: 'Pane',
  requestId: 'viz',
  props: { title: 'session graph', isFocused: false, bodyColumns: 87, placement: 'dock', scroll: { offset: 0, bodyRows: 32 }, view: {} },
} as const

const referenceProps = (ui = EMPTY_UI) => {
  const t = new Timeline()
  t.setFacts(reference().numbered())
  return buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
}

describe('timeline panel', () => {
  test('the track ends map to the first and last fact', () => {
    const track = trackOf({ x: 0, y: 0, w: 60, h: 6 }, false)
    expect(trackIndexAt(track.x, track, 100)).toBe(0)
    expect(trackIndexAt(track.x + track.w - 1, track, 100)).toBe(99)
    expect(trackIndexAt(-5, track, 100)).toBe(0)
    expect(trackIndexAt(500, track, 100)).toBe(99)
  })

  test('the compact form is chosen below 30 rows', () => {
    const props = referenceProps()
    expect(regions(87, 20, props).isCompact).toBe(true)
    expect(regions(87, 32, props).isCompact).toBe(false)
  })
})

describe('chips, minimap and details', () => {
  test('an agent shows at most three chips, newest first', () => {
    const runs: ViewRun[] = Array.from({ length: 6 }, (_, i) => ({ key: `a:${i}`, agent: 'a', tool: `T${i}`, count: 1, state: 'ok', firstSeq: i, lastSeq: i }))
    const chips = chipsFor({ id: 'a' }, runs)
    expect(chips).toHaveLength(3)
    expect(chips[0]?.label).toBe('T5')
  })

  test('the minimap shows only when the graph overflows the view', () => {
    expect(needsMinimap({ x: 0, y: 0, w: 50, h: 20 }, { x: -1, y: -1, w: 60, h: 30 })).toBe(false)
    expect(needsMinimap({ x: 0, y: 0, w: 150, h: 20 }, { x: 0, y: 0, w: 60, h: 30 })).toBe(true)
  })

  test('details list calls under their prompt-era headers', () => {
    const props = referenceProps({ ...EMPTY_UI, selected: 'main' })
    const lines = detailLines(props.details!).map(l => l.text)
    expect(lines).toContain('◆ map the fake repo')
    expect(lines.some(l => l.includes('Read'))).toBe(true)
  })
})

describe('status bar', () => {
  test('the badge names every transport', () => {
    const props = referenceProps()
    const want: Record<Transport, string> = { live: 'LIVE', playing: '▶ 8×', paused: 'PAUSED', history: 'HISTORY', idle: 'IDLE' }
    for (const [transport, text] of Object.entries(want)) {
      const g = new Grid(87, 1)
      drawStatus(g, 0, { ...props.view, timeline: { ...props.view.timeline, transport: transport as Transport } }, { camera: 'follow' })
      expect(g.ch.join('')).toContain(text)
    }
  })

  test('the total counts each agent’s tokens once, not again through its group', () => {
    const props = referenceProps()
    const own = props.view.agents.filter(a => a.kind !== 'group').reduce((s, a) => s + a.tokens, 0)
    const g = new Grid(120, 1)
    const buttons = drawStatus(g, 0, props.view, { camera: 'follow' })
    const line = g.ch.join('')
    expect(line).toContain(`· ${formatTokens(own)} tok`)
    expect(line.slice(buttons.reset.x, buttons.reset.x + buttons.reset.w)).toBe('↺ layout')
  })
})

describe('mounted', () => {
  test('a tall pane draws the full panel, a short one the compact form', async $ => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 87, rows: 32 })
    expect(await ui.find({ type: 'Text', text: /timeline/, in: 'graph' })).toBeDefined()
    await ui.resize({ columns: 87, rows: 20 })
    expect(await ui.find({ type: 'Text', text: /timeline/, in: 'graph' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /agents · /, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })
})
