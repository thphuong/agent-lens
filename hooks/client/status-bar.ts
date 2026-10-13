// The status bar: the transport badge, the agent count and token total, the camera mode and layout reset buttons, and a truncation note
// when history was cut.

import type { CameraMode, Transport, ViewModel } from '../../types'
import { formatTokens } from './cards'
import type { Grid } from './grid'
import type { Rect } from './layout'
import { AMBER, ERR, GREY, MUTED, OK, TEXT } from './palette'

export const BADGE: Record<Transport, (speed: number) => { text: string; color: string }> = {
  live: () => ({ text: '● LIVE', color: OK }),
  playing: speed => ({ text: `▶ ${speed}×`, color: AMBER }),
  paused: () => ({ text: '❚❚ PAUSED', color: AMBER }),
  history: () => ({ text: '◷ HISTORY', color: GREY[3] }),
  idle: () => ({ text: '○ IDLE', color: MUTED }),
}

export type StatusExtras = {
  camera: CameraMode
  /** A dim hint shown at the right until the person first presses a key. */
  hint?: string
  /** Whether the live dot is lit this frame (blinks while live). */
  isDotLit?: boolean
}

/** Draws the status bar on row `y`; answers where its buttons went, for clicks. */
export const drawStatus = (g: Grid, y: number, view: ViewModel, extras: StatusExtras): { camera: Rect; reset: Rect } => {
  g.fill(0, y, g.w, 1, ' ', TEXT)
  let x = 1
  const t = view.timeline
  const badge = BADGE[t.transport](t.speed)
  const text = t.transport === 'live' && extras.isDotLit === false ? badge.text.replace('●', '○') : badge.text
  x += g.text(x, y, text, badge.color) + 2
  const agents = view.agents.filter(a => a.kind === 'sub').length
  // A group's total already includes its children's.
  const tokens = view.agents.reduce((s, a) => s + (a.kind === 'group' ? 0 : a.tokens), 0)
  x += g.text(x, y, `${agents} agents · ${formatTokens(tokens)} tok`, TEXT) + 2
  const camera = { x, y, w: g.text(x, y, `⌖ ${extras.camera}`, MUTED), h: 1 }
  x += camera.w + 2
  const reset = { x, y, w: g.text(x, y, '↺ layout', MUTED), h: 1 }
  x += reset.w + 2
  if (t.truncated) x += g.text(x, y, 'truncated', ERR) + 2
  if (extras.hint && x + extras.hint.length + 1 < g.w) g.text(g.w - extras.hint.length - 1, y, extras.hint, GREY[1])
  return { camera, reset }
}
