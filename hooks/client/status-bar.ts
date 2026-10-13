// The status bar: the wordmark, the transport badge, agent and tool counts,
// the camera mode, and a truncation note when history was cut.

import type { CameraMode, Transport, ViewModel } from '../../types'
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

/** Draws the status bar on row `y`; answers where the camera mode went, for clicks. */
export const drawStatus = (g: Grid, y: number, view: ViewModel, extras: StatusExtras): { camera: Rect } => {
  g.fill(0, y, g.w, 1, ' ', TEXT)
  let x = 1
  x += g.text(x, y, '◉ session-viz', AMBER) + 2
  const t = view.timeline
  const badge = BADGE[t.transport](t.speed)
  const text = t.transport === 'live' && extras.isDotLit === false ? badge.text.replace('●', '○') : badge.text
  x += g.text(x, y, text, badge.color) + 2
  const agents = view.agents.filter(a => a.kind === 'sub').length
  const tools = view.agents.reduce((s, a) => s + (a.kind === 'group' ? 0 : a.tools), 0)
  x += g.text(x, y, `${agents} agents · ${tools} tools`, TEXT) + 2
  const camera = { x, y, w: g.text(x, y, `⌖ ${extras.camera}`, MUTED), h: 1 }
  x += camera.w + 2
  if (t.truncated) x += g.text(x, y, 'truncated', ERR) + 2
  if (extras.hint && x + extras.hint.length + 1 < g.w) g.text(g.w - extras.hint.length - 1, y, extras.hint, GREY[1])
  return { camera }
}
