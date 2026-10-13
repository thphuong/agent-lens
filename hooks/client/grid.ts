// A fixed grid of terminal cells the renderer draws into before painting.
// Each cell holds a glyph and a colour, plus the line masks edges leave in it.

import { graphemes, graphemeWidth } from '../text'

/** Sides a line leaves a cell by; a cell's edge glyph is read off the union. */
export const UP = 1
export const DOWN = 2
export const LEFT = 4
export const RIGHT = 8

export type Pt = { x: number; y: number }

export class Grid {
  readonly ch: string[]
  readonly fg: string[]
  readonly link: Uint8Array
  /** The edge that last laid a horizontal / vertical stroke in the cell, -1 for none. */
  readonly hEdge: Int32Array
  readonly vEdge: Int32Array
  /** Distance along its edge, for the travelling ants. */
  readonly step: Int32Array

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    const n = w * h
    this.ch = new Array<string>(n).fill(' ')
    this.fg = new Array<string>(n).fill('')
    this.link = new Uint8Array(n)
    this.hEdge = new Int32Array(n).fill(-1)
    this.vEdge = new Int32Array(n).fill(-1)
    this.step = new Int32Array(n).fill(-1)
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h
  }

  linkAt(x: number, y: number): number {
    return this.inside(x, y) ? this.link[y * this.w + x]! : 0
  }

  /** Writes one cell. A wide glyph also claims the cell to its right, left empty so rows stay aligned. */
  put(x: number, y: number, c: string, fg: string, wide = false): void {
    x = Math.round(x)
    y = Math.round(y)
    if (!this.inside(x, y)) return
    const i = y * this.w + x
    // Overwriting half of a wide glyph clears its other half.
    if (this.ch[i] === '' && x > 0) this.ch[i - 1] = ' '
    if (x + 1 < this.w && this.ch[i + 1] === '' && !wide) this.ch[i + 1] = ' '
    if (wide && x + 1 >= this.w) {
      this.ch[i] = ' '
      return
    }
    this.ch[i] = c
    this.fg[i] = fg
    this.link[i] = 0
    if (wide) {
      this.ch[i + 1] = ''
      this.fg[i + 1] = fg
      this.link[i + 1] = 0
    }
  }

  /** Writes a string from (x, y), counting terminal cells; stops after `maxCells` when given. Answers the cells used. */
  text(x: number, y: number, s: string, fg: string, maxCells = Infinity): number {
    let used = 0
    for (const g of graphemes(s)) {
      const w = graphemeWidth(g)
      if (w === 0) continue
      if (used + w > maxCells) break
      this.put(x + used, y, g, fg, w === 2)
      used += w
    }
    return used
  }

  fill(x: number, y: number, w: number, h: number, c: string, fg: string): void {
    for (let r = 0; r < h; r++) for (let k = 0; k < w; k++) this.put(x + k, y + r, c, fg)
  }

  /** A rounded box; the interior is cleared. */
  box(x: number, y: number, w: number, h: number, fg: string, dashed = false): void {
    if (w < 2 || h < 2) return
    const hz = dashed ? '╌' : '─'
    const vt = dashed ? '╎' : '│'
    for (let k = 1; k < w - 1; k++) {
      this.put(x + k, y, hz, fg)
      this.put(x + k, y + h - 1, hz, fg)
    }
    for (let r = 1; r < h - 1; r++) {
      this.put(x, y + r, vt, fg)
      this.put(x + w - 1, y + r, vt, fg)
    }
    this.put(x, y, '╭', fg)
    this.put(x + w - 1, y, '╮', fg)
    this.put(x, y + h - 1, '╰', fg)
    this.put(x + w - 1, y + h - 1, '╯', fg)
  }

  /** Walks an axis-aligned polyline for edge `id`, marking both cells of every step. */
  route(points: readonly Pt[], id: number): void {
    let k = 0
    const mark = (x: number, y: number, bits: number) => {
      if (!this.inside(x, y)) return
      const i = y * this.w + x
      this.link[i] = this.link[i]! | bits
      if (bits & (LEFT | RIGHT)) this.hEdge[i] = id
      if (bits & (UP | DOWN)) this.vEdge[i] = id
      if (this.step[i]! < 0) this.step[i] = k
    }
    for (let p = 1; p < points.length; p++) {
      const a = points[p - 1]!
      const b = points[p]!
      const dx = Math.sign(b.x - a.x)
      const dy = Math.sign(b.y - a.y)
      if (dx === 0 && dy === 0) continue
      const out = dx > 0 ? RIGHT : dx < 0 ? LEFT : dy > 0 ? DOWN : UP
      const back = dx > 0 ? LEFT : dx < 0 ? RIGHT : dy > 0 ? UP : DOWN
      for (let x = a.x, y = a.y; x !== b.x || y !== b.y; ) {
        mark(x, y, out)
        x += dx
        y += dy
        k++
        mark(x, y, back)
      }
    }
  }

  /** Copies `src` into this grid with its top-left at (dx, dy). */
  blit(src: Grid, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++) {
      const ty = dy + y
      if (ty < 0 || ty >= this.h) continue
      for (let x = 0; x < src.w; x++) {
        const tx = dx + x
        if (tx < 0 || tx >= this.w) continue
        this.ch[ty * this.w + tx] = src.ch[y * src.w + x]!
        this.fg[ty * this.w + tx] = src.fg[y * src.w + x]!
      }
    }
  }
}
