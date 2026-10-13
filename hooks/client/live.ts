// What one Client instance keeps between draws, mutated in place: a draw
// records the props it was handed and what it drew, input edits it, and only
// the frame timer asks for redraws.

import type { CameraMode, Intent, Props, ViewAgent } from '../../types'
import { Presentation } from './anim'
import { Camera } from './camera'
import { bounds, rectOf, type Positions, type Rect } from './layout'
import { Outbox } from './outbox'
import type { Regions } from './regions'

export type Drag =
  | { kind: 'node'; id: string; sx: number; sy: number; ox: number; oy: number; isMoved: boolean }
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number; isMoved: boolean }
  | { kind: 'track' }

export type Live = {
  props: Props
  positions: Positions
  relayoutSeq: number
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
    relayoutSeq: -1,
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
