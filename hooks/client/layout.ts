// Where cards sit, in world cells. Cards are placed in arrival order and an
// existing card never moves; a relayout places them all again from scratch.

import type { AgentKind, Point, ViewAgent } from '../../types'

export const CARD: Record<AgentKind, { w: number; h: number }> = {
  main: { w: 30, h: 8 },
  group: { w: 30, h: 7 },
  sub: { w: 26, h: 7 },
}
export const SIBLING_GAP = 3
export const LEVEL_GAP = 4

export type Rect = { x: number; y: number; w: number; h: number }
export type Positions = Record<string, Point>

type Node = Pick<ViewAgent, 'id' | 'parent' | 'kind'>

export const sizeOf = (a: Pick<ViewAgent, 'kind'>) => CARD[a.kind]

export const rectOf = (a: Node, positions: Positions): Rect | undefined => {
  const p = positions[a.id]
  return p ? { x: p.x, y: p.y, ...sizeOf(a) } : undefined
}

const childrenOf = (agents: readonly Node[]) => {
  const kids = new Map<string | undefined, Node[]>()
  for (const a of agents) {
    const list = kids.get(a.parent) ?? []
    list.push(a)
    kids.set(a.parent, list)
  }
  return kids
}

/**
 * Lays every card out afresh, in arrival order, as incremental placement
 * would have: so the layout at any point of the timeline is the one the
 * cards had when they first appeared.
 */
export const relayout = (agents: readonly Node[]): Positions => place({}, agents, {})

const overlaps = (a: Rect, b: Rect, margin: number) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin

/**
 * Places only the agents `positions` lacks, leaving every existing card where
 * it is: a pinned position if the person dragged it, else under its parent,
 * right of its placed siblings, in the first slot that overlaps nothing.
 */
export const place = (positions: Positions, agents: readonly Node[], pinned: Readonly<Positions>): Positions => {
  const out: Positions = { ...positions }
  const byId = new Map(agents.map(a => [a.id, a]))
  const placed: Rect[] = []
  for (const a of agents) {
    const r = rectOf(a, out)
    if (r) placed.push(r)
  }
  // A group's frame is an obstacle too, except to the group's own members;
  // measured as each card is placed, so one pass matches placing them one by one.
  const groups = agents.filter(a => a.kind === 'group')
  const inside = (a: Node, group: string) => {
    for (let p = a.parent, k = 0; p !== undefined && k < 64; p = byId.get(p)?.parent, k++) if (p === group) return true
    return false
  }
  const visit = (a: Node, depth: number) => {
    if (out[a.id] || depth > 64) return
    const pin = pinned[a.id]
    if (pin) {
      out[a.id] = { x: pin.x, y: pin.y }
      placed.push({ ...pin, ...sizeOf(a) })
      return
    }
    const parent = a.parent !== undefined ? byId.get(a.parent) : undefined
    if (parent) visit(parent, depth + 1)
    const size = sizeOf(a)
    let x = 0
    let y = 0
    const pr = parent ? rectOf(parent, out) : undefined
    if (pr) {
      y = pr.y + pr.h + LEVEL_GAP + (parent!.kind === 'group' ? 1 : 0)
      const siblings = agents.filter(s => s.parent === a.parent && s.id !== a.id && out[s.id])
      x = siblings.length
        ? Math.max(...siblings.map(s => out[s.id]!.x + sizeOf(s).w)) + SIBLING_GAP
        : pr.x + Math.floor((pr.w - size.w) / 2)
    }
    const rect = { x, y, ...size }
    const blocking = groups.flatMap(g => (out[g.id] && !inside(a, g.id) ? (frameOf(g, agents, out) ?? []) : []))
    while (placed.some(p => overlaps(rect, p, 1)) || blocking.some(f => overlaps(rect, f, 1))) rect.x += 1
    out[a.id] = { x: rect.x, y: rect.y }
    placed.push(rect)
  }
  for (const a of agents) visit(a, 0)
  return out
}

/** A workflow group's frame: around its card and every descendant's, padded by one cell. */
export const frameOf = (group: Node, agents: readonly Node[], positions: Positions): Rect | undefined => {
  const kids = childrenOf(agents)
  const rects: Rect[] = []
  const walk = (a: Node, depth: number) => {
    const r = rectOf(a, positions)
    if (r) rects.push(r)
    if (depth < 64) for (const c of kids.get(a.id) ?? []) walk(c, depth + 1)
  }
  walk(group, 0)
  if (rects.length === 0) return undefined
  return bounds(rects, 1)
}

export const bounds = (rects: readonly Rect[], pad = 0): Rect => {
  const x0 = Math.min(...rects.map(r => r.x)) - pad
  const y0 = Math.min(...rects.map(r => r.y)) - pad
  const x1 = Math.max(...rects.map(r => r.x + r.w)) + pad
  const y1 = Math.max(...rects.map(r => r.y + r.h)) + pad
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
