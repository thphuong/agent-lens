// Paints a grid as one Text per row holding runs of same-coloured cells. A
// Client tree must serialize under 100,000 characters, so the painter counts
// as it builds and, past its budget, paints again with coarser colours.

import type { ClientElements, RenderElement } from 'claude-code'

import type { Grid } from './grid'
import { quantize } from './palette'

export const PAINT_BUDGET = 90_000
/** What one run costs serialized beyond its text: the element and its colour prop. */
const RUN_COST = 48
const ROW_COST = 64
/** What a background prop adds to a run beyond its colour's text. */
const BG_COST = 20

const BASE = ['#000000', '#ff5f5f', '#5fd75f', '#d7af00', '#5f87af', '#af5faf', '#5fafaf', '#d0d0d0', '#808080', '#ffffff']

const nearestBase = (hex: string): string => {
  if (!hex.startsWith('#')) return hex
  const n = Number.parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  let best = BASE[0]!
  let bestD = Infinity
  for (const b of BASE) {
    const m = Number.parseInt(b.slice(1), 16)
    const d = (rgb[0]! - ((m >> 16) & 255)) ** 2 + (rgb[1]! - ((m >> 8) & 255)) ** 2 + (rgb[2]! - (m & 255)) ** 2
    if (d < bestD) {
      bestD = d
      best = b
    }
  }
  return best
}

export type Run = { text: string; color: string; bg?: string }
export type Row = { runs: Run[] }

const runsOf = (g: Grid, mapColor: (c: string) => string): { rows: Row[]; cost: number } => {
  const rows: Row[] = []
  let cost = 0
  for (let y = 0; y < g.h; y++) {
    const runs: Run[] = []
    let text = ''
    let color = ''
    let bg = ''
    const flush = () => {
      runs.push(bg ? { text, color, bg } : { text, color })
      cost += RUN_COST + text.length + color.length + (bg ? BG_COST + bg.length : 0)
      text = ''
    }
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x
      const ch = g.ch[i]!
      const b = g.bg[i] ? mapColor(g.bg[i]!) : ''
      // A blank cell takes the colour of the run it sits in, unless its background differs.
      const c = (ch === ' ' || ch === '') && b === bg ? color : mapColor(g.fg[i]!)
      if ((c !== color || b !== bg) && text) flush()
      color = c
      bg = b
      text += ch
    }
    if (text) flush()
    rows.push({ runs })
    cost += ROW_COST
  }
  return { rows, cost }
}

const STEPS: ((c: string) => string)[] = [c => c, c => quantize(c, 8), nearestBase]

/** The grid's coloured runs within the budget; `level` is how far colours were coarsened (0 none, 1 eight steps, 2 base colours). */
export const paintRuns = (g: Grid): { rows: Row[]; cost: number; level: number } => {
  let level = 0
  let built = runsOf(g, STEPS[0]!)
  while (built.cost > PAINT_BUDGET && level < STEPS.length - 1) {
    level += 1
    built = runsOf(g, STEPS[level]!)
  }
  return { ...built, level }
}

/** The grid as a tree of one Text per row, within the budget. */
export const paint = (elements: ClientElements, g: Grid): { tree: RenderElement; cost: number; level: number } => {
  const built = paintRuns(g)
  const { Box, Text } = elements
  const rows = built.rows.map(r => (
    <Text wrap="truncate-end">
      {r.runs.map(run => (
        <Text {...(run.color ? { color: run.color } : {})} {...(run.bg ? { backgroundColor: run.bg } : {})}>
          {run.text}
        </Text>
      ))}
    </Text>
  ))
  return { tree: <Box flexDirection="column">{rows}</Box>, cost: built.cost, level: built.level }
}
