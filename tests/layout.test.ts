import { describe, expect, test } from 'claude-code/testing'

import { frameOf, place, rectOf, relayout, type Positions, type Rect } from '../hooks/client/layout'
import type { ViewAgent } from '../types'

const agent = (id: string, parent?: string, kind: ViewAgent['kind'] = 'sub') => ({ id, parent, kind })

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const noOverlaps = (agents: ReturnType<typeof agent>[], pos: Positions) => {
  const rects = agents.map(a => rectOf(a, pos)!)
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i]!, rects[j]!)).toBe(false)
}

const tree = [
  agent('main', undefined, 'main'),
  agent('a', 'main'),
  agent('b', 'main'),
  agent('a1', 'a'),
  agent('wf', 'main', 'group'),
  agent('w1', 'wf'),
  agent('w2', 'wf'),
]

describe('relayout', () => {
  test('cards never overlap and children sit under their parent', () => {
    const pos = relayout(tree)
    noOverlaps(tree, pos)
    for (const a of tree) {
      if (!a.parent) continue
      expect(pos[a.id]!.y).toBeGreaterThan(pos[a.parent]!.y)
    }
  })

  test('a group frame encloses its children', () => {
    const pos = relayout(tree)
    const f = frameOf(tree[4]!, tree, pos)!
    for (const id of ['wf', 'w1', 'w2']) {
      const r = rectOf(tree.find(a => a.id === id)!, pos)!
      expect(r.x).toBeGreaterThan(f.x)
      expect(r.x + r.w).toBeLessThan(f.x + f.w)
      expect(r.y + r.h).toBeLessThan(f.y + f.h)
    }
    // Nothing outside the group falls inside its frame.
    for (const id of ['main', 'a', 'b', 'a1']) expect(overlap(rectOf(tree.find(a => a.id === id)!, pos)!, f)).toBe(false)
  })

  test('is deterministic', () => {
    expect(relayout(tree)).toEqual(relayout(tree))
  })
})

describe('incremental placement', () => {
  test('appending a child moves no existing card', () => {
    const before = relayout(tree)
    const grown = [...tree, agent('b1', 'b'), agent('w3', 'wf'), agent('c', 'main')]
    const after = place(before, grown, {})
    for (const id of Object.keys(before)) expect(after[id]).toEqual(before[id])
    noOverlaps(grown, after)
    expect(after.b1!.y).toBeGreaterThan(after.b!.y)
  })

  test('pinned positions are kept', () => {
    const after = place({}, tree, { a: { x: 500, y: 300 } })
    expect(after.a).toEqual({ x: 500, y: 300 })
  })
})

test('a new card outside a group keeps clear of its frame', () => {
  const before = relayout(tree)
  const grown = [...tree, agent('late', 'main')]
  const after = place(before, grown, {})
  const frame = frameOf(tree[4]!, grown, after)!
  const r = rectOf(grown.at(-1)!, after)!
  expect(r.x < frame.x + frame.w && frame.x < r.x + r.w && r.y < frame.y + frame.h && frame.y < r.y + r.h).toBe(false)
})

test('the cards seen early in a session sit where they first appeared, however many come later', () => {
  const grown = [...tree, agent('b1', 'b'), agent('w3', 'wf'), agent('c', 'main'), agent('c1', 'c')]
  const full = relayout(grown)
  for (let n = 1; n <= grown.length; n++) {
    const early = relayout(grown.slice(0, n))
    for (const id of Object.keys(early)) expect(full[id]).toEqual(early[id])
  }
  expect(full.a!.x + 13).toBe(full.main!.x + 15)
})
