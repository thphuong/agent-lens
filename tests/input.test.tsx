import { describe, expect, test, type TestBody } from 'claude-code/testing'

import { applyWheel, onPointer, TRACK_ZOOM, WHEEL_ZOOM } from '../hooks/client/input'
import { onKey } from '../hooks/client/keymap'
import { GLIDE_SECS } from '../hooks/client/camera'
import { layout } from '../hooks/client/layout'
import { Grid } from '../hooks/client/grid'
import { cardAt, createLive, stepPositions, syncLayout, type Live } from '../hooks/client/live'
import { drawScene } from '../hooks/client/scene'
import { regions } from '../hooks/client/regions'
import { overviewOf, trackIndexAt, trackOf, windowOf } from '../hooks/client/timeline-panel'
import { applyIntents, wheelTick, MAX_WHEEL } from '../hooks/intents'
import { Timeline } from '../hooks/model/timeline'
import { buildProps } from '../hooks/props'
import { EMPTY_UI } from '../hooks/uistate'
import type { Fact } from '../hooks/model/facts'
import type { Intent, Props, UiState } from '../types'
import { large, reference, waterfall, wrapped } from './fixtures/generate'

const PANE = {
  plugin: 'agent-lens',
  component: 'Pane',
  requestId: 'lens',
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

  test('clicking the layout button clears the dragged positions', () => {
    const live = liveFor()
    live.resetBadge = { x: 52, y: live.regions.statusY, w: 8, h: 1 }
    live.pins = { main: { x: 9, y: 9 } }
    onPointer(live, { type: 'down', x: 55, y: live.regions.statusY, button: 'left' })
    expect(sent(live)).toEqual([{ type: 'relayout' }])
    expect(live.pins).toEqual({})
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

  test('the step and marker keys post their intents', () => {
    const live = liveFor()
    for (const key of [',', '.', '<', '>']) onKey(live, { key })
    expect(sent(live)).toEqual([
      { type: 'step', dir: -1 },
      { type: 'step', dir: 1 },
      { type: 'seekMarker', dir: -1 },
      { type: 'seekMarker', dir: 1 },
    ])
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
    live.target = { main: { x: 0, y: 0 }, [a!.id]: { x: 40, y: 2 }, [b!.id]: { x: 2, y: 30 } }
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

describe('timeline track zoom', () => {
  /** An instance over a long session at 87×32, wired to the hooks module's intents as the pane is. */
  const zoomable = () => {
    const t = new Timeline()
    t.setFacts(large(30, 3000).numbered())
    let ui: UiState = EMPTY_UI
    const props = () => buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
    const live = createLive(props(), regions(87, 32, props()), 0)
    let seq = 0
    /** Sends what the instance queued, as its frame does, and hands it the answer. */
    const answer = () => {
      ui = applyIntents(sent(live), t, ui).ui
      live.props = props()
    }
    const wheel = (by: number, column: number) => {
      const track = trackOf(live.regions.panel, live.regions.isCompact)
      applyWheel(live, { seq: ++seq, by, column, row: track.y })
      answer()
    }
    return { t, live, answer, wheel, track: trackOf(live.regions.panel, live.regions.isCompact), ui: () => ui }
  }

  test('zoomed fully in, one column is one fact, so neighbouring columns seek neighbouring facts', () => {
    const { t, live, answer, wheel, track } = zoomable()
    const mid = track.x + Math.floor(track.w / 2)
    for (let i = 0; i < 40; i++) wheel(-1, mid)
    const { from, to } = live.props.view.timeline
    expect(to - from).toBe(track.w)
    const seeks: number[] = []
    for (const x of [mid, mid + 1, mid + 2]) {
      onPointer(live, { type: 'down', x, y: track.y, button: 'left' })
      onPointer(live, { type: 'up', x, y: track.y, button: 'left' })
      answer()
      seeks.push(t.playhead)
    }
    expect(seeks).toEqual([seeks[0], seeks[0]! + 1, seeks[0]! + 2])
  })

  test('the fact under the pointer stays under it while zooming, pulling the playhead into the window', () => {
    const { t, live, wheel, track } = zoomable()
    const x = track.x + 10
    for (let i = 0; i < 6; i++) {
      const under = trackIndexAt(x, track, windowOf(live.props.view.timeline))
      wheel(-1, x)
      const now = live.props.view.timeline
      expect(Math.abs(trackIndexAt(x, track, windowOf(now)) - under)).toBeLessThanOrEqual(Math.ceil((now.to - now.from) / track.w))
    }
    const { from, to, length } = live.props.view.timeline
    expect(to - from).toBe(Math.round(length / TRACK_ZOOM ** 6))
    // Live at the end, the playhead was pulled to the window's right edge, so the window stays put.
    expect(t.playhead).toBe(to)
    expect(t.mode).toBe('paused')
  })

  test('after going live, a seek pans the window from where it was shown, not where it was stored', () => {
    const { t, live, answer, wheel, track, ui } = zoomable()
    for (let i = 0; i < 6; i++) wheel(-1, track.x + 10)
    live.outbox.push({ type: 'live' })
    answer()
    const end = live.props.view.timeline
    expect(end.to).toBe(t.length)
    // One step back stays inside the end window, so the window must not move.
    live.outbox.push({ type: 'step', dir: -1 })
    answer()
    expect(ui().track).toEqual({ from: end.from, to: end.to })
    expect(windowOf(live.props.view.timeline)).toEqual({ from: end.from, to: end.to })
  })

  test('zooming fully out clears the window', () => {
    const { live, wheel, track, ui } = zoomable()
    for (let i = 0; i < 5; i++) wheel(-1, track.x + 5)
    expect(ui().track).toBeDefined()
    for (let i = 0; i < 10; i++) wheel(1, track.x + 5)
    expect(ui().track).toBeUndefined()
    expect(live.props.view.timeline).toMatchObject({ from: 0, to: live.props.view.timeline.length })
  })

  test('dragging the overview moves the window, pulling the playhead along when the window leaves it', () => {
    const { t, live, answer, wheel, track, ui } = zoomable()
    for (let i = 0; i < 4; i++) wheel(-1, track.x + 5)
    const span = live.props.view.timeline.to - live.props.view.timeline.from
    const o = overviewOf(live.regions.panel)
    onPointer(live, { type: 'down', x: o.x, y: o.y, button: 'left' })
    answer()
    expect(live.props.view.timeline).toMatchObject({ from: 0, to: span })
    expect(t.playhead).toBe(span)
    // Many moves within one frame send one window and one seek.
    for (let x = o.x; x <= o.x + Math.floor(o.w / 2); x++) onPointer(live, { type: 'move', x, y: o.y, button: 'left' })
    onPointer(live, { type: 'up', x: o.x + Math.floor(o.w / 2), y: o.y, button: 'left' })
    expect(live.outbox.size).toBeLessThanOrEqual(2)
    answer()
    const { from, to } = live.props.view.timeline
    expect(to - from).toBe(span)
    expect(ui().track).toEqual({ from, to })
    expect(from).toBeGreaterThan(t.length / 2 - span)
    expect(t.playhead - 1).toBe(from)
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
    on('command.register', () => ({ value: { command: 'lens' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: {} }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'Read', command: 'x' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // Wide enough for the status bar to keep its key hint.
    await ui.resize({ columns: 120, rows: 32 })
    return ui
  }

  test('a key reaches the hooks module and the hint goes away', async ($, on) => {
    const ui = await start($, on)
    expect(await ui.find({ type: 'Text', text: /click for keys/, in: 'graph' })).toBeDefined()
    await ui.key({ key: 'f', in: 'graph' })
    await ui.advance(50)
    expect(await ui.find({ type: 'Text', text: /⌖ manual/, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /click for keys/, in: 'graph' })).toBeUndefined()
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

/** The props a Client is handed live once the first `n` facts have arrived. */
const propsAt = (facts: readonly Fact[], n: number, ui: UiState = EMPTY_UI): Props => {
  const t = new Timeline()
  t.setFacts(facts.slice(0, n))
  return buildProps({ timeline: t, ui, now: 0, prompts: new Map() })
}

/** The cut just before the late child of the wrapped session spawns, and the whole session. */
const beforeAndAfterLateChild = () => {
  const facts = wrapped().numbered()
  const late = facts.findIndex(f => f.kind === 'label' && f.text === 'late child')
  expect(late).toBeGreaterThan(0)
  return { facts, before: propsAt(facts, late - 3), after: propsAt(facts, facts.length) }
}

/** Ticks of 16 ms until `ms` have passed. */
const settle = (live: Live, ms: number) => {
  for (let t = 0; t < ms; t += 16) stepPositions(live, 16)
}

describe('layout in the Client', () => {
  test('a card being dragged freezes the layout, and stays where it was dropped', () => {
    const { before, after } = beforeAndAfterLateChild()
    expect(after.view.agents.length).toBeGreaterThan(before.view.agents.length)
    const live = createLive(before, regions(87, 32, before), 0)
    syncLayout(live, before, true)
    const main = live.positions.main!
    live.screen = new Map([['main', { x: 10, y: 5, w: 30, h: 8 }]])
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    onPointer(live, { type: 'move', x: 17, y: 8, button: 'left' })
    const drop = { x: main.x + 5, y: main.y + 2 }
    const drawn = { ...live.positions }
    const target = live.target
    live.props = after
    syncLayout(live, after, false)
    expect(stepPositions(live, 16)).toBe(false)
    for (const id of Object.keys(drawn)) expect(live.positions[id]).toEqual(drawn[id])
    expect(live.target).toBe(target)

    onPointer(live, { type: 'up', x: 17, y: 8, button: 'left' })
    syncLayout(live, after, false)
    expect(Object.keys(live.target)).toHaveLength(after.view.agents.length)
    expect(live.target.main).toEqual(drop)
    stepPositions(live, 16)
    expect(live.positions.main).toEqual(drop)
    settle(live, 3 * GLIDE_SECS * 1000)
    expect(live.positions).toEqual(live.target)
    expect(live.positions.main).toEqual(drop)
  })

  test('a press that does not move freezes nothing, and a card arriving mid-drag appears', () => {
    const { before, after } = beforeAndAfterLateChild()
    const live = createLive(before, regions(87, 32, before), 0)
    syncLayout(live, before, true)
    live.screen = new Map([['main', { x: 10, y: 5, w: 30, h: 8 }]])
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    syncLayout(live, after, false)
    expect(live.target).toEqual(layout(after.view.agents, {}))

    const held = createLive(before, regions(87, 32, before), 0)
    syncLayout(held, before, true)
    held.screen = live.screen
    onPointer(held, { type: 'down', x: 12, y: 6, button: 'left' })
    onPointer(held, { type: 'move', x: 17, y: 8, button: 'left' })
    const drawn = { ...held.positions }
    syncLayout(held, after, true)
    const fresh = layout(after.view.agents, {})
    for (const a of after.view.agents) expect(held.positions[a.id]).toEqual(drawn[a.id] ?? fresh[a.id])
    // The snap that came in while dragging lands on release.
    onPointer(held, { type: 'up', x: 17, y: 8, button: 'left' })
    syncLayout(held, after, false)
    expect(held.positions).toBe(held.target)
  })

  test('a move with no button held ends a drag whose up was lost', () => {
    const live = liveFor()
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    onPointer(live, { type: 'move', x: 17, y: 8, button: 'left' })
    onPointer(live, { type: 'move', x: 30, y: 9 })
    expect(live.drag).toBeUndefined()
    expect(live.positions.main).toEqual({ x: 15, y: 7 })
    expect(sent(live)).toEqual([{ type: 'pin', id: 'main', x: 15, y: 7 }])
  })

  test('a dropped card is drawn over the cards it lands on, and hit first', () => {
    const { after } = beforeAndAfterLateChild()
    const byLabel = (label: string) => after.view.agents.find(a => a.label === label)!
    const [onto, dropped] = [byLabel('wide lens 1'), byLabel('wide lens 2')]
    const free = layout(after.view.agents, {})[onto.id]!
    const props = { ...after, ui: { ...after.ui, pinned: { [dropped.id]: free } } }
    const live = createLive(props, regions(87, 32, props), 0)
    syncLayout(live, props, true)
    expect([...live.onTop]).toEqual([dropped.id])
    expect(live.target[onto.id]).toEqual(free)
    live.screen = drawScene(new Grid(200, 200), props.view.agents, live.positions, { x: 0, y: 0, z: 1 }, { onTop: live.onTop })
    expect(cardAt(live, free.x + 1, free.y + 1)).toBe(dropped.id)
  })

  test('the pin a drag left wins until the props answer with pins of their own', () => {
    const { after } = beforeAndAfterLateChild()
    const live = createLive(after, regions(87, 32, after), 0)
    syncLayout(live, after, true)
    live.screen = new Map([['main', { x: 10, y: 5, w: 30, h: 8 }]])
    onPointer(live, { type: 'down', x: 12, y: 6, button: 'left' })
    onPointer(live, { type: 'move', x: 17, y: 8, button: 'left' })
    onPointer(live, { type: 'up', x: 17, y: 8, button: 'left' })
    const drop = live.positions.main!
    syncLayout(live, after, false)
    expect(live.target.main).toEqual(drop)
    // The hooks module clamped the pin: the props win.
    const answered = { ...after, ui: { ...after.ui, pinned: { main: { x: 7, y: 7 } } } }
    syncLayout(live, answered, false)
    expect(live.target.main).toEqual({ x: 7, y: 7 })
    expect(live.pins).toEqual({})
  })

  test('an answer for one pin keeps the other pins not yet answered', () => {
    const { after } = beforeAndAfterLateChild()
    const live = createLive(after, regions(87, 32, after), 0)
    syncLayout(live, after, true)
    live.pins = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } }
    syncLayout(live, { ...after, ui: { ...after.ui, pinned: { a: { x: 1, y: 1 } } } }, false)
    expect(live.pins).toEqual({ b: { x: 2, y: 2 } })
  })

  test('moved cards ease to the layout within three glide times; a snap lands them at once', () => {
    const { before, after } = beforeAndAfterLateChild()
    const live = createLive(before, regions(87, 32, before), 0)
    syncLayout(live, before, true)
    const was = live.target
    syncLayout(live, after, false)
    const moved = Object.keys(was).filter(id => was[id]!.y !== live.target[id]!.y)
    expect(moved.length).toBeGreaterThan(0)
    expect(stepPositions(live, 16)).toBe(true)
    for (const id of moved) {
      expect(live.positions[id]!.y).toBeGreaterThan(was[id]!.y)
      expect(live.positions[id]!.y).toBeLessThan(live.target[id]!.y)
    }
    settle(live, 3 * GLIDE_SECS * 1000)
    expect(live.positions).toEqual(live.target)
    expect(stepPositions(live, 16)).toBe(false)

    syncLayout(live, before, true)
    expect(live.positions).toEqual(layout(before.view.agents, {}))
  })

  test('the layout reached live, by a seek or by a fresh mount is the layout of what is shown', () => {
    for (const facts of [waterfall().numbered(), reference().numbered(), wrapped().numbered()]) {
      const cuts = facts.map((_, i) => propsAt(facts, i + 1, { ...EMPTY_UI, pinned: i % 7 === 3 ? { main: { x: 0, y: -40 } } : {} }))
      const live = createLive(cuts[0]!, regions(87, 32, cuts[0]!), 0)
      const check = (p: Props) => expect(live.target).toEqual(layout(p.view.agents, p.ui.pinned))
      for (const p of cuts) {
        syncLayout(live, p, false)
        check(p)
      }
      for (const p of [...cuts].reverse()) {
        syncLayout(live, p, true)
        check(p)
        expect(live.positions).toBe(live.target)
      }
      for (const p of cuts) {
        const fresh = createLive(p, regions(87, 32, p), 0)
        syncLayout(fresh, p, true)
        expect(fresh.target).toEqual(layout(p.view.agents, p.ui.pinned))
      }
    }
  })
})
