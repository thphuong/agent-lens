import type { ClientModule } from 'claude-code'

import type { Props } from '../../types'
import { chipsFor } from './chips'
import { Grid } from './grid'
import { bounds, place, relayout, rectOf, type Positions, type Rect } from './layout'
import { drawMinimap, minimapRect, needsMinimap } from './minimap'
import { paint } from './paint'
import { STATUS_COLOR } from './palette'
import { drawDetails, drawHelp, drawInfo, overlayRect } from './panels'
import { regions } from './regions'
import { drawScene, type Camera } from './scene'
import { drawStatus } from './status-bar'
import { drawPanel } from './timeline-panel'

/** A tree must serialize under 100,000 characters, its text included: a larger region draws only this much. */
const MAX_CELLS = 40_000
const MAX_COLUMNS = 400

type S = {
  positions: Positions
  /** The relayout request this instance last honoured. */
  relayoutSeq: number
  detailScroll: number
}

/** Positions for the agents in view: kept, pinned, or newly placed; all afresh after a relayout request. */
const positionsFor = (props: Props, s: S | undefined): Positions => {
  const agents = props.view.agents
  if (!s || s.relayoutSeq !== props.ui.relayoutSeq) return { ...relayout(agents), ...props.ui.pinned }
  if (agents.every(a => s.positions[a.id])) return s.positions
  return place(s.positions, agents, props.ui.pinned)
}

/** A still camera fitting the whole graph, centred, never zoomed in past 1. */
const staticCamera = (graph: Rect | undefined, w: number, h: number): Camera => {
  if (!graph) return { x: 0, y: -1, z: 1 }
  const b = { ...graph, x: graph.x - 1, y: graph.y - 1, w: graph.w + 2, h: graph.h + 2 }
  const z = Math.min(1, w / b.w, h / b.h)
  return { x: b.x - (w / z - b.w) / 2, y: b.y, z }
}

/** Draws one frame of the whole Client into a grid of `w`×`h`. */
export const drawFrame = (props: Props, positions: Positions, w: number, h: number, detailScroll: number): Grid => {
  const g = new Grid(w, h)
  const r = regions(w, h, props)
  const agents = props.view.agents
  const rects = agents.flatMap(a => {
    const rect = rectOf(a, positions)
    return rect ? [{ rect, color: STATUS_COLOR[a.status] }] : []
  })
  const graph = rects.length ? bounds(rects.map(c => c.rect)) : undefined
  const cam = staticCamera(graph, r.canvas.w, r.canvas.h)

  const canvas = new Grid(r.canvas.w, r.canvas.h)
  drawScene(canvas, agents, positions, cam, {
    selected: props.ui.selected,
    chips: a => chipsFor(a, props.view.runs),
  })
  const view = { x: cam.x, y: cam.y, w: r.canvas.w / cam.z, h: r.canvas.h / cam.z }
  if (graph && needsMinimap(graph, view)) drawMinimap(canvas, minimapRect({ x: 0, y: 0, w: canvas.w, h: canvas.h }), graph, rects, view)
  g.blit(canvas, r.canvas.x, r.canvas.y)

  if (r.details && props.details) drawDetails(g, r.details, props.details, detailScroll)
  if (props.ui.overlay === 'info' && props.info) drawInfo(g, overlayRect(r.canvas, 52, 10), props.info)
  if (props.ui.overlay === 'help') drawHelp(g, overlayRect(r.canvas, 52, 16))
  if (r.panel.h > 0) drawPanel(g, r.panel, props.view.timeline, r.isCompact)
  drawStatus(g, r.statusY, props.view, { camera: props.ui.camera })
  return g
}

const Graph: ClientModule<Props, S> = (props, surface) => {
  const { Text } = surface.elements
  // A hot reload can run this module against props an older hooks module built.
  if (props?.v !== 1) return <Text dimColor>session-viz: waiting for the session…</Text>
  const s = surface.state
  const positions = positionsFor(props, s)
  if (s?.positions !== positions) {
    // New props are an event between draws, so this is no render loop.
    surface.setState({ positions, relayoutSeq: props.ui.relayoutSeq, detailScroll: s?.detailScroll ?? 0 })
  }
  const cols = Math.max(1, Math.min(MAX_COLUMNS, surface.columns))
  const rows = Math.max(1, Math.min(Math.floor(MAX_CELLS / cols), surface.rows))
  return paint(surface.elements, drawFrame(props, positions, cols, rows, s?.detailScroll ?? 0)).tree
}

export default Graph
