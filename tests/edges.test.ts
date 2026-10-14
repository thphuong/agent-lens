import { describe, expect, test } from 'claude-code/testing'

import { strokes } from '../hooks/client/edges'
import { Grid } from '../hooks/client/grid'
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
  ctx: 0,
  tok: 0,
  cacheRead: 0,
  inputAll: 0,
  lastSeq: 0,
})

const rowText = (g: Grid, y: number) => g.ch.slice(y * g.w, (y + 1) * g.w).join('')

describe('edges', () => {
  test('a parent with three children joins through a shared bar', () => {
    const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('b', 'main'), agent('c', 'main')]
    // Main centred over the middle child.
    const pos = { main: { x: 27, y: 0 }, a: { x: 0, y: 11 }, b: { x: 29, y: 11 }, c: { x: 58, y: 11 } }
    const g = new Grid(90, 20)
    drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
    const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
    // The parent's bottom border carries the junction.
    expect(rows[7]).toContain('┬')
    const barY = rows.findIndex((r, i) => i > 7 && r.includes('╭'))
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
  // Main centred between its two children, over neither.
  const pos = { main: { x: 12, y: 0 }, a: { x: 0, y: 11 }, b: { x: 29, y: 11 } }
  const g = new Grid(90, 20)
  drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
  const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
  const bar = rows.find((r, i) => i > 7 && r.includes('╭'))!.trim()
  expect(bar).toMatch(/^╭─+┴─+╮$/)
})

test('a child dragged level with its parent stays connected, entered from below', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main')]
  const pos = { main: { x: 0, y: 0 }, a: { x: 40, y: 1 } }
  const g = new Grid(80, 12)
  drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
  const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
  // Main's bottom (row 7) and the child's bottom (row 7) both carry a junction.
  expect((rows[7]!.match(/┬/g) ?? []).length).toBe(2)
  expect(rows[8]!.trim()).toMatch(/^╰─+╯$/)
})

describe('spine', () => {
  const column = (rows: string[], x: number) => rows.map(r => r[x] ?? ' ')

  test('a parent with one row of children leaves from its centre', () => {
    const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('b', 'main')]
    const pos = { main: { x: 0, y: 0 }, a: { x: 3, y: 12 }, b: { x: 32, y: 12 } }
    const g = new Grid(70, 20)
    drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
    const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
    expect(rows[7]!.indexOf('┬')).toBe(15)
    expect(rows[7]!.lastIndexOf('┬')).toBe(15)
  })

  test('a parent with a second row of children routes every child down a spine at its left', () => {
    const agents = [agent('main', undefined, 'main'), agent('a', 'main'), { ...agent('b', 'main'), wave: 1 }]
    const pos = { main: { x: 0, y: 0 }, a: { x: 3, y: 12 }, b: { x: 3, y: 23 } }
    const g = new Grid(40, 31)
    drawScene(g, agents, pos, { x: 0, y: 0, z: 1 })
    const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
    expect(rows[7]!.indexOf('┬')).toBe(1)
    expect(rows[7]!.lastIndexOf('┬')).toBe(1)
    // Down the spine, out to the first row's bar, on to the last bar.
    expect(column(rows, 1).slice(8, 22).join('')).toBe('││├││││││││││╰')
    expect(rows[10]!.trimEnd()).toBe(' ├──────────────╮')
    expect(rows[21]!.trimEnd()).toBe(' ╰──────────────╮')
    // Each child is entered at its centre.
    expect(rows[12]![16]).toBe('┴')
    expect(rows[23]![16]).toBe('┴')
  })

  test('zoomed out until a child would cover the spine, the edges leave from the centre', () => {
    const agents = [agent('main', undefined, 'main'), agent('a', 'main'), { ...agent('b', 'main'), wave: 1 }]
    const pos = { main: { x: 0, y: 0 }, a: { x: 3, y: 12 }, b: { x: 3, y: 23 } }
    const g = new Grid(20, 14)
    drawScene(g, agents, pos, { x: 0, y: 0, z: 0.4 })
    const rows = Array.from({ length: g.h }, (_, y) => rowText(g, y))
    expect(rows[2]!.indexOf('┬')).toBe(6)
  })
})
