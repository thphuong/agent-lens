// Composes the graph into a grid for one camera: group frames behind, then
// edges, then cards on top.

import type { ViewAgent } from '../../types'
import type { Chip } from './chips'
import { elbow, hook, strokes } from './edges'
import { Grid } from './grid'
import { drawCard } from './cards'
import { frameOf, rectOf, type Positions, type Rect } from './layout'
import { AMBER_DIM, FRAME, GREY, HOVER, ANT } from './palette'

export type Camera = { x: number; y: number; z: number }

export type SceneLook = {
  hover?: string
  selected?: string
  /** Ant phase and the agents whose incoming edge carries ants. */
  ants?: { phase: number; agents: ReadonlySet<string> }
  /** Per-agent border colour overrides (pulse). */
  borders?: ReadonlyMap<string, string>
  /** Each agent's chips. */
  chips?: (agent: ViewAgent) => Chip[]
}

export const toScreen = (cam: Camera, r: Rect): Rect => {
  const x = Math.round((r.x - cam.x) * cam.z)
  const y = Math.round((r.y - cam.y) * cam.z)
  return { x, y, w: Math.max(1, Math.round((r.x + r.w - cam.x) * cam.z) - x), h: Math.max(1, Math.round((r.y + r.h - cam.y) * cam.z) - y) }
}

/** Draws the graph into `g` through `cam`; answers each visible card's screen rect for hit-testing. */
export const drawScene = (g: Grid, agents: readonly ViewAgent[], positions: Positions, cam: Camera, look: SceneLook = {}): Map<string, Rect> => {
  const screen = new Map<string, Rect>()
  for (const a of agents) {
    const r = rectOf(a, positions)
    if (r) screen.set(a.id, toScreen(cam, r))
  }

  for (const a of agents) {
    if (a.kind !== 'group') continue
    const f = frameOf(a, agents, positions)
    if (f) {
      const s = toScreen(cam, f)
      g.box(s.x, s.y, s.w, s.h, FRAME, true)
    }
  }

  const index = new Map(agents.map((a, i) => [a.id, i]))
  const family: number[] = agents.map(a => (a.parent !== undefined ? (index.get(a.parent) ?? -1) : -1))
  agents.forEach((a, i) => {
    if (a.parent === undefined) return
    const p = screen.get(a.parent)
    const c = screen.get(a.id)
    if (!p || !c) return
    const from = { x: p.x + Math.floor(p.w / 2), y: p.y + p.h - 1 }
    const to = { x: c.x + Math.floor(c.w / 2), y: c.y }
    if (to.y <= from.y + 1) return g.route(hook(from, { x: to.x, y: c.y + c.h - 1 }), i)
    const barY = from.y + Math.max(1, Math.floor((to.y - from.y) / 2))
    g.route(elbow(from, to, barY), i)
  })
  const highlighted = look.hover !== undefined ? index.get(look.hover) : undefined
  const antEdges = new Set<number>()
  for (const id of look.ants?.agents ?? []) {
    const i = index.get(id)
    if (i !== undefined) antEdges.add(i)
  }
  strokes(g, {
    family,
    color: e => (e === highlighted ? HOVER : AMBER_DIM),
    ants: look.ants ? { edges: antEdges, phase: look.ants.phase, color: ANT } : undefined,
  })

  for (const a of agents) {
    const s = screen.get(a.id)
    if (!s || s.x >= g.w || s.y >= g.h || s.x + s.w <= 0 || s.y + s.h <= 0) continue
    const border = a.id === look.hover ? HOVER : a.id === look.selected ? GREY[4] : look.borders?.get(a.id)
    drawCard(g, a, s.x, s.y, s.w, s.h, { border, chips: look.chips?.(a) })
  }
  return screen
}
