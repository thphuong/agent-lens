import type { ClientModule } from 'claude-code'

import type { Props, ViewAgent } from '../../types'
import { FRAME_MS } from '../frame'
import { Camera } from './camera'
import { chipsFor } from './chips'
import { Grid } from './grid'
import { applyWheel, onPointer } from './input'
import { onKey } from './keymap'
import { rectOf, type Rect } from './layout'
import { cameraMode, createLive, graphBounds, isRunning, stepPositions, syncLayout, type Live } from './live'
import { drawMinimap, minimapRect, needsMinimap } from './minimap'
import { paint } from './paint'
import { AMBER, AMBER_DIM, GREY, mix, STATUS_COLOR } from './palette'
import { drawDetails, drawHelp, drawInfo, KEYMAP, overlayRect } from './panels'
import { regions, type Regions } from './regions'
import { drawScene } from './scene'
import { drawStatus } from './status-bar'
import { drawPanel } from './timeline-panel'

/** A tree must serialize under 100,000 characters, its text included: a larger region draws only this much. */
const MAX_CELLS = 40_000
const MAX_COLUMNS = 400
const KEY_HINT = 'click for keys'

type S = { live: Live; frame: number }

/**
 * Points the camera by its mode: the most recently active agent, the whole
 * graph, or wherever the person left it. It aims where the layout puts the
 * cards, so it glides to the same end as they do.
 */
const aimCamera = (live: Live, canvas: Rect, snap: boolean): void => {
  const { props, target: positions, camera } = live
  const mode = cameraMode(live)
  const graph = graphBounds(props, positions)
  // A card being dragged stays under the pointer: the camera holds still.
  if (!graph || mode === 'manual' || live.drag) return
  let target
  if (mode === 'overview') target = Camera.fit(graph, canvas.w, canvas.h)
  else {
    const active = props.view.agents.reduce<ViewAgent | undefined>((b, a) => (a.kind !== 'group' && (!b || a.lastSeq > b.lastSeq) ? a : b), undefined)
    const rect = active && rectOf(active, positions)
    if (!rect) return
    target = Camera.centre(rect, canvas.w, canvas.h, camera.target?.z ?? camera.z)
  }
  camera.aim(target)
  if (snap) camera.glide(1e9)
}

/** Draws one frame of the whole Client into a grid of `w`×`h`, noting what input hit-tests against. */
export const drawFrame = (live: Live, r: Regions, w: number, h: number): Grid => {
  const { props, positions, camera, pres } = live
  const g = new Grid(w, h)
  const agents = props.view.agents
  const canvas = new Grid(r.canvas.w, r.canvas.h)
  const pulse = pres.pulse() / 3
  const borders = new Map(agents.filter(isRunning).map(a => [a.id, mix(AMBER_DIM, AMBER, pulse)]))
  const onTop = live.drag?.kind === 'node' && live.drag.isMoved ? new Set([...live.onTop, live.drag.id]) : live.onTop
  live.screen = drawScene(canvas, agents, positions, camera, {
    onTop,
    hover: live.hover,
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

  if (r.details && props.details) {
    live.detailMax = drawDetails(g, r.details, props.details, live.detailScroll)
    live.detailScroll = Math.min(live.detailScroll, live.detailMax)
  }
  if (props.ui.overlay === 'info' && props.info) drawInfo(g, r.canvas, props.info)
  if (props.ui.overlay === 'help') drawHelp(g, overlayRect(r.canvas, 52, KEYMAP.length + 2))
  if (r.panel.h > 0) drawPanel(g, r.panel, props.view.timeline, r.isCompact)
  const status = drawStatus(g, r.statusY, props.view, { camera: cameraMode(live), hint: live.hasKeys ? undefined : KEY_HINT, isDotLit: live.isDotLit })
  live.cameraBadge = status.camera
  live.resetBadge = status.reset
  return g
}

/** One frame-clock tick: sends queued intents, steps presentation time, the cards and the camera, and redraws only while something moves. */
const tick = (surface: Parameters<ClientModule<Props, S>>[1]): void => {
  const s = surface.state
  if (!s) return
  const live = s.live
  const batch = live.outbox.take()
  if (batch) surface.post({ ...batch, renumbered: live.props.view.renumbered })
  const now = performance.now()
  const dt = Math.min(250, now - live.lastTick)
  live.lastTick = now
  const t = live.props.view.timeline.transport
  live.pres.advance(dt, t === 'live' || t === 'playing' || t === 'idle')
  aimCamera(live, live.regions.canvas, false)
  const eased = stepPositions(live, dt)
  const moved = live.camera.glide(dt)
  const dot = t === 'live' ? live.pres.isDotLit() : true
  const dotFlipped = dot !== live.isDotLit
  live.isDotLit = dot
  const animating = live.props.view.agents.some(isRunning) || live.pres.isGlowing(live.props.view.runs)
  if (animating || eased || moved || dotFlipped || live.isDirty) {
    live.isDirty = false
    surface.setState({ live, frame: s.frame + 1 })
  }
}

const Graph: ClientModule<Props, S> = (props, surface) => {
  const { Text } = surface.elements
  // A hot reload can run this module against props an older hooks module built.
  if (props?.v !== 1) return <Text dimColor>agent-lens: waiting for the session…</Text>
  const cols = Math.max(1, Math.min(MAX_COLUMNS, surface.columns))
  const rows = Math.max(1, Math.min(Math.floor(MAX_CELLS / cols), surface.rows))
  const r = regions(cols, rows, props)
  let live = surface.state?.live
  const isFirst = live === undefined
  if (!live) {
    // A fresh instance (a mount, a remount after a fault or a reload) re-seeds
    // from props: pinned positions and camera mode come back, and everything
    // already settled counts as seen, so nothing flashes.
    live = createLive(props, r, performance.now())
    const it = live
    surface.setState({ live, frame: 0 })
    surface.every(FRAME_MS, () => tick(surface))
    surface.onPointer(e => onPointer(it, e))
    surface.onKey(e => onKey(it, e))
  }
  const t = props.view.timeline
  // A seek, or scrubbing while paused, adopts what is shown as seen, and the
  // cards land where they belong with no easing. So does imported history
  // renumbering the log, which also changes arrival order and so the layout.
  const isRenumbered = props.view.renumbered !== live.props.view.renumbered
  const isJump = isFirst || isRenumbered || t.transport === 'paused' || t.transport === 'history' || t.playhead < live.playhead
  if (isJump) live.pres.adoptBaseline(props.view.seq)
  live.playhead = t.playhead
  if (props.details?.agent !== live.props.details?.agent) live.detailScroll = 0
  live.props = props
  if (live.mode === props.ui.camera) live.mode = undefined
  // A new size is no motion to animate: the camera lands at once.
  const isResized = live.regions.canvas.w !== r.canvas.w || live.regions.canvas.h !== r.canvas.h
  live.regions = r
  syncLayout(live, props, isJump)
  live.pres.observe(props.view.runs)
  applyWheel(live, props.ui.wheel)
  aimCamera(live, r.canvas, isFirst || isResized)
  return paint(surface.elements, drawFrame(live, r, cols, rows)).tree
}

export default Graph
