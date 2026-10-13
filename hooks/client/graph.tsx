import type { ClientModule } from 'claude-code'

import type { Props, ViewAgent } from '../../types'
import { FRAME_MS } from '../frame'
import { Presentation } from './anim'
import { Camera } from './camera'
import { chipsFor } from './chips'
import { Grid } from './grid'
import { bounds, place, relayout, rectOf, type Positions, type Rect } from './layout'
import { drawMinimap, minimapRect, needsMinimap } from './minimap'
import { paint } from './paint'
import { AMBER, AMBER_DIM, GREY, mix, STATUS_COLOR } from './palette'
import { drawDetails, drawHelp, drawInfo, overlayRect } from './panels'
import { regions, type Regions } from './regions'
import { drawScene } from './scene'
import { drawStatus } from './status-bar'
import { drawPanel } from './timeline-panel'

/** A tree must serialize under 100,000 characters, its text included: a larger region draws only this much. */
const MAX_CELLS = 40_000
const MAX_COLUMNS = 400

/**
 * What one Client instance keeps between draws. Mutated in place: a draw
 * records the props it was handed, and only the frame timer asks for redraws.
 */
export type Live = {
  props: Props
  positions: Positions
  relayoutSeq: number
  camera: Camera
  pres: Presentation
  detailScroll: number
  /** The playhead last drawn, to tell a seek from new facts arriving. */
  playhead: number
  lastTick: number
  isDotLit: boolean
  /** The canvas size last drawn, for camera targets between draws. */
  canvas: Rect
}

type S = { live: Live; frame: number }

const isRunning = (a: ViewAgent) => a.status === 'running'

/** Places new agents, or all of them afresh after a relayout request; existing cards never move otherwise. */
const syncPositions = (live: Live, props: Props): void => {
  const agents = props.view.agents
  if (live.relayoutSeq !== props.ui.relayoutSeq) {
    live.positions = { ...relayout(agents), ...props.ui.pinned }
    live.relayoutSeq = props.ui.relayoutSeq
  } else if (!agents.every(a => live.positions[a.id])) {
    live.positions = place(live.positions, agents, props.ui.pinned)
  }
}

const graphBounds = (props: Props, positions: Positions): Rect | undefined => {
  const rects = props.view.agents.flatMap(a => rectOf(a, positions) ?? [])
  return rects.length ? bounds(rects, 1) : undefined
}

/** Points the camera by its mode: the most recently active agent, the whole graph, or wherever the person left it. */
const aimCamera = (live: Live, canvas: Rect, snap: boolean): void => {
  const { props, positions, camera } = live
  const graph = graphBounds(props, positions)
  if (!graph || props.ui.camera === 'manual') return
  let target
  if (props.ui.camera === 'overview') target = Camera.fit(graph, canvas.w, canvas.h)
  else {
    const active = props.view.agents.reduce<ViewAgent | undefined>((b, a) => (a.kind !== 'group' && (!b || a.lastSeq > b.lastSeq) ? a : b), undefined)
    const rect = active && rectOf(active, positions)
    if (!rect) return
    target = Camera.centre(rect, canvas.w, canvas.h, camera.target?.z ?? camera.z)
  }
  camera.aim(target)
  if (snap) camera.glide(1e9)
}

/** Draws one frame of the whole Client into a grid of `w`×`h`. */
export const drawFrame = (live: Live, r: Regions, w: number, h: number): Grid => {
  const { props, positions, camera, pres } = live
  const g = new Grid(w, h)
  const agents = props.view.agents
  const canvas = new Grid(r.canvas.w, r.canvas.h)
  const pulse = pres.pulse() / 3
  const borders = new Map(agents.filter(isRunning).map(a => [a.id, mix(AMBER_DIM, AMBER, pulse)]))
  drawScene(canvas, agents, positions, camera, {
    selected: props.ui.selected,
    borders,
    ants: { phase: pres.antPhase(), agents: new Set(agents.filter(isRunning).map(a => a.id)) },
    chips: a =>
      chipsFor(a, props.view.runs, run => pres.chipGlow(run) !== undefined).map(c => {
        const run = props.view.runs.find(x => x.key === c.key)!
        const level = pres.chipGlow(run) ?? 0
        return { ...c, color: mix(c.color, GREY[0], (3 - level) / 4) }
      }),
  })
  const graph = graphBounds(props, positions)
  const view = { x: camera.x, y: camera.y, w: r.canvas.w / camera.z, h: r.canvas.h / camera.z }
  if (graph && needsMinimap(graph, view)) {
    const cards = agents.flatMap(a => {
      const rect = rectOf(a, positions)
      return rect ? [{ rect, color: STATUS_COLOR[a.status] }] : []
    })
    drawMinimap(canvas, minimapRect({ x: 0, y: 0, w: canvas.w, h: canvas.h }), graph, cards, view)
  }
  g.blit(canvas, r.canvas.x, r.canvas.y)

  if (r.details && props.details) drawDetails(g, r.details, props.details, live.detailScroll)
  if (props.ui.overlay === 'info' && props.info) drawInfo(g, overlayRect(r.canvas, 52, 10), props.info)
  if (props.ui.overlay === 'help') drawHelp(g, overlayRect(r.canvas, 52, 16))
  if (r.panel.h > 0) drawPanel(g, r.panel, props.view.timeline, r.isCompact)
  drawStatus(g, r.statusY, props.view, { camera: props.ui.camera, isDotLit: live.isDotLit })
  return g
}

/** One frame-clock tick: steps presentation time and the camera, and redraws only while something moves. */
const tick = (surface: Parameters<ClientModule<Props, S>>[1]): void => {
  const s = surface.state
  if (!s) return
  const live = s.live
  const now = performance.now()
  const dt = Math.min(250, now - live.lastTick)
  live.lastTick = now
  const t = live.props.view.timeline.transport
  live.pres.advance(dt, t === 'live' || t === 'playing' || t === 'idle')
  aimCamera(live, live.canvas, false)
  const moved = live.camera.glide(dt)
  const dot = t === 'live' ? live.pres.isDotLit() : true
  const dotFlipped = dot !== live.isDotLit
  live.isDotLit = dot
  const animating = live.props.view.agents.some(isRunning) || live.pres.isGlowing(live.props.view.runs)
  if (animating || moved || dotFlipped) surface.setState({ live, frame: s.frame + 1 })
}

const Graph: ClientModule<Props, S> = (props, surface) => {
  const { Text } = surface.elements
  // A hot reload can run this module against props an older hooks module built.
  if (props?.v !== 1) return <Text dimColor>session-viz: waiting for the session…</Text>
  const cols = Math.max(1, Math.min(MAX_COLUMNS, surface.columns))
  const rows = Math.max(1, Math.min(Math.floor(MAX_CELLS / cols), surface.rows))
  const r = regions(cols, rows, props)
  let live = surface.state?.live
  const isFirst = live === undefined
  if (!live) {
    // A fresh instance (a mount, a remount after a fault or a reload) re-seeds
    // from props: pinned positions and camera mode come back, and everything
    // already settled counts as seen, so nothing flashes.
    live = {
      props,
      positions: {},
      relayoutSeq: -1,
      camera: new Camera(),
      pres: new Presentation(),
      detailScroll: 0,
      playhead: props.view.timeline.playhead,
      lastTick: performance.now(),
      isDotLit: true,
      canvas: r.canvas,
    }
    live.pres.adoptBaseline(props.view.seq)
    surface.setState({ live, frame: 0 })
    surface.every(FRAME_MS, () => tick(surface))
  }
  const t = props.view.timeline
  // A seek, or scrubbing while paused, adopts what is shown as seen.
  if (t.transport === 'paused' || t.transport === 'history' || t.playhead < live.playhead) live.pres.adoptBaseline(props.view.seq)
  live.playhead = t.playhead
  live.props = props
  // A new size is no motion to animate: the camera lands at once.
  const isResized = live.canvas.w !== r.canvas.w || live.canvas.h !== r.canvas.h
  live.canvas = r.canvas
  syncPositions(live, props)
  live.pres.observe(props.view.runs)
  aimCamera(live, r.canvas, isFirst || isResized)
  return paint(surface.elements, drawFrame(live, r, cols, rows)).tree
}

export default Graph
