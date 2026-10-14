import { describe, expect, test } from 'claude-code/testing'

import { frameOf, place, rectOf, relayout, ROW_INDENT, type Positions, type Rect } from '../hooks/client/layout'
import { derive, foldAll } from '../hooks/model/fold'
import type { ViewAgent } from '../types'
import { Session, waterfall } from './fixtures/generate'

const agent = (id: string, parent?: string, kind: ViewAgent['kind'] = 'sub') => ({ id, parent, kind })

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const noOverlaps = (agents: readonly Pick<ViewAgent, 'id' | 'kind'>[], pos: Positions) => {
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
  expect(full.a!.x).toBe(full.main!.x + ROW_INDENT)
})

describe('waves', () => {
  const facts = waterfall().numbered()
  const agents = derive(foldAll(facts))
  const pos = relayout(agents)
  const byLabel = (label: string) => agents.find(a => a.label === label)!
  const batch = (i: number) => agents.filter(a => a.label.startsWith(`batch ${i} `))
  const bottom = (ids: readonly string[]) => Math.max(...ids.map(id => rectOf(agents.find(a => a.id === id)!, pos)!).map(r => r.y + r.h))

  test('siblings that ran together share a row', () => {
    expect(new Set(batch(0).map(a => pos[a.id]!.y)).size).toBe(1)
    expect(new Set(batch(2).map(a => pos[a.id]!.y)).size).toBe(1)
  })

  test("a later wave starts below every card of the earlier waves' subtrees", () => {
    const nested = byLabel('nested look')
    const first = batch(1)[0]!
    expect(pos[first.id]!.y).toBeGreaterThan(bottom([...batch(0).map(a => a.id), nested.id]))
    expect(pos[batch(2)[0]!.id]!.y).toBeGreaterThan(bottom(batch(1).map(a => a.id)))
  })

  test('a wave wider than four wraps to a row below, starting at the same column', () => {
    const wide = batch(1)
    const ys = wide.map(a => pos[a.id]!.y)
    expect(new Set(ys.slice(0, 4)).size).toBe(1)
    expect(ys[4]).toBeGreaterThan(ys[0]! + 6)
    expect(ys[5]).toBe(ys[4])
    for (const i of [0, 4]) expect(pos[wide[i]!.id]!.x).toBe(pos.main!.x + ROW_INDENT)
  })

  test('cards never overlap', () => {
    noOverlaps(agents, pos)
  })

  test('placing one card at a time lands every card where a full relayout does', () => {
    let grown: Positions = {}
    for (let n = 1; n <= agents.length; n++) grown = place(grown, agents.slice(0, n), {})
    expect(grown).toEqual(pos)
  })

  test('the layout after any event of the session is where the full one put those cards', () => {
    // One event's facts share a time; a cut inside a spawn would see the agent before its parent.
    for (let n = 1; n <= facts.length; n++) {
      if (n < facts.length && facts[n]!.at === facts[n - 1]!.at) continue
      const early = relayout(derive(foldAll(facts, n)))
      for (const id of Object.keys(early)) expect(early[id]).toEqual(pos[id])
    }
  })
})

test('a card main spawns while a workflow runs its steps in turn stays outside the workflow frame', () => {
  const s = new Session()
  const step = (i: number) => s.spawn({ workflow: { runId: 'run1', agentIndex: i } })
  s.finish(step(0))
  const second = step(1)
  const meanwhile = s.spawn({})
  s.finish(second)
  s.finish(step(2))
  s.finish(meanwhile)
  s.finish(step(3))
  const agents = derive(foldAll(s.numbered()))
  const pos = relayout(agents)
  noOverlaps(agents, pos)
  const frame = frameOf(agents.find(a => a.id === 'wf:run1')!, agents, pos)!
  for (const a of agents.filter(a => a.parent === 'main' && a.kind !== 'group')) expect(overlap(rectOf(a, pos)!, frame)).toBe(false)
})

test('a dragged card and its subtree do not push a later row down', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('a1', 'a'), { ...agent('b', 'main'), wave: 1 }]
  const free = relayout(agents)
  const pinned = { a: { x: 3, y: 200 } }
  const pos = place({}, agents, pinned)
  expect(pos.a1!.y).toBeGreaterThan(200)
  expect(pos.b!.y).toBe(relayout(agents.filter(x => x.id !== 'a' && x.id !== 'a1')).b!.y)
  expect(free.b!.y).toBeGreaterThan(free.a1!.y)
})
