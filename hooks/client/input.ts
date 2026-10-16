// Pointer input: a card clicked is selected, a card dragged is pinned where
// it lands; the background pans; the timeline track seeks, and the overview
// in its top border moves a zoomed track's window; the camera badge on the
// status bar toggles follow and its layout button clears the dragged
// positions; a bare move hovers.

import type { ClientPointerEvent } from 'claude-code'

import type { Wheel } from '../../types'
import { cardAt, closeDetails, resetLayout, setMode, toggleFollow, within, type Live } from './live'
import { isZoomed, overviewOf, trackIndexAt, trackOf, windowOf } from './timeline-panel'

/** How much one wheel tick zooms. */
export const WHEEL_ZOOM = 1.15
/** How much one wheel tick over the timeline track scales the span it shows. */
export const TRACK_ZOOM = 1.5

const seekTo = (live: Live, x: number): void => {
  const { panel, isCompact } = live.regions
  live.outbox.push({ type: 'seek', to: trackIndexAt(x, trackOf(panel, isCompact), windowOf(live.props.view.timeline)) + 1 })
}

/**
 * Asks for the track to show `[from, from + span)`, or all of the timeline
 * once the span covers it. The window must hold the playhead, or it would
 * pan straight back to it, so a playhead it leaves out is pulled to its
 * nearest edge.
 */
const showWindow = (live: Live, from: number, span: number): void => {
  const { length, playhead } = live.props.view.timeline
  if (span >= length) return live.outbox.push({ type: 'track', from: null })
  const at = Math.max(0, Math.min(length - span, Math.round(from)))
  live.outbox.push({ type: 'track', from: at, to: at + span })
  if (playhead - 1 < at) live.outbox.push({ type: 'seek', to: at + 1 })
  else if (playhead > at + span) live.outbox.push({ type: 'seek', to: at + span })
}

/**
 * Zooms the track about the fact under column `x`, which stays under it. The
 * span never drops below the track's width, so fully zoomed in one column is
 * one fact.
 */
const zoomTrack = (live: Live, x: number, by: number): void => {
  const t = live.props.view.timeline
  const track = trackOf(live.regions.panel, live.regions.isCompact)
  const span = t.to - t.from
  const least = Math.min(t.length, track.w)
  let next = Math.max(least, Math.round(span * TRACK_ZOOM ** by))
  // A small span must still move by a fact each tick.
  if (next === span && by !== 0) next = Math.max(least, span + Math.sign(by))
  if (next === span) return
  const at = trackIndexAt(x, track, windowOf(t))
  showWindow(live, at - ((at - t.from) / span) * next, next)
}

/** Centres a zoomed track's window on the fact under column `x` of the overview. */
const moveWindow = (live: Live, x: number): void => {
  const t = live.props.view.timeline
  const span = t.to - t.from
  showWindow(live, trackIndexAt(x, overviewOf(live.regions.panel), { from: 0, to: t.length }) - Math.floor(span / 2), span)
}

const press = (live: Live, e: ClientPointerEvent): void => {
  const r = live.regions
  if (e.y === r.statusY) {
    if (within(e.x, e.y, live.cameraBadge)) toggleFollow(live)
    else if (within(e.x, e.y, live.resetBadge)) resetLayout(live)
    return
  }
  if (r.panel.h > 0 && within(e.x, e.y, trackOf(r.panel, r.isCompact))) {
    live.drag = { kind: 'track' }
    seekTo(live, e.x)
    return
  }
  if (r.panel.h > 0 && !r.isCompact && isZoomed(live.props.view.timeline) && within(e.x, e.y, overviewOf(r.panel))) {
    live.drag = { kind: 'window' }
    moveWindow(live, e.x)
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
  if (d.kind === 'window') return moveWindow(live, e.x)
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
  if (!at) return
  // Pinned here too, so the next layout keeps the card where it was dropped
  // before the hooks module answers.
  live.pins = { ...live.pins, [d.id]: at }
  live.outbox.push({ type: 'pin', id: d.id, x: at.x, y: at.y })
  live.isDirty = true
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
      // No button held means the up was lost: the drag is over.
      if (live.drag && e.button === undefined) release(live)
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
 * scrolls them, over the timeline track it zooms the track about the pointer,
 * over the canvas it zooms about the pointer and leaves the camera where the
 * person put it.
 */
export const applyWheel = (live: Live, wheel: Wheel | undefined): void => {
  if (!wheel || wheel.seq <= live.wheelSeq) return
  live.wheelSeq = wheel.seq
  const r = live.regions
  if (within(wheel.column, wheel.row, r.details)) {
    live.detailScroll = Math.max(0, Math.min(live.detailMax, live.detailScroll + wheel.by))
  } else if (r.panel.h > 0 && within(wheel.column, wheel.row, trackOf(r.panel, r.isCompact))) {
    zoomTrack(live, wheel.column, wheel.by)
  } else if (within(wheel.column, wheel.row, r.canvas)) {
    live.camera.zoomAt(wheel.column - r.canvas.x, wheel.row - r.canvas.y, WHEEL_ZOOM ** -wheel.by)
    setMode(live, 'manual')
  } else return
  live.isDirty = true
}
