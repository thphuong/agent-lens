// Pointer input: a card clicked is selected, a card dragged is pinned where
// it lands; the background pans; the timeline track seeks; the camera badge on
// the status bar toggles follow and its layout button lays the cards out
// afresh; a bare move hovers.

import type { ClientPointerEvent } from 'claude-code'

import type { Wheel } from '../../types'
import { cardAt, closeDetails, setMode, toggleFollow, within, type Live } from './live'
import { trackIndexAt, trackOf } from './timeline-panel'

/** How much one wheel tick zooms. */
export const WHEEL_ZOOM = 1.15

const seekTo = (live: Live, x: number): void => {
  const { panel, isCompact } = live.regions
  const length = live.props.view.timeline.length
  live.outbox.push({ type: 'seek', to: trackIndexAt(x, trackOf(panel, isCompact), length) + 1 })
}

const press = (live: Live, e: ClientPointerEvent): void => {
  const r = live.regions
  if (e.y === r.statusY) {
    if (within(e.x, e.y, live.cameraBadge)) toggleFollow(live)
    else if (within(e.x, e.y, live.resetBadge)) live.outbox.push({ type: 'relayout' })
    return
  }
  if (r.panel.h > 0 && within(e.x, e.y, trackOf(r.panel, r.isCompact))) {
    live.drag = { kind: 'track' }
    seekTo(live, e.x)
    return
  }
  if (!within(e.x, e.y, r.canvas)) return
  const id = cardAt(live, e.x - r.canvas.x, e.y - r.canvas.y)
  const at = id !== undefined ? live.positions[id] : undefined
  if (id !== undefined && at) {
    live.drag = { kind: 'node', id, sx: e.x, sy: e.y, ox: at.x, oy: at.y, isMoved: false }
  } else {
    live.drag = { kind: 'pan', sx: e.x, sy: e.y, ox: live.camera.x, oy: live.camera.y, isMoved: false }
  }
}

const dragTo = (live: Live, e: ClientPointerEvent): void => {
  const d = live.drag
  if (!d) return
  if (d.kind === 'track') return seekTo(live, e.x)
  const z = live.camera.z
  const dx = (e.x - d.sx) / z
  const dy = (e.y - d.sy) / z
  if (d.kind === 'node') {
    const x = Math.round(d.ox + dx)
    const y = Math.round(d.oy + dy)
    const at = live.positions[d.id]
    if (at && at.x === x && at.y === y) return
    live.positions = { ...live.positions, [d.id]: { x, y } }
    d.isMoved = true
  } else {
    live.camera.pan(d.ox - dx - live.camera.x, d.oy - dy - live.camera.y)
    if (!d.isMoved) setMode(live, 'manual')
    d.isMoved = true
  }
  live.isDirty = true
}

const release = (live: Live): void => {
  const d = live.drag
  live.drag = undefined
  // A click on the background, not a pan, closes the details.
  if (d?.kind === 'pan' && !d.isMoved) return closeDetails(live)
  if (d?.kind !== 'node') return
  // Selecting opens the details, so only a click selects; a drag only moves.
  if (!d.isMoved) return live.outbox.push({ type: 'select', id: d.id })
  const at = live.positions[d.id]
  if (at) live.outbox.push({ type: 'pin', id: d.id, x: at.x, y: at.y })
}

const hoverAt = (live: Live, e: ClientPointerEvent | undefined): void => {
  const c = live.regions.canvas
  const id = e && within(e.x, e.y, c) ? cardAt(live, e.x - c.x, e.y - c.y) : undefined
  if (id === live.hover) return
  live.hover = id
  live.isDirty = true
}

/** Applies one pointer event to the instance; intents it leads to wait in the outbox. */
export const onPointer = (live: Live, e: ClientPointerEvent): void => {
  switch (e.type) {
    case 'down':
      if (e.button === 'left') press(live, e)
      break
    case 'move':
      if (live.drag) dragTo(live, e)
      else if (e.button === undefined) hoverAt(live, e)
      break
    case 'up':
      release(live)
      break
    case 'leave':
      if (!live.drag) hoverAt(live, undefined)
      break
  }
}

/**
 * Applies a wheel tick the hooks module recorded, once: over the details it
 * scrolls them, over the canvas it zooms about the pointer and leaves the
 * camera where the person put it.
 */
export const applyWheel = (live: Live, wheel: Wheel | undefined): void => {
  if (!wheel || wheel.seq <= live.wheelSeq) return
  live.wheelSeq = wheel.seq
  const r = live.regions
  if (within(wheel.column, wheel.row, r.details)) {
    live.detailScroll = Math.max(0, Math.min(live.detailMax, live.detailScroll + wheel.by))
  } else if (within(wheel.column, wheel.row, r.canvas)) {
    live.camera.zoomAt(wheel.column - r.canvas.x, wheel.row - r.canvas.y, WHEEL_ZOOM ** -wheel.by)
    setMode(live, 'manual')
  } else return
  live.isDirty = true
}
