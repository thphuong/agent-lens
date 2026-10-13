// The timeline panel: a marker strip, two rows of activity bars, the
// playhead with its time and transport, and with prompts a narrated line of
// the playhead's latest event. Short panes get a compact two-row form.

import type { ViewTimeline } from '../../types'
import type { Grid } from './grid'
import type { Rect } from './layout'
import { AMBER, AMBER_DIM, ERR, FRAME, GREY, MUTED, OK, TEXT } from './palette'
import { BADGE } from './status-bar'

/** Below this many rows the panel draws compact. */
export const FULL_PANEL_ROWS = 30
const BARS = '▁▂▃▄▅▆▇█'

/** Rows the panel takes (status bar excluded). */
export const panelRows = (t: ViewTimeline, compact: boolean): number => (compact ? 2 : t.prompts.length > 0 ? 8 : 6)

/** The seekable track inside a panel drawn at `rect`. */
export const trackOf = (rect: Rect, compact: boolean): Rect =>
  compact ? { x: rect.x + 1, y: rect.y, w: Math.max(1, rect.w - 2), h: 1 } : { x: rect.x + 2, y: rect.y + 1, w: Math.max(1, rect.w - 4), h: 4 }

/** The fact index under column `x` of the track: its ends map to 0 and length - 1. */
export const trackIndexAt = (x: number, track: Rect, length: number): number => {
  if (length <= 1) return 0
  const t = Math.max(0, Math.min(1, (x - track.x) / Math.max(1, track.w - 1)))
  return Math.round(t * (length - 1))
}

/** The column of the track that shows fact index `i`. */
export const trackColumn = (i: number, track: Rect, length: number): number =>
  track.x + (length <= 1 ? 0 : Math.round((Math.max(0, Math.min(length - 1, i)) / (length - 1)) * (track.w - 1)))

const resample = (values: readonly number[], n: number): number[] => {
  const out = new Array<number>(n).fill(0)
  if (values.length === 0) return out
  for (let i = 0; i < values.length; i++) out[Math.min(n - 1, Math.floor((i * n) / values.length))]! += values[i]!
  return out
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

const infoLine = (t: ViewTimeline): string => {
  const when = t.playheadAt !== undefined ? clock(t.playheadAt) : 'history'
  return `${when}  ${t.playhead}/${t.length}  ${BADGE[t.transport](t.speed).text}${t.compress ? '' : '  faithful'}`
}

/** Draws the panel into `rect` (full or compact). */
export const drawPanel = (g: Grid, rect: Rect, t: ViewTimeline, compact: boolean): void => {
  const track = trackOf(rect, compact)
  const head = t.playhead > 0 ? trackColumn(t.playhead - 1, track, t.length) : track.x
  const col = (i: number) => trackColumn(i, track, t.length)
  if (compact) {
    const spark = resample(t.spark, track.w)
    const max = Math.max(1, ...spark)
    for (let k = 0; k < track.w; k++) {
      const v = spark[k]!
      g.put(track.x + k, track.y, v > 0 ? BARS[Math.min(7, Math.floor((v / max) * 7.999))]! : '▁', track.x + k <= head ? AMBER : AMBER_DIM)
    }
    for (const i of t.fails) g.put(col(i), track.y, '✗', ERR)
    for (const i of t.spawns) g.put(col(i), track.y, '❋', OK)
    g.put(head, track.y, '▲', TEXT)
    g.text(rect.x + 1, rect.y + 1, infoLine(t), MUTED, rect.w - 2)
    return
  }
  g.fill(rect.x, rect.y, rect.w, rect.h, ' ', TEXT)
  g.box(rect.x, rect.y, rect.w, rect.h, FRAME)
  g.text(rect.x + 2, rect.y, ' timeline ', MUTED)
  // Marker strip: prompt ticks, gaps, spawns, then failures on top.
  const my = track.y
  for (const i of t.prompts) g.put(col(i), my, '┊', GREY[2])
  for (const i of t.gaps) g.put(col(i), my, '»', GREY[3])
  for (const i of t.spawns) g.put(col(i), my, '❋', OK)
  for (const i of t.fails) g.put(col(i), my, '✗', ERR)
  // Two rows of bars: sixteen levels, the lower row filling first.
  const spark = resample(t.spark, track.w)
  const max = Math.max(1, ...spark)
  for (let k = 0; k < track.w; k++) {
    const level = spark[k]! > 0 ? Math.max(1, Math.round((spark[k]! / max) * 16)) : 0
    const color = track.x + k <= head ? AMBER : AMBER_DIM
    const low = Math.min(8, level)
    const high = level - low
    if (low > 0) g.put(track.x + k, track.y + 2, BARS[low - 1]!, color)
    if (high > 0) g.put(track.x + k, track.y + 1, BARS[high - 1]!, color)
    if (t.prompts.includes(trackIndexAt(track.x + k, track, t.length)) && level === 0) g.put(track.x + k, track.y + 2, '┊', GREY[1])
  }
  // Playhead and info.
  g.put(head, track.y + 3, '▲', TEXT)
  const info = infoLine(t)
  const ix = head + 2 + info.length < rect.x + rect.w - 1 ? head + 2 : Math.max(track.x, head - 1 - info.length)
  g.text(ix, track.y + 3, info, MUTED, rect.w - 4)
  if (t.prompts.length > 0) {
    for (let k = 1; k < rect.w - 1; k++) g.put(rect.x + k, rect.y + 5, '─', GREY[1])
    g.text(rect.x + 2, rect.y + 6, t.lastEvent ?? '', TEXT, rect.w - 4)
  }
}
