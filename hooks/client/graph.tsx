import type { ClientModule } from 'claude-code'

import type { Props } from '../../types'
import { Grid } from './grid'
import { bounds, place, relayout, rectOf, type Positions } from './layout'
import { paint } from './paint'
import { drawScene, type Camera } from './scene'

/** A tree must serialize under 100,000 characters, its text included: a larger region draws only this much. */
const MAX_CELLS = 40_000
const MAX_COLUMNS = 400

type S = {
  positions: Positions
  /** The relayout request this instance last honoured. */
  relayoutSeq: number
}

/** Positions for the agents in view: kept, pinned, or newly placed; all afresh after a relayout request. */
const positionsFor = (props: Props, s: S | undefined): Positions => {
  const agents = props.view.agents
  if (!s || s.relayoutSeq !== props.ui.relayoutSeq) return { ...relayout(agents), ...props.ui.pinned }
  if (agents.every(a => s.positions[a.id])) return s.positions
  return place(s.positions, agents, props.ui.pinned)
}

/** A still camera fitting the whole graph, centred, never zoomed in past 1. */
const staticCamera = (props: Props, positions: Positions, w: number, h: number): Camera => {
  const rects = props.view.agents.flatMap(a => rectOf(a, positions) ?? [])
  if (rects.length === 0) return { x: 0, y: -1, z: 1 }
  const b = bounds(rects, 1)
  const z = Math.min(1, w / b.w, h / b.h)
  return { x: b.x - (w / z - b.w) / 2, y: b.y, z }
}

const Graph: ClientModule<Props, S> = (props, surface) => {
  const { Text } = surface.elements
  // A hot reload can run this module against props an older hooks module built.
  if (props?.v !== 1) return <Text dimColor>session-viz: waiting for the session…</Text>
  const positions = positionsFor(props, surface.state)
  if (surface.state?.positions !== positions) {
    // New props are an event between draws, so this is no render loop.
    surface.setState({ positions, relayoutSeq: props.ui.relayoutSeq })
  }
  const cols = Math.max(1, Math.min(MAX_COLUMNS, surface.columns))
  const g = new Grid(cols, Math.max(1, Math.min(Math.floor(MAX_CELLS / cols), surface.rows)))
  drawScene(g, props.view.agents, positions, staticCamera(props, positions, g.w, g.h), { selected: props.ui.selected })
  return paint(surface.elements, g).tree
}

export default Graph
