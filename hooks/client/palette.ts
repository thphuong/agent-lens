// Colour tokens for every drawing, in raw hex so fades can step between them.

import type { DisplayStatus } from '../../types'

export const AMBER = '#d7af00'
export const AMBER_DIM = '#8a7a3a'
export const ANT = '#ffd75f'
export const OK = '#5fd75f'
export const ERR = '#ff5f5f'
export const GREY = ['#3a3a3a', '#585858', '#808080', '#a8a8a8', '#d0d0d0'] as const
export const TEXT = GREY[4]
export const MUTED = GREY[2]
export const HOVER = '#ffffff'
export const FRAME = '#5f87af'

export const STATUS_COLOR: Record<DisplayStatus, string> = {
  running: AMBER,
  idle: GREY[2],
  done: OK,
  failed: ERR,
  stopped: GREY[1],
}

export const STATUS_GLYPH: Record<DisplayStatus, string> = {
  running: '●',
  idle: '○',
  done: '✓',
  failed: '✗',
  stopped: '■',
}

const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`

/** A colour `t` of the way from `a` to `b` (0..1). */
export const mix = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}

/** The colour with each channel snapped to `levels` steps: fewer distinct colours, longer runs. */
export const quantize = (hex: string, levels: number): string => {
  if (!hex.startsWith('#') || hex.length !== 7) return hex
  const step = 255 / (levels - 1)
  const [r, g, b] = hexToRgb(hex).map(v => Math.round(v / step) * step) as [number, number, number]
  return rgbToHex(r, g, b)
}
