// What one Client instance keeps between draws, mutated in place: a draw
// records the props it was handed and what it drew, input edits it, and only
// the frame timer asks for redraws.

import type { CameraMode, Intent, Point, Props, ViewAgent } from '../../types'
import { Presentation } from './anim'
import { Camera, glideK, SNAP } from './camera'
import { bounds, layout, rectOf, type Positions, type Rect } from './layout'
import { Outbox } from './outbox'
import type { Regions } from './regions'

export type Drag =
  | { kind: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; isMoved: boolean }
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number; isMoved: boolean }
  | { kind: 'track' }

export type Live = {
  props: Props
  /** Where each card is drawn: easing toward `target`, or under the pointer while dragged. */
  positions: Positions
  /** Where the layout puts each card, for the agents shown and the pins. */
  target: Positions
  /** What `target` was laid out from: the agents' ids, parents, kinds and waves, and the pins. */
  layoutKey: string
  /**
   * Pins of drags released before the hooks module answered with them. A
   * props pin that changed since `pinsSeen` drops the local one, so props win.
   */
  pins: Positions
  pinsSeen: Readonly<Positions>
  /** A jump that arrived while a card was dragged, to land on release. */
  isSnapPending: boolean
  /** The pinned cards and what hangs under them, drawn over the rest. */
  onTop: Set<string>
  camera: Camera
  /**
   * The camera mode input switched to before the hooks module answered with
   * it; while set it wins over the props, so follow never fights a pan.
   */
  mode?: CameraMode
  pres: Presentation
  detailScroll: number
  /** The largest useful details scroll, as last drawn. */
  detailMax: number
  /** The playhead last drawn, to tell a seek from new facts arriving. */
  playhead: number
  lastTick: number
  isDotLit: boolean
  regions: Regions
  /** Each card's rect on the canvas as last drawn, for hit-testing. */
  screen: Map<string, Rect>
  /** Where the status bar drew its camera mode and layout reset buttons, as last drawn. */
  cameraBadge?: Rect
  resetBadge?: Rect
  drag?: Drag
  hover?: string
  outbox: Outbox
  /** The last wheel tick applied, so a remount never applies a stale one again. */
  wheelSeq: number
  /** Whether a key has reached this instance: until then the status bar hints at clicking. */
  hasKeys: boolean
  /** Set by input to ask the frame timer for a redraw. */
  isDirty: boolean
}

export const createLive = (props: Props, regions: Regions, now: number): Live => {
  const live: Live = {
    props,
    positions: {},
    target: {},
    layoutKey: '',
    pins: {},
    pinsSeen: props.ui.pinned,
    isSnapPending: false,
    onTop: new Set(),
    camera: new Camera(),
    pres: new Presentation(),
    detailScroll: 0,
    detailMax: 0,
    playhead: props.view.timeline.playhead,
    lastTick: now,
    isDotLit: true,
    regions,
    screen: new Map(),
    outbox: new Outbox(),
    wheelSeq: props.ui.wheel?.seq ?? 0,
    hasKeys: false,
    isDirty: false,
  }
  live.pres.adoptBaseline(props.view.seq)
  return live
}

const pinsKey = (pins: Readonly<Positions>): string =>
  Object.keys(pins)
    .sort()
    .map(id => `${id}@${pins[id]!.x},${pins[id]!.y}`)
    .join(';')

/** Whether a card is being dragged: the layout holds still until it is dropped. */
export const isFrozen = (live: Live): boolean => live.drag?.kind === 'node' && live.drag.isMoved

const samePoint = (a: Point | undefined, b: Point | undefined) => a?.x === b?.x && a?.y === b?.y

/**
 * Lays the cards out again when the agents shown or the pins changed, and
 * with `snap` draws them where they belong at once. While a card is dragged
 * no card moves, though a card that arrives meanwhile appears where the
 * layout puts it; the rest applies on release.
 */
export const syncLayout = (live: Live, props: Props, snap: boolean): void => {
  const agents = props.view.agents
  if (isFrozen(live)) {
    live.isSnapPending ||= snap
    const missing = agents.filter(a => !live.positions[a.id])
    if (missing.length === 0) return
    const fresh = layout(agents, { ...props.ui.pinned, ...live.pins })
    live.positions = { ...live.positions }
    for (const a of missing) live.positions[a.id] = fresh[a.id]!
    return
  }
  snap ||= live.isSnapPending
  live.isSnapPending = false
  if (props.ui.pinned !== live.pinsSeen) {
    const pins: Positions = {}
    for (const [id, p] of Object.entries(live.pins)) if (samePoint(props.ui.pinned[id], live.pinsSeen[id])) pins[id] = p
    live.pins = pins
    live.pinsSeen = props.ui.pinned
  }
  const pinned = { ...props.ui.pinned, ...live.pins }
  const key = `${agents.map(a => `${a.id}<${a.parent ?? ''}:${a.kind}:${a.wave}`).join(' ')}|${pinsKey(pinned)}`
  if (key !== live.layoutKey) {
    live.layoutKey = key
    live.target = layout(agents, pinned)
    const kids = new Map<string, string[]>()
    for (const a of agents) if (a.parent !== undefined) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a.id])
    const onTop = new Set<string>()
    const add = (id: string, depth: number) => {
      if (onTop.has(id) || depth > 64) return
      onTop.add(id)
      for (const c of kids.get(id) ?? []) add(c, depth + 1)
    }
    for (const a of agents) if (pinned[a.id]) add(a.id, 0)
    live.onTop = onTop
  }
  if (snap) live.positions = live.target
}

/** Eases each drawn card toward the layout by one step of `dtMs`; answers whether any card moved. */
export const stepPositions = (live: Live, dtMs: number): boolean => {
  if (isFrozen(live) || live.positions === live.target) return false
  const k = glideK(dtMs)
  const next: Positions = {}
  let isSettled = true
  for (const [id, t] of Object.entries(live.target)) {
    const p = live.positions[id]
    const x = p ? p.x + (t.x - p.x) * k : t.x
    const y = p ? p.y + (t.y - p.y) * k : t.y
    const isNear = Math.abs(t.x - x) < SNAP && Math.abs(t.y - y) < SNAP
    next[id] = isNear ? t : { x, y }
    if (!isNear) isSettled = false
  }
  live.positions = isSettled ? live.target : next
  return true
}

/** Clears every dragged position: those not yet answered at once, the rest when the hooks module answers. */
export const resetLayout = (live: Live): void => {
  live.pins = {}
  live.outbox.push({ type: 'relayout' })
  live.isDirty = true
}

export const isRunning = (a: ViewAgent) => a.status === 'running'

export const cameraMode = (live: Live): CameraMode => live.mode ?? live.props.ui.camera

/** Switches the camera mode now and tells the hooks module; `extra` rides in the same batch. */
export const setMode = (live: Live, mode: CameraMode, ...extra: Intent[]): void => {
  if (cameraMode(live) !== mode) {
    live.mode = mode
    live.outbox.push({ type: 'camera', mode })
  }
  live.outbox.push(...extra)
  live.isDirty = true
}

/** Follow when it is not following, else manual; follow also follows the details. */
export const toggleFollow = (live: Live): void => {
  const on = cameraMode(live) !== 'follow'
  setMode(live, on ? 'follow' : 'manual', { type: 'detailFollow', on })
}

/** Clears the selection and stops the details following the active agent, which closes the details. */
export const closeDetails = (live: Live): void => {
  const ui = live.props.ui
  if (ui.selected !== undefined) live.outbox.push({ type: 'select', id: null })
  if (ui.detailFollow) live.outbox.push({ type: 'detailFollow', on: false })
  live.isDirty = true
}

export const graphBounds = (props: Props, positions: Positions): Rect | undefined => {
  const rects = props.view.agents.flatMap(a => rectOf(a, positions) ?? [])
  return rects.length ? bounds(rects, 1) : undefined
}

export const within = (x: number, y: number, r: Rect | undefined): boolean =>
  r !== undefined && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h

/** The card under canvas cell (x, y), topmost first. */
export const cardAt = (live: Live, x: number, y: number): string | undefined => {
  const hits = [...live.screen].filter(([, r]) => within(x, y, r))
  return hits.at(-1)?.[0]
}
