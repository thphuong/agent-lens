// Where cards sit, in world cells. New cards are placed incrementally and an
// existing card never moves; a relayout lays out the whole tree afresh.

import type { AgentKind, Point, ViewAgent } from '../../types'

export const CARD: Record<AgentKind, { w: number; h: number }> = {
  main: { w: 30, h: 7 },
  group: { w: 30, h: 7 },
  sub: { w: 26, h: 6 },
}
export const SIBLING_GAP = 3
export const LEVEL_GAP = 4
/** Room a workflow group's frame takes around its subtree. */
export const GROUP_PAD = 2

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
 * A tidy tree: each subtree as wide as its card or its children side by side,
 * a parent centred over its children, levels stacked by the tallest card at
 * each depth. Deterministic for the same agents in the same order.
 */
export const relayout = (agents: readonly Node[]): Positions => {
  const kids = childrenOf(agents)
  const ids = new Set(agents.map(a => a.id))
  const roots = agents.filter(a => a.parent === undefined || !ids.has(a.parent))
  const widths = new Map<string, number>()
  const width = (a: Node, seen: Set<string>): number => {
    if (seen.has(a.id)) return sizeOf(a).w
    seen.add(a.id)
    const cs = kids.get(a.id) ?? []
    const inner = cs.reduce((s, c) => s + width(c, seen), 0) + SIBLING_GAP * Math.max(0, cs.length - 1)
    const w = Math.max(sizeOf(a).w, inner) + (a.kind === 'group' ? 2 * GROUP_PAD : 0)
    widths.set(a.id, w)
    return w
  }
  for (const r of roots) width(r, new Set())

  const depthOf = new Map<string, number>()
  const rowH: number[] = []
  const mark = (a: Node, d: number) => {
    if (depthOf.has(a.id)) return
    depthOf.set(a.id, d)
    rowH[d] = Math.max(rowH[d] ?? 0, sizeOf(a).h)
    for (const c of kids.get(a.id) ?? []) mark(c, d + 1)
  }
  for (const r of roots) mark(r, 0)
  const rowY: number[] = []
  for (let d = 0, y = 0; d < rowH.length; d++) {
    rowY[d] = y
    y += rowH[d]! + LEVEL_GAP
  }

  const out: Positions = {}
  const place = (a: Node, left: number) => {
    if (out[a.id]) return
    const w = widths.get(a.id) ?? sizeOf(a).w
    out[a.id] = { x: left + Math.floor((w - sizeOf(a).w) / 2), y: rowY[depthOf.get(a.id) ?? 0]! }
    const cs = kids.get(a.id) ?? []
    const inner = cs.reduce((s, c) => s + (widths.get(c.id) ?? sizeOf(c).w), 0) + SIBLING_GAP * Math.max(0, cs.length - 1)
    let x = left + Math.floor((w - inner) / 2)
    for (const c of cs) {
      place(c, x)
      x += (widths.get(c.id) ?? sizeOf(c).w) + SIBLING_GAP
    }
  }
  let left = 0
  for (const r of roots) {
    place(r, left)
    left += (widths.get(r.id) ?? sizeOf(r).w) + SIBLING_GAP
  }
  return out
}

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
    while (placed.some(p => overlaps(rect, p, 1))) rect.x += 1
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
