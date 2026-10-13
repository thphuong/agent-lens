// Agent cards: a status-coloured rounded box holding the label, the status,
// the current tool, the tool and token counts, and for main and workflow
// cards the model. Too small to read, a card becomes a solid status block.

import type { ViewAgent } from '../../types'
import { borderJoins, drawJoins } from './edges'
import type { Grid } from './grid'
import { MUTED, STATUS_COLOR, STATUS_GLYPH, TEXT } from './palette'

/** Below this many cells on screen a card draws as a solid block. */
export const MIN_TEXT_CARD = { w: 12, h: 3 }

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export type CardLook = {
  /** Border colour override (hover, selection, pulse). */
  border?: string
}

/** Draws a card at screen cell (x, y) sized w×h; edges already routed into the grid join its borders. */
export const drawCard = (g: Grid, a: ViewAgent, x: number, y: number, w: number, h: number, look: CardLook = {}): void => {
  const status = STATUS_COLOR[a.status]
  if (w < MIN_TEXT_CARD.w || h < MIN_TEXT_CARD.h) {
    g.fill(x, y, Math.max(1, w), Math.max(1, h), '█', look.border ?? status)
    return
  }
  const border = look.border ?? status
  const joins = borderJoins(g, x, y, w, h)
  g.fill(x + 1, y + 1, w - 2, h - 2, ' ', TEXT)
  g.box(x, y, w, h, border)
  drawJoins(g, x, y, h, joins, border)
  const inner = w - 4
  const rows: [string, string][] = [
    [a.label, TEXT],
    [`${STATUS_GLYPH[a.status]} ${a.status}${a.type && a.type !== a.label ? ` · ${a.type}` : ''}`, status],
    [a.tool ? `⚒ ${a.tool}` : '', a.tool ? TEXT : MUTED],
    [`×${a.tools}  ${formatTokens(a.tokens)} tok`, MUTED],
  ]
  if (a.kind !== 'sub' && a.model) rows.push([a.model, MUTED])
  for (let r = 0; r < rows.length && r < h - 2; r++) {
    const [s, color] = rows[r]!
    if (s) g.text(x + 2, y + 1 + r, s, color, inner)
  }
}
