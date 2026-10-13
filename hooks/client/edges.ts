// Tree-character edges: glyphs from the sides a line leaves each cell by,
// joins into card borders, and a bridge where two unrelated edges cross.

import { DOWN, Grid, LEFT, RIGHT, UP, type Pt } from './grid'

export const GLYPH: Record<number, string> = {
  [UP]: '│',
  [DOWN]: '│',
  [UP | DOWN]: '│',
  [LEFT]: '─',
  [RIGHT]: '─',
  [LEFT | RIGHT]: '─',
  [DOWN | RIGHT]: '╭',
  [DOWN | LEFT]: '╮',
  [UP | RIGHT]: '╰',
  [UP | LEFT]: '╯',
  [UP | DOWN | RIGHT]: '├',
  [UP | DOWN | LEFT]: '┤',
  [DOWN | LEFT | RIGHT]: '┬',
  [UP | LEFT | RIGHT]: '┴',
  [UP | DOWN | LEFT | RIGHT]: '┼',
}

export const resolve = (mask: number): string => GLYPH[mask] ?? '┼'

/** The path from a parent's bottom border to a child's top border, through a bar row shared by siblings. */
export const elbow = (from: Pt, to: Pt, barY: number): Pt[] => {
  const mid = Math.max(from.y + 1, Math.min(barY, to.y - 1))
  return [from, { x: from.x, y: mid }, { x: to.x, y: mid }, to]
}

/**
 * The path to a child that is not below its parent (dragged up or level):
 * out of the parent's bottom, along the row under both cards, and up into
 * the child's bottom border.
 */
export const hook = (from: Pt, childBottom: Pt): Pt[] => {
  const y = Math.max(from.y, childBottom.y) + 1
  return [from, { x: from.x, y }, { x: childBottom.x, y }, childBottom]
}

export type StrokeStyle = {
  /** Which edges share a parent: crossings within a family are junctions, across families bridges. */
  family: readonly number[]
  color: (edge: number) => string
  /** Edges whose cells carry travelling ants, and the phase they travel at. */
  ants?: { edges: ReadonlySet<number>; phase: number; color: string }
}

const ANT_SPACING = 6

/**
 * Turns the routed masks into glyphs. Where a horizontal stroke of one family
 * meets a vertical stroke of another, the vertical runs on unbroken: a bridge
 * instead of a misleading junction.
 */
export const strokes = (g: Grid, style: StrokeStyle): void => {
  for (let i = 0; i < g.link.length; i++) {
    const bits = g.link[i]!
    if (!bits) continue
    const h = g.hEdge[i]!
    const v = g.vEdge[i]!
    const crossing = bits === (UP | DOWN | LEFT | RIGHT) && h >= 0 && v >= 0 && style.family[h] !== style.family[v]
    g.ch[i] = crossing ? '│' : resolve(bits)
    const edge = v >= 0 ? v : h
    const ants = style.ants
    const isAnt = ants !== undefined && ants.edges.has(edge) && (((g.step[i]! - ants.phase) % ANT_SPACING) + ANT_SPACING) % ANT_SPACING === 0
    g.fg[i] = isAnt ? ants.color : style.color(edge)
  }
}

/** Columns (relative to x) where an edge meets a card's top and bottom borders; read before the card is drawn over them. */
export const borderJoins = (g: Grid, x: number, y: number, w: number, h: number): { top: number[]; bottom: number[] } => {
  const top: number[] = []
  const bottom: number[] = []
  for (let k = 1; k < w - 1; k++) {
    if (g.linkAt(x + k, y) & UP) top.push(k)
    if (g.linkAt(x + k, y + h - 1) & DOWN) bottom.push(k)
  }
  return { top, bottom }
}

/** Puts the junction glyphs into a drawn card's borders. */
export const drawJoins = (g: Grid, x: number, y: number, h: number, joins: { top: number[]; bottom: number[] }, color: string): void => {
  for (const k of joins.top) g.put(x + k, y, '┴', color)
  for (const k of joins.bottom) g.put(x + k, y + h - 1, '┬', color)
}
