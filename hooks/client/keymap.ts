// Keys, once a click has given the Client the focus. Transport and overlay
// keys become intents; panning, zooming and details scrolling act on the
// instance at once, and moving the camera by hand leaves it in manual.

import type { ClientKeyEvent } from 'claude-code'

import { Camera } from './camera'
import { cameraMode, closeDetails, graphBounds, resetLayout, setMode, toggleFollow, type Live } from './live'
import { rectOf, type Rect } from './layout'

const PAN_X = 4
const PAN_Y = 2
const ZOOM_STEP = 1.25

const centreOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const pan = (live: Live, dx: number, dy: number): void => {
  live.camera.pan(dx / live.camera.z, dy / live.camera.z)
  setMode(live, 'manual')
}

const zoom = (live: Live, factor: number): void => {
  const c = live.regions.canvas
  live.camera.zoomAt(c.w / 2, c.h / 2, factor)
  setMode(live, 'manual')
}

const scrollDetails = (live: Live, by: number): void => {
  live.detailScroll = Math.max(0, Math.min(live.detailMax, live.detailScroll + by))
  live.isDirty = true
}

const hasDetails = (live: Live) => live.regions.details !== undefined && live.props.details !== undefined

/** Selects `id` and, when its card is off the canvas, brings it into view. */
const select = (live: Live, id: string): void => {
  live.outbox.push({ type: 'select', id })
  const a = live.props.view.agents.find(x => x.id === id)
  const r = a && rectOf(a, live.target)
  const s = live.screen.get(id)
  const c = live.regions.canvas
  const isShown = s !== undefined && s.x >= 0 && s.y >= 0 && s.x + s.w <= c.w && s.y + s.h <= c.h
  if (r && !isShown && cameraMode(live) === 'manual') live.camera.aim(Camera.centre(r, c.w, c.h, live.camera.z))
  live.isDirty = true
}

const cycle = (live: Live, dir: 1 | -1): void => {
  const ids = live.props.view.agents.map(a => a.id)
  if (ids.length === 0) return
  const at = live.props.ui.selected !== undefined ? ids.indexOf(live.props.ui.selected) : -1
  const next = at < 0 ? (dir > 0 ? 0 : ids.length - 1) : (at + dir + ids.length) % ids.length
  select(live, ids[next]!)
}

/** The card nearest the selection (or the canvas centre) in a direction, favouring ones in line. */
const nearest = (live: Live, dx: number, dy: number): string | undefined => {
  const agents = live.props.view.agents
  const from = agents.find(a => a.id === live.props.ui.selected)
  const fr = from && rectOf(from, live.target)
  const c = live.regions.canvas
  const origin = fr ? centreOf(fr) : live.camera.screenToWorld(c.w / 2, c.h / 2)
  let best: string | undefined
  let bestScore = Infinity
  for (const a of agents) {
    if (a.id === from?.id) continue
    const r = rectOf(a, live.target)
    if (!r) continue
    const p = centreOf(r)
    const along = (p.x - origin.x) * dx + (p.y - origin.y) * dy
    if (along <= 0) continue
    const across = Math.abs((p.x - origin.x) * dy) + Math.abs((p.y - origin.y) * dx)
    const score = along + 2 * across
    if (score < bestScore) {
      bestScore = score
      best = a.id
    }
  }
  return best
}

const centre = (live: Live): void => {
  const c = live.regions.canvas
  const a = live.props.view.agents.find(x => x.id === live.props.ui.selected)
  const r = (a && rectOf(a, live.target)) ?? graphBounds(live.props, live.target)
  if (!r) return
  live.camera.aim(Camera.centre(r, c.w, c.h, live.camera.z))
  setMode(live, 'manual')
}

const ARROWS: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }

/** Applies one key to the instance; intents it leads to wait in the outbox. */
export const onKey = (live: Live, e: ClientKeyEvent): void => {
  const out = live.outbox
  const ui = live.props.ui
  const page = Math.max(1, (live.regions.details?.h ?? 3) - 2)
  live.hasKeys = true
  live.isDirty = true
  switch (e.key) {
    case ' ':
    case 'space':
      return out.push({ type: 'play' })
    case '[':
      return out.push({ type: 'seekPrompt', dir: -1 })
    case ']':
      return out.push({ type: 'seekPrompt', dir: 1 })
    case 'g':
    case 'end':
      return out.push({ type: 'live' })
    case 's':
      return out.push({ type: 'compress' })
    case 'o':
      return setMode(live, 'overview')
    case 'f':
      return toggleFollow(live)
    case 'r':
      return resetLayout(live)
    case '?':
      return out.push({ type: 'overlay', overlay: ui.overlay === 'help' ? 'none' : 'help' })
    case 'i':
      return out.push({ type: 'overlay', overlay: ui.overlay === 'info' ? 'none' : 'info' })
    case 'j':
      return hasDetails(live) ? scrollDetails(live, 1) : pan(live, 0, PAN_Y)
    case 'k':
      return hasDetails(live) ? scrollDetails(live, -1) : pan(live, 0, -PAN_Y)
    case 'pagedown':
      return scrollDetails(live, page)
    case 'pageup':
      return scrollDetails(live, -page)
    case 'h':
      return pan(live, -PAN_X, 0)
    case 'l':
      return pan(live, PAN_X, 0)
    case 'tab':
      return cycle(live, e.shift ? -1 : 1)
    case '+':
    case '=':
      return zoom(live, ZOOM_STEP)
    case '-':
      return zoom(live, 1 / ZOOM_STEP)
    case '0':
      return zoom(live, 1 / live.camera.z)
    case 'c':
      return centre(live)
    case 'q':
      return out.push({ type: 'close' })
    case 'x':
      if (ui.overlay !== 'none') return out.push({ type: 'overlay', overlay: 'none' })
      return closeDetails(live)
  }
  const arrow = ARROWS[e.key]
  if (arrow) {
    const id = nearest(live, arrow[0], arrow[1])
    if (id !== undefined) select(live, id)
  }
}
