// The details panel, the info overlay and the help overlay.

import type { Details, Info } from '../../types'
import { formatTokens } from './cards'
import type { Grid } from './grid'
import type { Rect } from './layout'
import { AMBER, ERR, FRAME, GREY, MUTED, OK, STATUS_COLOR, STATUS_GLYPH, TEXT } from './palette'

/** Details sit right of the canvas when the region is at least this wide, else below it. */
export const DETAILS_RIGHT_MIN = 70

export const KEYMAP: [string, string][] = [
  ['space', 'play / pause'],
  ['[  ]', 'previous / next prompt'],
  ['g  End', 'go live'],
  ['s', 'gap compression'],
  ['o', 'overview'],
  ['f', 'follow on / off'],
  ['r', 'relayout'],
  ['c', 'centre'],
  ['i  ?', 'info / help'],
  ['Tab  arrows', 'select'],
  ['h j k l', 'pan (j/k scroll details)'],
  ['+  -  0', 'zoom'],
  ['x', 'close overlay / details'],
  ['q', 'close the pane'],
]

const duration = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`)

type Line = { text: string; color: string }

/** The details as lines, before scrolling. */
export const detailLines = (d: Details, now = Date.now()): Line[] => {
  const lines: Line[] = [
    { text: d.label, color: TEXT },
    { text: `${STATUS_GLYPH[d.status]} ${d.status} · ${d.type}`, color: STATUS_COLOR[d.status] },
  ]
  if (d.model) lines.push({ text: d.model, color: MUTED })
  if (d.prompt) lines.push({ text: `“${d.prompt}”`, color: GREY[3] })
  const span = d.start !== undefined && d.end !== undefined ? `  ${duration(d.end - d.start)}` : ''
  lines.push({ text: `${formatTokens(d.tokens)} tok  #${d.spawnedSeq}${d.endedSeq !== undefined ? `–#${d.endedSeq}` : ''}${span}`, color: MUTED })
  for (const era of d.eras) {
    lines.push({ text: '', color: TEXT })
    lines.push({ text: `◆ ${era.prompt}`, color: AMBER })
    for (const c of era.calls) {
      const glyph = c.state === 'run' ? '⚒' : c.state === 'ok' ? '✓' : c.state === 'err' ? '✗' : '?'
      const color = c.state === 'run' ? AMBER : c.state === 'ok' ? OK : c.state === 'err' ? ERR : MUTED
      // A call in flight shows its time so far, ticking while it runs.
      const took =
        c.start === undefined ? '' : c.end !== undefined ? `  ${duration(c.end - c.start)}` : c.state === 'run' ? `  ${duration(Math.max(0, now - c.start))}…` : ''
      lines.push({ text: `  ${glyph} ${c.tool}${took}`, color })
    }
  }
  return lines
}

const panel = (g: Grid, rect: Rect, title: string) => {
  g.fill(rect.x, rect.y, rect.w, rect.h, ' ', TEXT)
  g.box(rect.x, rect.y, rect.w, rect.h, FRAME)
  g.text(rect.x + 2, rect.y, ` ${title} `, MUTED, rect.w - 4)
}

/** Draws the details in `rect`, scrolled down `scroll` lines; answers the largest useful scroll. */
export const drawDetails = (g: Grid, rect: Rect, d: Details, scroll: number, now = Date.now()): number => {
  panel(g, rect, 'details · x closes')
  const lines = detailLines(d, now)
  const room = rect.h - 2
  const maxScroll = Math.max(0, lines.length - room)
  const from = Math.max(0, Math.min(maxScroll, scroll))
  for (let r = 0; r < room && from + r < lines.length; r++) {
    const l = lines[from + r]!
    g.text(rect.x + 2, rect.y + 1 + r, l.text, l.color, rect.w - 4)
  }
  return maxScroll
}

export const drawInfo = (g: Grid, rect: Rect, info: Info): void => {
  panel(g, rect, 'session')
  const rows: [string, string][] = [
    ['model', info.model ?? '—'],
    ['agents', String(info.agents)],
    ['tool calls', String(info.tools)],
    ['edits', String(info.edits)],
    ['tokens', formatTokens(info.tokens)],
    ['pacing', info.compress ? 'compressed gaps' : 'faithful'],
    ['last prompt', info.lastPrompt ?? '—'],
  ]
  rows.forEach(([k, v], r) => {
    if (r >= rect.h - 2) return
    g.text(rect.x + 2, rect.y + 1 + r, k, MUTED, 12)
    g.text(rect.x + 15, rect.y + 1 + r, v, TEXT, rect.w - 17)
  })
}

export const drawHelp = (g: Grid, rect: Rect): void => {
  panel(g, rect, 'keys · click the graph first')
  KEYMAP.forEach(([k, v], r) => {
    if (r >= rect.h - 2) return
    g.text(rect.x + 2, rect.y + 1 + r, k, AMBER, 12)
    g.text(rect.x + 15, rect.y + 1 + r, v, TEXT, rect.w - 17)
  })
}

/** A centred overlay box within `area`. */
export const overlayRect = (area: Rect, w: number, h: number): Rect => {
  const ow = Math.min(area.w - 2, w)
  const oh = Math.min(area.h - 2, h)
  return { x: area.x + Math.floor((area.w - ow) / 2), y: area.y + Math.floor((area.h - oh) / 2), w: ow, h: oh }
}
