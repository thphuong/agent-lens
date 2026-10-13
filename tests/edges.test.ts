import { describe, expect, test } from 'claude-code/testing'

import { strokes } from '../hooks/client/edges'
import { Grid } from '../hooks/client/grid'
import { relayout } from '../hooks/client/layout'
import { drawScene } from '../hooks/client/scene'
import type { ViewAgent } from '../types'

const agent = (id: string, parent?: string, kind: ViewAgent['kind'] = 'sub'): ViewAgent => ({
  id,
  parent,
  kind,
  label: id,
  type: id,
  status: 'done',
  tools: 0,
  tokens: 0,
  lastSeq: 0,
})

const rowText = (g: Grid, y: number) => g.ch.slice(y * g.w, (y + 1) * g.w).join('')

describe('edges', () => {
  test('a parent with three children joins through a shared bar', () => {
    const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('b', 'main'), agent('c', 'main')]
    const pos = relayout(agents)
    const g = new Grid(90, 20)
    drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
    const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
    // The parent's bottom border carries the junction.
    expect(rows[6]).toContain('┬')
    const barY = rows.findIndex((r, i) => i > 6 && r.includes('╭'))
    const bar = rows[barY]!.trim()
    // Main sits over the middle child, so the trunk crosses the bar there.
    expect(bar).toMatch(/^╭─+┼─+╮$/)
    // Each child's top border is entered through a junction.
    const childTop = rows.findIndex((r, i) => i > barY && r.includes('╭'))
    expect((rows[childTop]!.match(/┴/g) ?? []).length).toBe(3)
  })

  test('crossing edges of different parents bridge; of one parent they join', () => {
    const cross = (family: number[]) => {
      const g = new Grid(9, 9)
      g.route([{ x: 0, y: 4 }, { x: 8, y: 4 }], 0)
      g.route([{ x: 4, y: 0 }, { x: 4, y: 8 }], 1)
      strokes(g, { family, color: () => '#808080' })
      return g.ch[4 * 9 + 4]
    }
    expect(cross([0, 1])).toBe('│')
    expect(cross([0, 0])).toBe('┼')
  })
})

test('an off-centre parent meets the bar from above', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('b', 'main')]
  const pos = relayout(agents)
  const g = new Grid(90, 20)
  drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
  const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
  const bar = rows.find((r, i) => i > 6 && r.includes('╭'))!.trim()
  expect(bar).toMatch(/^╭─+┴─+╮$/)
})

test('a child dragged level with its parent stays connected, entered from below', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main')]
  const pos = { main: { x: 0, y: 0 }, a: { x: 40, y: 1 } }
  const g = new Grid(80, 12)
  drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
  const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
  // Main's bottom (row 6) and the child's bottom (row 6) both carry a junction.
  expect((rows[6]!.match(/┬/g) ?? []).length).toBe(2)
  expect(rows[7]!.trim()).toMatch(/^╰─+╯$/)
})
