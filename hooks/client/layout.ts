// Where cards sit, in world cells: a pure function of the agents shown, in
// arrival order with their waves, and the dragged positions. Siblings that
// ran at the same time share a row, at most WAVE_WIDTH wide; a later wave, or
// the rest of a wide one, starts a row below the subtrees of the row above,
// so a growing subtree pushes later rows down. Siblings in a row pack by
// contour. A dragged card takes its subtree to its pin and leaves its slot
// empty.

import type { AgentKind, Point, ViewAgent } from '../../types'

export const CARD: Record<AgentKind, { w: number; h: number }> = {
  main: { w: 30, h: 8 },
  group: { w: 30, h: 7 },
  sub: { w: 26, h: 8 },
}
export const SIBLING_GAP = 3
export const LEVEL_GAP = 4
export const WAVE_WIDTH = 4
/** Every row of children starts this far right of its parent, leaving a column for the spine. */
export const ROW_INDENT = 3

export type Rect = { x: number; y: number; w: number; h: number }
export type Positions = Record<string, Point>

type Node = Pick<ViewAgent, 'id' | 'parent' | 'kind'> & Partial<Pick<ViewAgent, 'wave'>>

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
 * Each agent's row under its parent, from 0. Siblings in arrival order fill
 * a row while they share a wave and it holds fewer than WAVE_WIDTH cards.
 */
export const rowsOf = (agents: readonly Node[]): Map<string, number> => {
  const rows = new Map<string, number>()
  const last = new Map<string | undefined, { row: number; wave: number; n: number }>()
  for (const a of agents) {
    const wave = a.wave ?? 0
    const cur = last.get(a.parent)
    if (!cur) last.set(a.parent, { row: 0, wave, n: 1 })
    else if (cur.wave === wave && cur.n < WAVE_WIDTH) cur.n += 1
    else Object.assign(cur, { row: cur.row + 1, wave, n: 1 })
    rows.set(a.id, last.get(a.parent)!.row)
  }
  return rows
}

/**
 * What a subtree's neighbours keep clear of, relative to its root card at
 * (0, 0): its cards, spines and frames, and the bounds of its cards alone.
 */
type Sub = { rects: Rect[]; x0: number; x1: number; y1: number }

/**
 * Packs subtrees left to right in one row from `x`, each as far left as the
 * rects already in the row allow: SIBLING_GAP clear of every rect it meets
 * in y, with a margin of 1. Answers where each one landed; `into` gains the
 * row's rects.
 */
const packRow = (subs: readonly Sub[], x: number, y: number, into: Rect[]): number[] => {
  const from = into.length
  const at: number[] = []
  for (const sub of subs) {
    let dx = x
    const placed = into.length
    for (const a of sub.rects)
      for (let j = from; j < placed; j++) {
        const b = into[j]!
        if (a.y + y < b.y + b.h + 1 && b.y < a.y + y + a.h + 1 && b.x + b.w + SIBLING_GAP - a.x > dx) dx = b.x + b.w + SIBLING_GAP - a.x
      }
    for (const a of sub.rects) into.push({ x: a.x + dx, y: a.y + y, w: a.w, h: a.h })
    at.push(dx)
    // The first rect is the subtree's own card.
    x = dx + sub.rects[0]!.w + SIBLING_GAP
  }
  return at
}

/**
 * Where every card sits, from the agents shown (in arrival order, with their
 * wave) and the dragged positions alone. Each parent's rows of children sit
 * below it, each row below the subtrees of the row above; siblings in a row
 * pack by contour. A pinned card and its subtree then move to the pin,
 * leaving their slot empty, so a drag moves no other card.
 */
export const layout = (agents: readonly Node[], pinned: Readonly<Positions>): Positions => {
  const byId = new Map(agents.map(a => [a.id, a]))
  const kids = childrenOf(agents)
  const rows = rowsOf(agents)
  const seen = new Set<string>()
  /** Each card's offset from the card it was laid under, or its place if it was laid as a root. */
  const offset = new Map<string, { under?: string; x: number; y: number }>()

  /** Lays `node`'s subtree out; with `isAlone`, nothing packs against it, so its rects are not gathered. */
  const lay = (node: Node, depth: number, isAlone = false): Sub => {
    seen.add(node.id)
    const size = sizeOf(node)
    const sub: Sub = { rects: [{ x: 0, y: 0, w: size.w, h: size.h }], x0: 0, x1: size.w, y1: size.h }
    const byRow: Node[][] = []
    if (depth < 64) for (const c of kids.get(node.id) ?? []) if (!seen.has(c.id)) (byRow[rows.get(c.id) ?? 0] ??= []).push(c)
    let y = size.h + LEVEL_GAP + (node.kind === 'group' ? 1 : 0)
    let lastRowY = y
    let rowCount = 0
    for (const row of byRow) {
      if (!row) continue
      const subs: Sub[] = []
      for (const c of row) subs.push(lay(c, depth + 1))
      const into = isAlone ? [] : sub.rects
      const from = into.length
      const at = packRow(subs, ROW_INDENT, y, into)
      for (let i = 0; i < row.length; i++) {
        const c = subs[i]!
        const dx = at[i]!
        offset.set(row[i]!.id, { under: node.id, x: dx, y })
        if (c.x0 + dx < sub.x0) sub.x0 = c.x0 + dx
        if (c.x1 + dx > sub.x1) sub.x1 = c.x1 + dx
        if (c.y1 + y > sub.y1) sub.y1 = c.y1 + y
      }
      let bottom = y
      for (let j = from; j < into.length; j++) bottom = Math.max(bottom, into[j]!.y + into[j]!.h)
      lastRowY = y
      rowCount += 1
      y = bottom + LEVEL_GAP
    }
    // The spine runs down the parent's left column to its last row.
    if (rowCount > 1) sub.rects.push({ x: 0, y: size.h, w: 2, h: lastRowY - size.h })
    // The frame frameOf draws, from the same cards with the same padding.
    if (node.kind === 'group') sub.rects.push({ x: sub.x0 - 1, y: -1, w: sub.x1 - sub.x0 + 2, h: sub.y1 + 2 })
    return sub
  }

  let top = 0
  const flow = (roots: readonly Node[]) => {
    const subs = roots.map(r => lay(r, 0, roots.length === 1))
    const at = subs.length === 1 ? [0] : packRow(subs, 0, top, [])
    roots.forEach((r, i) => offset.set(r.id, { x: at[i]!, y: top }))
    // What comes after starts a row of its own below everything laid so far.
    top = Math.max(top, ...subs.map(s => top + s.y1)) + LEVEL_GAP
  }
  flow(agents.filter(a => a.parent === undefined || !byId.has(a.parent)))
  // A parent cycle leaves cards no root reaches: each starts a row of its own.
  for (const a of agents) if (!seen.has(a.id)) flow([a])

  const out: Positions = {}
  const resolve = (id: string): Point => {
    const done = out[id]
    if (done) return done
    const o = offset.get(id)!
    const base = o.under !== undefined ? resolve(o.under) : { x: 0, y: 0 }
    return (out[id] = { x: base.x + o.x, y: base.y + o.y })
  }
  for (const a of agents) resolve(a.id)

  for (const a of agents) {
    if (!pinned[a.id]) continue
    const from = out[a.id]!
    const dx = pinned[a.id]!.x - from.x
    const dy = pinned[a.id]!.y - from.y
    const moved = new Set<string>()
    const move = (id: string) => {
      // A card pinned in its own right moves to its own pin, so an inner pin wins for its subtree.
      if (moved.has(id) || (id !== a.id && pinned[id])) return
      moved.add(id)
      const p = out[id]
      if (p) out[id] = { x: p.x + dx, y: p.y + dy }
      for (const c of kids.get(id) ?? []) move(c.id)
    }
    move(a.id)
  }
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
