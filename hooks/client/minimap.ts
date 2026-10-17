// A corner minimap of the whole graph with the viewport shaded, shown only
// when the graph does not fit the view.

import type { DisplayStatus } from '../../types'

import type { Grid } from './grid'
import type { Rect } from './layout'
import { FRAME, GREY, STATUS_COLOR, TEXT } from './palette'

/** The viewport's background in the minimap. */
export const VIEW_SHADE = GREY[0]

/** The minimap's box for a canvas of `w`×`h` cells, in its top-right corner. */
export const minimapRect = (canvas: Rect): Rect => {
  const w = Math.min(24, Math.floor(canvas.w / 4))
  const h = Math.min(8, Math.floor(canvas.h / 4))
  return { x: canvas.x + canvas.w - w, y: canvas.y, w, h }
}

/** Whether the graph's bounds overflow the world rect the viewport shows. */
export const needsMinimap = (graph: Rect, view: Rect): boolean =>
  graph.x < view.x || graph.y < view.y || graph.x + graph.w > view.x + view.w || graph.y + graph.h > view.y + view.h

/** How much a status needs seeing, lowest first: where cards share a cell, the last drawn shows. */
const URGENCY: Record<DisplayStatus, number> = { stopped: 0, done: 1, idle: 2, running: 3, failed: 4 }

/** Draws cards as blocks scaled into `box`, over a shaded block for the viewport. */
export const drawMinimap = (g: Grid, box: Rect, graph: Rect, cards: readonly { rect: Rect; status: DisplayStatus }[], view: Rect): void => {
  if (box.w < 6 || box.h < 4) return
  g.fill(box.x, box.y, box.w, box.h, ' ', TEXT)
  g.box(box.x, box.y, box.w, box.h, FRAME)
  const inner = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 }
  const world = {
    x: Math.min(graph.x, view.x),
    y: Math.min(graph.y, view.y),
    w: Math.max(graph.x + graph.w, view.x + view.w) - Math.min(graph.x, view.x),
    h: Math.max(graph.y + graph.h, view.y + view.h) - Math.min(graph.y, view.y),
  }
  const sx = (x: number) => inner.x + Math.floor(((x - world.x) / Math.max(1, world.w)) * inner.w)
  const sy = (y: number) => inner.y + Math.floor(((y - world.y) / Math.max(1, world.h)) * inner.h)
  const byUrgency = [...cards].sort((a, b) => URGENCY[a.status] - URGENCY[b.status])
  for (const c of byUrgency) g.put(Math.min(inner.x + inner.w - 1, sx(c.rect.x + c.rect.w / 2)), Math.min(inner.y + inner.h - 1, sy(c.rect.y + c.rect.h / 2)), '▪', STATUS_COLOR[c.status])
  // The viewport is a shaded block under the dots, so no card is hidden by it.
  const x0 = sx(view.x)
  const y0 = sy(view.y)
  const x1 = Math.max(x0, Math.min(inner.x + inner.w - 1, sx(view.x + view.w) - 1))
  const y1 = Math.max(y0, Math.min(inner.y + inner.h - 1, sy(view.y + view.h) - 1))
  g.shade(x0, y0, x1 - x0 + 1, y1 - y0 + 1, VIEW_SHADE)
}
