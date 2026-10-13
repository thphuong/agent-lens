// Tool chips: an agent's newest runs as `⚒ Bash ×5` while running, then `✓`
// or `✗` once settled. At most three, newest first.

import type { RunState, ViewAgent, ViewRun } from '../../types'
import { cellText } from '../text'
import { AMBER, ERR, MUTED, OK } from './palette'

export const MAX_CHIPS = 3
const CHIP_LABEL_CELLS = 14

export type Chip = { key: string; glyph: string; label: string; color: string; state: RunState }

const GLYPH: Record<RunState, string> = { run: '⚒', ok: '✓', err: '✗', unknown: '?' }
const COLOR: Record<RunState, string> = { run: AMBER, ok: OK, err: ERR, unknown: MUTED }

/**
 * The agent's chips, newest first. `visible` decides which runs still show
 * (an afterglow fading settled ones); all of them when absent.
 */
export const chipsFor = (agent: Pick<ViewAgent, 'id'>, runs: readonly ViewRun[], visible?: (run: ViewRun) => boolean): Chip[] =>
  runs
    .filter(r => r.agent === agent.id && (visible ? visible(r) : true))
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .slice(0, MAX_CHIPS)
    .map(r => ({
      key: r.key,
      glyph: GLYPH[r.state],
      label: `${cellText(r.tool, CHIP_LABEL_CELLS)}${r.count > 1 ? ` ×${r.count}` : ''}`,
      color: COLOR[r.state],
      state: r.state,
    }))
