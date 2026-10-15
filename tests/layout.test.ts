import { describe, expect, test } from 'claude-code/testing'

import { frameOf, layout, rectOf, ROW_INDENT, rowsOf, type Positions, type Rect } from '../hooks/client/layout'
import { derive, foldAll } from '../hooks/model/fold'
import type { ViewAgent } from '../types'
import { large, resumed, Session, waterfall, wrapped } from './fixtures/generate'

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

describe('layout', () => {
  test('cards never overlap and children sit under their parent', () => {
    const pos = layout(tree, {})
    noOverlaps(tree, pos)
    for (const a of tree) {
      if (!a.parent) continue
      expect(pos[a.id]!.y).toBeGreaterThan(pos[a.parent]!.y)
    }
    expect(pos.a!.x).toBe(pos.main!.x + ROW_INDENT)
  })

  test('a group frame encloses its children', () => {
    const pos = layout(tree, {})
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
    expect(layout(tree, {})).toEqual(layout(tree, {}))
  })
})

test('a new card outside a group keeps clear of its frame', () => {
  const grown = [...tree, agent('late', 'main')]
  const after = layout(grown, {})
  const frame = frameOf(tree[4]!, grown, after)!
  const r = rectOf(grown.at(-1)!, after)!
  expect(r.x < frame.x + frame.w && frame.x < r.x + r.w && r.y < frame.y + frame.h && frame.y < r.y + r.h).toBe(false)
})

describe('waves', () => {
  const facts = waterfall().numbered()
  const agents = derive(foldAll(facts))
  const pos = layout(agents, {})
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
  const pos = layout(agents, {})
  noOverlaps(agents, pos)
  const frame = frameOf(agents.find(a => a.id === 'wf:run1')!, agents, pos)!
  for (const a of agents.filter(a => a.parent === 'main' && a.kind !== 'group')) expect(overlap(rectOf(a, pos)!, frame)).toBe(false)
})

/** The agents shown after each event of a session, cut where an event ends: a cut inside a spawn would see the agent before its parent. */
const cuts = (facts: ReturnType<Session['numbered']>) =>
  facts.flatMap((_, i) => (i + 1 < facts.length && facts[i + 1]!.at === facts[i]!.at ? [] : [derive(foldAll(facts, i + 1))]))

test('a subtree that grows pushes later rows down and leaves their x alone', () => {
  const all = cuts(wrapped().numbered())
  const full = all.at(-1)!
  const before = all.findLast(agents => !agents.some(a => a.label === 'late child'))!
  const was = layout(before, {})
  const pos = layout(full, {})
  const byLabel = (label: string) => full.find(a => a.label === label)!
  const wide = full.filter(a => a.label.startsWith('wide lens '))
  expect(new Set(wide.slice(0, 4).map(a => pos[a.id]!.y)).size).toBe(1)
  for (const a of wide.slice(0, 4)) expect(pos[a.id]).toEqual(was[a.id])
  for (const a of wide.slice(4)) {
    expect(pos[a.id]!.x).toBe(was[a.id]!.x)
    expect(pos[a.id]!.y).toBeGreaterThan(was[a.id]!.y)
  }
  const late = rectOf(byLabel('late child'), pos)!
  expect(late.x).toBe(pos[wide[0]!.id]!.x + ROW_INDENT)
  expect(late.y).toBeGreaterThan(pos[wide[0]!.id]!.y)
  expect(pos[wide[4]!.id]!.y).toBeGreaterThan(late.y + late.h)
  noOverlaps(full, pos)
})

test("a resumed agent's new child sits under it", () => {
  const agents = derive(foldAll(resumed().numbered()))
  const pos = layout(agents, {})
  const byLabel = (label: string) => agents.find(a => a.label === label)!
  const first = byLabel('first look again')
  const child = rectOf(byLabel('resumed child'), pos)!
  expect(child.x).toBe(pos[first.id]!.x + ROW_INDENT)
  expect(child.y).toBeGreaterThan(pos[first.id]!.y)
  expect(pos[byLabel('second look').id]!.y).toBeGreaterThan(child.y + child.h)
  noOverlaps(agents, pos)
})

test('a childless sibling packs next to a sibling with a deep subtree', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('a1', 'a'), agent('a2', 'a1'), agent('b', 'main')]
  const pos = layout(agents, {})
  expect(pos.b!.y).toBe(pos.a!.y)
  expect(pos.b!.x).toBe(pos.a!.x + 26 + 3)
  noOverlaps(agents, pos)
})

test('a spine column stays clear of neighbouring subtrees', () => {
  for (const facts of [waterfall().numbered(), large(120, 200, 7, 4).numbered(), large(120, 200, 3, 1).numbered()]) {
    const agents = derive(foldAll(facts))
    const pos = layout(agents, {})
    noOverlaps(agents, pos)
    const rows = rowsOf(agents)
    for (const p of agents) {
      const kids = agents.filter(a => a.parent === p.id)
      if (!kids.some(a => (rows.get(a.id) ?? 0) > 0)) continue
      const top = rectOf(p, pos)!
      const lastY = Math.max(...kids.map(a => pos[a.id]!.y))
      const column = { x: top.x + 1, y: top.y + top.h, w: 1, h: lastY - top.y - top.h }
      for (const a of agents) expect(overlap(rectOf(a, pos)!, column)).toBe(false)
    }
  }
})

test('a dragged card keeps its slot', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('a1', 'a'), { ...agent('b', 'main'), wave: 1 }, { ...agent('c', 'main'), wave: 1 }]
  const free = layout(agents, {})
  const pos = layout(agents, { a: { x: 3, y: 200 } })
  expect(pos.a).toEqual({ x: 3, y: 200 })
  expect(pos.a1!.x - pos.a!.x).toBe(free.a1!.x - free.a!.x)
  expect(pos.a1!.y - pos.a!.y).toBe(free.a1!.y - free.a!.y)
  for (const id of ['main', 'b', 'c']) expect(pos[id]).toEqual(free[id])
})

test('an inner pin wins over an outer one for its own subtree', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'main'), agent('a1', 'a'), agent('a2', 'a1')]
  const free = layout(agents, {})
  const pos = layout(agents, { a1: { x: 90, y: 90 }, a: { x: 3, y: 200 } })
  expect(pos.a).toEqual({ x: 3, y: 200 })
  expect(pos.a1).toEqual({ x: 90, y: 90 })
  expect(pos.a2!.x - pos.a1!.x).toBe(free.a2!.x - free.a1!.x)
})

test('pins in a parent cycle are each honoured', () => {
  const agents = [agent('main', undefined, 'main'), agent('a', 'b'), agent('b', 'a')]
  const pos = layout(agents, { a: { x: 5, y: 5 }, b: { x: 50, y: 50 } })
  expect(pos.a).toEqual({ x: 5, y: 5 })
  expect(pos.b).toEqual({ x: 50, y: 50 })
})

test('a pin for an agent not shown is ignored', () => {
  expect(layout(tree, { ghost: { x: 50, y: 50 } })).toEqual(layout(tree, {}))
})

describe('benchmark', () => {
  // Folded up front, so the garbage the fold leaves is not collected inside a timed run.
  const sessions = [undefined, 4, 1].map(batch => ({ batch, agents: derive(foldAll(large(400, 2000, 7, batch).numbered())) }))
  for (const { batch, agents } of sessions)
    test(`a layout of 400 agents${batch ? ` finishing in batches of ${batch}` : ''} takes at most 4 ms`, () => {
      layout(agents, {})
      const runs: number[] = []
      for (let k = 0; k < 20; k++) {
        const t0 = performance.now()
        layout(agents, {})
        runs.push(performance.now() - t0)
      }
      // The median, so one collection or preemption from the files running alongside does not decide it.
      runs.sort((x, y) => x - y)
      expect(runs[10]).toBeLessThanOrEqual(4)
    })
})
