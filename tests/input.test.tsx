import { describe, expect, test, type TestBody } from 'claude-code/testing'

import { applyWheel, onPointer, WHEEL_ZOOM } from '../hooks/client/input'
import { onKey } from '../hooks/client/keymap'
import { createLive, type Live } from '../hooks/client/live'
import { regions } from '../hooks/client/regions'
import { trackOf } from '../hooks/client/timeline-panel'
import { wheelTick, MAX_WHEEL } from '../hooks/intents'
import { Timeline } from '../hooks/model/timeline'
import { buildProps } from '../hooks/props'
import { EMPTY_UI } from '../hooks/uistate'
import type { Intent, UiState } from '../types'
import { reference } from './fixtures/generate'

const PANE = {
  plugin: 'session-viz',
  component: 'Pane',
  requestId: 'viz',
  props: { title: 'session graph', isFocused: false, bodyColumns: 87, placement: 'dock', scroll: { offset: 0, bodyRows: 32 }, view: {} },
} as const

/** An instance over the reference session at 87×32, with main's card drawn at canvas (10, 5). */
const liveFor = (ui: UiState = EMPTY_UI): Live => {
  const t = new Timeline()
  t.setFacts(reference().numbered())
  const props = buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
  const live = createLive(props, regions(87, 32, props), 0)
  live.positions = { main: { x: 10, y: 5 } }
  live.screen = new Map([['main', { x: 10, y: 5, w: 30, h: 7 }]])
  return live
}

const sent = (live: Live): Intent[] => live.outbox.take()?.intents ?? []

describe('pointer', () => {
  test('dragging a card moves it and pins where it lands, without selecting it', () => {
    const live = liveFor()
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    onPointer(live, { type: 'move', x: 17, y: 8, button: 'left' })
    expect(live.positions.main).toEqual({ x: 15, y: 7 })
    onPointer(live, { type: 'up', x: 17, y: 8, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'pin', id: 'main', x: 15, y: 7 }])
    expect(live.drag).toBeUndefined()
  })

  test('a click on a card selects it without pinning', () => {
    const live = liveFor()
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    expect(sent(live)).toEqual([])
    onPointer(live, { type: 'up', x: 12, y: 6, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'select', id: 'main' }])
  })

  test('dragging the background pans and leaves the camera in manual', () => {
    const live = liveFor()
    onPointer(live, { type: 'down', x: 60, y: 2, button: 'left' })
    onPointer(live, { type: 'move', x: 50, y: 0, button: 'left' })
    onPointer(live, { type: 'up', x: 50, y: 0, button: 'left' })
    expect({ x: live.camera.x, y: live.camera.y }).toEqual({ x: 10, y: 2 })
    expect(live.mode).toBe('manual')
    expect(sent(live)).toEqual([{ type: 'camera', mode: 'manual' }])
  })

  test('dragging along the track sends only the latest seek', () => {
    const live = liveFor()
    const track = trackOf(live.regions.panel, live.regions.isCompact)
    const length = live.props.view.timeline.length
    onPointer(live, { type: 'down', x: track.x, y: track.y, button: 'left' })
    onPointer(live, { type: 'move', x: track.x + 5, y: track.y + 9, button: 'left' })
    onPointer(live, { type: 'move', x: track.x + track.w + 20, y: 0, button: 'left' })
    onPointer(live, { type: 'up', x: 0, y: 0, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'seek', to: length }])
  })

  test('clicking the camera badge toggles follow', () => {
    const live = liveFor()
    live.cameraBadge = { x: 40, y: live.regions.statusY, w: 8, h: 1 }
    onPointer(live, { type: 'down', x: 42, y: live.regions.statusY, button: 'left' })
    expect(live.mode).toBe('manual')
    expect(sent(live)).toEqual([
      { type: 'camera', mode: 'manual' },
      { type: 'detailFollow', on: false },
    ])
    onPointer(live, { type: 'down', x: 42, y: live.regions.statusY, button: 'left' })
    expect(live.mode).toBe('follow')
    expect(sent(live)).toEqual([
      { type: 'camera', mode: 'follow' },
      { type: 'detailFollow', on: true },
    ])
  })

  test('a click on the background closes the details; a pan does not', () => {
    const live = liveFor({ ...EMPTY_UI, selected: 'main' })
    onPointer(live, { type: 'down', x: 45, y: 20, button: 'left' })
    onPointer(live, { type: 'up', x: 45, y: 20, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'select', id: null }])
    onPointer(live, { type: 'down', x: 45, y: 20, button: 'left' })
    onPointer(live, { type: 'move', x: 40, y: 18, button: 'left' })
    onPointer(live, { type: 'up', x: 40, y: 18, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'camera', mode: 'manual' }])
  })

  test('a bare move hovers a card and leaving clears it', () => {
    const live = liveFor()
    onPointer(live, { type: 'move', x: 20, y: 8 })
    expect(live.hover).toBe('main')
    onPointer(live, { type: 'move', x: 70, y: 1 })
    expect(live.hover).toBeUndefined()
    onPointer(live, { type: 'move', x: 20, y: 8 })
    onPointer(live, { type: 'leave', x: 20, y: 8 })
    expect(live.hover).toBeUndefined()
    expect(sent(live)).toEqual([])
  })
})

describe('keys', () => {
  test('keys pressed within a frame go out as one batch, in order', () => {
    const live = liveFor()
    onKey(live, { key: ']' })
    onKey(live, { key: ']' })
    onKey(live, { key: ' ' })
    expect(sent(live)).toEqual([
      { type: 'seekPrompt', dir: 1 },
      { type: 'seekPrompt', dir: 1 },
      { type: 'play' },
    ])
    expect(live.hasKeys).toBe(true)
  })

  test('f toggles follow and manual', () => {
    const live = liveFor()
    onKey(live, { key: 'f' })
    expect(live.mode).toBe('manual')
    onKey(live, { key: 'f' })
    expect(live.mode).toBe('follow')
    expect(sent(live).filter(i => i.type === 'camera')).toEqual([
      { type: 'camera', mode: 'manual' },
      { type: 'camera', mode: 'follow' },
    ])
  })

  test('x closes an overlay first, then the details', () => {
    expect(sent(withKey(liveFor({ ...EMPTY_UI, overlay: 'help', selected: 'main' }), 'x'))).toEqual([{ type: 'overlay', overlay: 'none' }])
    expect(sent(withKey(liveFor({ ...EMPTY_UI, selected: 'main', detailFollow: true }), 'x'))).toEqual([
      { type: 'select', id: null },
      { type: 'detailFollow', on: false },
    ])
    expect(sent(withKey(liveFor(), 'x'))).toEqual([])
  })

  test('j scrolls open details, else pans', () => {
    const open = liveFor({ ...EMPTY_UI, selected: 'main' })
    open.detailMax = 5
    onKey(open, { key: 'j' })
    onKey(open, { key: 'j' })
    expect(open.detailScroll).toBe(2)
    expect(open.mode).toBeUndefined()

    const closed = liveFor()
    onKey(closed, { key: 'j' })
    expect(closed.camera.y).toBe(2)
    expect(closed.mode).toBe('manual')
  })

  test('arrows select the nearest card in that direction', () => {
    const live = liveFor({ ...EMPTY_UI, selected: 'main' })
    const [a, b] = live.props.view.agents.filter(x => x.id !== 'main')
    live.positions = { main: { x: 0, y: 0 }, [a!.id]: { x: 40, y: 2 }, [b!.id]: { x: 2, y: 30 } }
    expect(sent(withKey(live, 'right'))).toEqual([{ type: 'select', id: a!.id }])
    expect(sent(withKey(live, 'down'))).toEqual([{ type: 'select', id: b!.id }])
    expect(sent(withKey(live, 'up'))).toEqual([])
  })

  test('zoom keys zoom about the canvas centre', () => {
    const live = liveFor()
    onKey(live, { key: '+' })
    expect(live.camera.z).toBe(1.25)
    onKey(live, { key: '0' })
    expect(live.camera.z).toBe(1)
  })
})

describe('wheel', () => {
  test('only a person’s wheel over the pane becomes a tick, clamped', () => {
    const person = { kind: 'person' } as const
    expect(wheelTick(EMPTY_UI, { by: 30, origin: person })).toBeUndefined()
    expect(wheelTick(EMPTY_UI, { by: 1, origin: { kind: 'plugin', plugin: 'x' } as never, pointer: { column: 3, row: 4 } })).toBeUndefined()
    const ui = wheelTick(EMPTY_UI, { by: 10, origin: person, pointer: { column: 3, row: 4 } })!
    expect(ui.wheel).toEqual({ seq: 1, by: MAX_WHEEL, column: 3, row: 4 })
    expect(wheelTick(ui, { by: -1, origin: person, pointer: { column: 0, row: 0 } })!.wheel!.seq).toBe(2)
  })

  test('a tick zooms the canvas once; over the details it scrolls them', () => {
    const live = liveFor()
    applyWheel(live, { seq: 1, by: -1, column: 20, row: 8 })
    expect(live.camera.z).toBe(WHEEL_ZOOM)
    expect(live.mode).toBe('manual')
    applyWheel(live, { seq: 1, by: -1, column: 20, row: 8 })
    expect(live.camera.z).toBe(WHEEL_ZOOM)

    const open = liveFor({ ...EMPTY_UI, selected: 'main' })
    const d = open.regions.details!
    open.detailMax = 9
    applyWheel(open, { seq: 1, by: 3, column: d.x + 1, row: d.y + 1 })
    expect(open.detailScroll).toBe(3)
    expect(open.camera.z).toBe(1)
  })
})

const withKey = (live: Live, key: string): Live => {
  onKey(live, { key })
  return live
}

describe('in the pane', () => {
  const start = async (...[$, on]: Parameters<TestBody>) => {
    on('session.id', () => ({ value: 's1' }))
    on('session.messages', () => ({ value: [] }))
    on('agent.list', () => ({ value: [] }))
    on('command.register', () => ({ value: { command: 'viz' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: {} }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'Read', command: 'x' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 87, rows: 32 })
    return ui
  }

  test('a key reaches the hooks module and the hint goes away', async ($, on) => {
    const ui = await start($, on)
    expect(await ui.find({ type: 'Text', text: /click graph for keys/, in: 'graph' })).toBeDefined()
    await ui.key({ key: 'f', in: 'graph' })
    await ui.advance(50)
    expect(await ui.find({ type: 'Text', text: /⌖ manual/, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /click graph for keys/, in: 'graph' })).toBeUndefined()
    await ui.key({ key: '?', in: 'graph' })
    await ui.advance(50)
    expect(await ui.find({ type: 'Text', text: /follow on \/ off/, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })

  test('a press on the track seeks there', async ($, on) => {
    const ui = await start($, on)
    expect(await ui.find({ type: 'Text', text: /LIVE/, in: 'graph' })).toBeDefined()
    // 32 rows, no prompts: the panel takes rows 25–30 and its track starts at column 2, row 26.
    await ui.pointer({ type: 'down', x: 2, y: 26, button: 'left', in: 'graph' })
    await ui.pointer({ type: 'up', x: 2, y: 26, button: 'left', in: 'graph' })
    await ui.advance(50)
    expect(await ui.find({ type: 'Text', text: / 1\/\d+/, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /HISTORY|PAUSED/, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })
})
