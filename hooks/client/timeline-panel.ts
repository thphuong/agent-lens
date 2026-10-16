// The timeline panel: a marker strip, two rows of activity bars, the
// playhead with its time and transport, and with prompts a narrated line of
// the playhead's latest event. Short panes get a compact two-row form. The
// track shows a window of the timeline; while it is zoomed, the full panel's
// top border shows where the window sits in the whole session.

import type { TrackWindow, ViewTimeline } from '../../types'
import type { Grid } from './grid'
import type { Rect } from './layout'
import { AMBER, AMBER_DIM, ERR, FRAME, GREY, MUTED, OK, TEXT } from './palette'
import { BADGE } from './status-bar'

/** Below this many rows the panel draws compact. */
export const FULL_PANEL_ROWS = 30
const BARS = '▁▂▃▄▅▆▇█'
const TITLE = ' timeline '

/** Rows the panel takes (status bar excluded). */
export const panelRows = (t: ViewTimeline, compact: boolean): number => (compact ? 2 : t.prompts.length > 0 ? 8 : 6)

/** The seekable track inside a panel drawn at `rect`. */
export const trackOf = (rect: Rect, compact: boolean): Rect =>
  compact ? { x: rect.x + 1, y: rect.y, w: Math.max(1, rect.w - 2), h: 1 } : { x: rect.x + 2, y: rect.y + 1, w: Math.max(1, rect.w - 4), h: 4 }

/** The fact index under column `x` of the track showing `win`: its ends map to its first and last fact. */
export const trackIndexAt = (x: number, track: Rect, win: TrackWindow): number => {
  const span = win.to - win.from
  if (span <= 1) return win.from
  const t = Math.max(0, Math.min(1, (x - track.x) / Math.max(1, track.w - 1)))
  return win.from + Math.round(t * (span - 1))
}

/** The column of the track showing `win` that shows fact index `i`. */
export const trackColumn = (i: number, track: Rect, win: TrackWindow): number => {
  const span = win.to - win.from
  if (span <= 1) return track.x
  return track.x + Math.round((Math.max(0, Math.min(span - 1, i - win.from)) / (span - 1)) * (track.w - 1))
}

/** The window the track shows, as the props resolved it. */
export const windowOf = (t: ViewTimeline): TrackWindow => ({ from: t.from, to: t.to })

export const isZoomed = (t: ViewTimeline): boolean => t.to - t.from < t.length

/** Where the full panel's top border shows the whole timeline while zoomed: right of the title; no room in a narrow panel. */
export const overviewOf = (rect: Rect): Rect => {
  const x = rect.x + 2 + TITLE.length + 1
  return { x, y: rect.y, w: Math.max(0, rect.x + rect.w - 2 - x), h: 1 }
}

const resample = (values: readonly number[], n: number): number[] => {
  const out = new Array<number>(n).fill(0)
  if (values.length === 0) return out
  for (let i = 0; i < values.length; i++) out[Math.min(n - 1, Math.floor((i * n) / values.length))]! += values[i]!
  return out
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

/** The time and position of the playhead and the transport; compact adds how far the track is zoomed. */
const infoLine = (t: ViewTimeline, compact: boolean): string => {
  const when = t.playheadAt !== undefined ? clock(t.playheadAt) : 'history'
  const zoom = compact && isZoomed(t) ? `  ×${Math.round(t.length / Math.max(1, t.to - t.from))}` : ''
  return `${when}  ${t.playhead}/${t.length}${zoom}  ${BADGE[t.transport](t.speed).text}${t.compress ? '' : '  faithful'}`
}

/** The top border while zoomed: the whole timeline's activity, the window bright over it, and the playhead. */
const drawOverview = (g: Grid, rect: Rect, t: ViewTimeline): void => {
  const o = overviewOf(rect)
  if (o.w < 2) return
  const all = { from: 0, to: t.length }
  const activity = resample(t.overview ?? [], o.w)
  for (let k = 0; k < o.w; k++) g.put(o.x + k, o.y, '─', activity[k]! > 0 ? GREY[3] : FRAME)
  const a = trackColumn(t.from, o, all)
  const b = trackColumn(t.to - 1, o, all)
  for (let x = a; x <= b; x++) g.put(x, o.y, '━', AMBER)
  if (t.playhead > 0) g.put(trackColumn(t.playhead - 1, o, all), o.y, '┿', TEXT)
}

/** Draws the panel into `rect` (full or compact). */
export const drawPanel = (g: Grid, rect: Rect, t: ViewTimeline, compact: boolean): void => {
  const track = trackOf(rect, compact)
  const win = windowOf(t)
  const head = t.playhead > 0 ? trackColumn(t.playhead - 1, track, win) : track.x
  const col = (i: number) => trackColumn(i, track, win)
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
    g.text(rect.x + 1, rect.y + 1, infoLine(t, true), MUTED, rect.w - 2)
    return
  }
  g.fill(rect.x, rect.y, rect.w, rect.h, ' ', TEXT)
  g.box(rect.x, rect.y, rect.w, rect.h, FRAME)
  g.text(rect.x + 2, rect.y, TITLE, MUTED)
  if (isZoomed(t)) drawOverview(g, rect, t)
  // Marker strip: prompt ticks, gaps, spawns, then failures on top.
  const my = track.y
  for (const i of t.prompts) g.put(col(i), my, '┊', GREY[2])
  for (const i of t.gaps) g.put(col(i), my, '»', GREY[3])
  for (const i of t.spawns) g.put(col(i), my, '❋', OK)
  for (const i of t.fails) g.put(col(i), my, '✗', ERR)
  // Two rows of bars: sixteen levels, the lower row filling first.
  const spark = resample(t.spark, track.w)
  const max = Math.max(1, ...spark)
  const promptCols = new Set(t.prompts.map(col))
  for (let k = 0; k < track.w; k++) {
    const level = spark[k]! > 0 ? Math.max(1, Math.round((spark[k]! / max) * 16)) : 0
    const color = track.x + k <= head ? AMBER : AMBER_DIM
    const low = Math.min(8, level)
    const high = level - low
    if (low > 0) g.put(track.x + k, track.y + 2, BARS[low - 1]!, color)
    if (high > 0) g.put(track.x + k, track.y + 1, BARS[high - 1]!, color)
    if (promptCols.has(track.x + k) && level === 0) g.put(track.x + k, track.y + 2, '┊', GREY[1])
  }
  // Playhead and info.
  g.put(head, track.y + 3, '▲', TEXT)
  const info = infoLine(t, false)
  const ix = head + 2 + info.length < rect.x + rect.w - 1 ? head + 2 : Math.max(track.x, head - 1 - info.length)
  g.text(ix, track.y + 3, info, MUTED, rect.w - 4)
  if (t.prompts.length > 0) {
    for (let k = 1; k < rect.w - 1; k++) g.put(rect.x + k, rect.y + 5, '─', GREY[1])
    g.text(rect.x + 2, rect.y + 6, t.lastEvent ?? '', TEXT, rect.w - 4)
  }
}
