import { describe, expect, test } from 'claude-code/testing'

import { drawCard } from '../hooks/client/cards'
import { Grid } from '../hooks/client/grid'
import { CARD } from '../hooks/client/layout'
import { paintRuns } from '../hooks/client/paint'
import { rgbToHex } from '../hooks/client/palette'
import { cellWidth } from '../hooks/text'
import type { ViewAgent } from '../types'

const card = (kind: ViewAgent['kind'], w = CARD[kind].w) => {
  const a: ViewAgent = {
    id: 'a',
    kind,
    label: 'scan again',
    type: 'Explore',
    status: 'done',
    tool: 'Bash',
    tools: 7,
    ctx: 42_100,
    tok: 1_200_000,
    cacheRead: 870,
    inputAll: 1000,
    model: 'model-a',
    lastSeq: 1,
  }
  const g = new Grid(w, CARD[kind].h)
  drawCard(g, a, 0, 0, w, CARD[kind].h)
  return Array.from({ length: g.h }, (_, y) => g.ch.slice(y * g.w, (y + 1) * g.w).join(''))
}

describe('cards', () => {
  test('a sub card shows tokens with the cache share, then the context, and no call count', () => {
    const rows = card('sub')
    expect(rows[4]).toContain('1.2M tok · 87%')
    expect(rows[5]).toContain('42.1k ctx')
    expect(rows.join('\n')).not.toContain('×')
  })

  test('a narrow card drops the cache share first', () => {
    const rows = card('sub', 16)
    expect(rows[4]).toContain('1.2M tok')
    expect(rows[4]).not.toContain('%')
  })

  test('a group card has no context row', () => {
    const rows = card('group')
    expect(rows.join('\n')).not.toContain('ctx')
    expect(rows[5]).toContain('model-a')
  })
})

describe('paint', () => {
  test('a 110×44 per-cell gradient degrades to fit under 100,000 characters', () => {
    const g = new Grid(110, 44)
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) g.put(x, y, '·', rgbToHex(x * 2, y * 5, (x + y) * 3))
    const out = paintRuns(g)
    expect(out.level).toBeGreaterThan(0)
    expect(out.cost).toBeLessThan(100_000)
  })

  test('same-coloured cells merge into one run', () => {
    const g = new Grid(20, 1)
    g.text(0, 0, 'aaaa', '#ff0000')
    g.text(4, 0, 'bbbb', '#ff0000')
    g.text(8, 0, 'cc', '#00ff00')
    const runs = paintRuns(g).rows[0]!.runs
    expect(runs[0]).toEqual({ text: 'aaaabbbb', color: '#ff0000' })
    expect(runs).toHaveLength(2)
  })

  test('wide labels keep the row as wide as the grid', () => {
    const g = new Grid(12, 1)
    g.text(1, 0, '漢字ab', '#ffffff')
    g.text(9, 0, 'z', '#ff0000')
    const row = paintRuns(g).rows[0]!.runs.map(r => r.text).join('')
    expect(cellWidth(row)).toBe(12)
    expect(row.indexOf('z')).toBe(row.length - 3)
  })
})
