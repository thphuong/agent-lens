// Splits the Client's region into the graph canvas, the details slot, the
// timeline panel and the status bar.

import type { Props } from '../../types'
import type { Rect } from './layout'
import { DETAILS_RIGHT_MIN } from './panels'
import { FULL_PANEL_ROWS, panelRows } from './timeline-panel'

export type Regions = {
  canvas: Rect
  details?: Rect
  panel: Rect
  isCompact: boolean
  statusY: number
}

export const regions = (w: number, h: number, props: Props): Regions => {
  const isCompact = h < FULL_PANEL_ROWS
  const ph = Math.min(panelRows(props.view.timeline, isCompact), Math.max(0, h - 2))
  const statusY = h - 1
  const panel = { x: 0, y: statusY - ph, w, h: ph }
  let canvas: Rect = { x: 0, y: 0, w, h: Math.max(1, panel.y) }
  let details: Rect | undefined
  if (props.details) {
    if (w >= DETAILS_RIGHT_MIN) {
      const dw = Math.min(40, Math.floor(w * 0.42))
      details = { x: w - dw, y: 0, w: dw, h: canvas.h }
      canvas = { ...canvas, w: w - dw }
    } else {
      const dh = Math.min(12, Math.floor(canvas.h / 2))
      details = { x: 0, y: canvas.h - dh, w, h: dh }
      canvas = { ...canvas, h: canvas.h - dh }
    }
  }
  return { canvas, details, panel, isCompact, statusY }
}
