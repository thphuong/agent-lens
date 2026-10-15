// The camera: a world offset and zoom that glides toward its target with an
// exponential ease, so follow and overview moves are smooth at any frame rate.

import type { Rect } from './layout'

export const GLIDE_SECS = 0.35
export const MIN_ZOOM = 0.3
export const MAX_ZOOM = 2.5
/** Within this distance (cells, zoom) the camera snaps to its target and stops moving. */
export const SNAP = 0.25
const SNAP_Z = 0.002

export type View = { x: number; y: number; z: number }

/** How far one step of `dtMs` closes the gap to a target, so anything that glides settles in about GLIDE_SECS. */
export const glideK = (dtMs: number): number => 1 - Math.exp(-dtMs / ((GLIDE_SECS * 1000) / 3))

const clampZ = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))

export class Camera implements View {
  x = 0
  y = 0
  z = 1
  target?: View

  constructor(view?: View) {
    if (view) Object.assign(this, { x: view.x, y: view.y, z: view.z })
  }

  /** Eases toward the target by `dtMs`; answers whether the camera moved. */
  glide(dtMs: number): boolean {
    const t = this.target
    if (!t) return false
    const k = glideK(dtMs)
    this.x += (t.x - this.x) * k
    this.y += (t.y - this.y) * k
    this.z += (t.z - this.z) * k
    if (Math.abs(t.x - this.x) < SNAP && Math.abs(t.y - this.y) < SNAP && Math.abs(t.z - this.z) < SNAP_Z) {
      this.x = t.x
      this.y = t.y
      this.z = t.z
      this.target = undefined
    }
    return true
  }

  get isSettling(): boolean {
    return this.target !== undefined
  }

  /** A target showing all of `bounds` in a `w`×`h` viewport, centred, zoomed no further in than 1. */
  static fit(bounds: Rect, w: number, h: number): View {
    const z = clampZ(Math.min(1, w / bounds.w, h / bounds.h))
    return { x: bounds.x + bounds.w / 2 - w / z / 2, y: bounds.y + bounds.h / 2 - h / z / 2, z }
  }

  /** A target centring `rect` at zoom `z`. */
  static centre(rect: Rect, w: number, h: number, z: number): View {
    return { x: rect.x + rect.w / 2 - w / z / 2, y: rect.y + rect.h / 2 - h / z / 2, z }
  }

  /** Aims at `view` unless already there or already aiming there. */
  aim(view: View): void {
    const t = this.target ?? this
    if (Math.abs(t.x - view.x) < 0.01 && Math.abs(t.y - view.y) < 0.01 && Math.abs(t.z - view.z) < 0.0001) return
    this.target = { ...view }
  }

  /** Zooms by `factor` keeping the world point under screen cell (sx, sy) fixed; takes effect at once. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.x + sx / this.z
    const wy = this.y + sy / this.z
    this.z = clampZ(this.z * factor)
    this.x = wx - sx / this.z
    this.y = wy - sy / this.z
    this.target = undefined
  }

  pan(dx: number, dy: number): void {
    this.x += dx
    this.y += dy
    this.target = undefined
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.z, y: (wy - this.y) * this.z }
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.x + sx / this.z, y: this.y + sy / this.z }
  }
}
