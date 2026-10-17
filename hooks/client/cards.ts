// Agent cards: a status-coloured rounded box holding the label, the status,
// the current tool, the tokens consumed with the cache share, the context
// size (not on workflow cards), and the model with its reasoning effort. Too small to read, a card becomes a solid status block.

import type { ViewAgent } from '../../types'
import type { Chip } from './chips'
import { borderJoins, drawJoins } from './edges'
import type { Grid } from './grid'
import { MUTED, STATUS_COLOR, STATUS_GLYPH, TEXT } from './palette'

/** Below this many cells on screen a card draws as a solid block. */
export const MIN_TEXT_CARD = { w: 12, h: 3 }

export const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

/** The share of input served from the prompt cache, as `87%`; undefined before any input. */
export const cacheShare = (cacheRead: number, inputAll: number): string | undefined =>
  inputAll > 0 ? `${Math.round((cacheRead / inputAll) * 100)}%` : undefined

/** The first of `options` that fits `cells`, else the last. */
export const fitting = (options: readonly string[], cells: number): string =>
  options.find(o => o.length <= cells) ?? options.at(-1)!

/** The model with its effort, as `claude-opus-5-5 · high`; too wide, it drops the `claude-` prefix. */
export const modelLine = (model: string, effort: string | undefined, cells: number): string =>
  effort ? fitting([`${model} · ${effort}`, `${model.replace(/^claude-/, '')} · ${effort}`], cells) : model

export type CardLook = {
  /** Border colour override (hover, selection, pulse). */
  border?: string
  /** Chips shown on the card's tool row, newest first. */
  chips?: readonly Chip[]
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
  ]
  // A narrow card drops the cache share first.
  const tok = `${formatTokens(a.tok)} tok`
  const share = cacheShare(a.cacheRead, a.inputAll)
  rows.push([fitting(share ? [`${tok} · ${share}`, tok] : [tok], inner), MUTED])
  if (a.kind !== 'group') rows.push([`${formatTokens(a.ctx)} ctx`, MUTED])
  if (a.model) rows.push([modelLine(a.model, a.effort, inner), MUTED])
  for (let r = 0; r < rows.length && r < h - 2; r++) {
    const [s, color] = rows[r]!
    if (r === 2 && look.chips?.length) drawChips(g, x + 2, y + 1 + r, look.chips, inner)
    else if (s) g.text(x + 2, y + 1 + r, s, color, inner)
  }
}

/** Chips side by side on one row, as many as fit. */
const drawChips = (g: Grid, x: number, y: number, chips: readonly Chip[], cells: number) => {
  let used = 0
  for (const c of chips) {
    const text = `${c.glyph} ${c.label}`
    if (used > 0 && used + 2 + text.length > cells) break
    if (used > 0) used += 2
    used += g.text(x + used, y, text, c.color, cells - used)
  }
}
