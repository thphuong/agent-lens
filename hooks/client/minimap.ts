// A corner minimap of the whole graph with the viewport outlined, shown only
// when the graph does not fit the view.

import type { Grid } from './grid'
import type { Rect } from './layout'
import { FRAME, GREY, TEXT } from './palette'

/** The minimap's box for a canvas of `w`×`h` cells, in its top-right corner. */
export const minimapRect = (canvas: Rect): Rect => {
  const w = Math.min(24, Math.floor(canvas.w / 4))
  const h = Math.min(8, Math.floor(canvas.h / 4))
  return { x: canvas.x + canvas.w - w, y: canvas.y, w, h }
}

/** Whether the graph's bounds overflow the world rect the viewport shows. */
export const needsMinimap = (graph: Rect, view: Rect): boolean =>
  graph.x < view.x || graph.y < view.y || graph.x + graph.w > view.x + view.w || graph.y + graph.h > view.y + view.h

/** Draws cards as blocks scaled into `box`, and the viewport's outline. */
export const drawMinimap = (g: Grid, box: Rect, graph: Rect, cards: readonly { rect: Rect; color: string }[], view: Rect): void => {
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
  for (const c of cards) g.put(Math.min(inner.x + inner.w - 1, sx(c.rect.x + c.rect.w / 2)), Math.min(inner.y + inner.h - 1, sy(c.rect.y + c.rect.h / 2)), '▪', c.color)
  const x0 = sx(view.x)
  const y0 = sy(view.y)
  const x1 = Math.min(inner.x + inner.w - 1, sx(view.x + view.w) - 1)
  const y1 = Math.min(inner.y + inner.h - 1, sy(view.y + view.h) - 1)
  for (let x = x0; x <= x1; x++) {
    g.put(x, y0, '·', GREY[3])
    g.put(x, y1, '·', GREY[3])
  }
  for (let y = y0; y <= y1; y++) {
    g.put(x0, y, '·', GREY[3])
    g.put(x1, y, '·', GREY[3])
  }
}
