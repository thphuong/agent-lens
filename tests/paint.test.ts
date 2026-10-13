import { describe, expect, test } from 'claude-code/testing'

import { Grid } from '../hooks/client/grid'
import { paintRuns } from '../hooks/client/paint'
import { rgbToHex } from '../hooks/client/palette'
import { cellWidth } from '../hooks/text'

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
