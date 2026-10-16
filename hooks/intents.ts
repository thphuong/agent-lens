// Validates what the Client posts and applies it. A post is input from code,
// so anything outside the intent vocabulary, or naming an agent that does not
// exist, is dropped.

import type { UiScrollInput } from 'claude-code'

import type { CameraMode, Intent, Overlay, UiState } from '../types'
import { trackWindow, type Timeline } from './model/timeline'

export const MAX_INTENTS = 32
/** Wheel ticks summed in flight are capped at this many rows either way. */
export const MAX_WHEEL = 3
export const SPEEDS = [1, 2, 4, 8, 16, 32]
/** Pinned positions are kept within this many cells of the origin. */
export const WORLD_LIMIT = 100_000

const OVERLAYS = new Set<Overlay>(['none', 'help', 'info'])
const CAMERAS = new Set<CameraMode>(['follow', 'overview', 'manual'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clampWorld = (n: number) => Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, n))

/**
 * The valid intents of a post, in order; `agents` is the set of ids that
 * exist. A track window built before the log was last renumbered (by
 * `renumbered`) indexes facts that have moved, so it is dropped.
 */
export const parseIntents = (data: unknown, agents: ReadonlySet<string>, renumbered?: number): Intent[] => {
  if (!isObj(data) || !Array.isArray(data.intents)) return []
  const stale = renumbered !== undefined && typeof data.renumbered === 'number' && data.renumbered !== renumbered
  const out: Intent[] = []
  for (const raw of data.intents.slice(0, MAX_INTENTS)) {
    if (!isObj(raw)) continue
    const known = (id: unknown): id is string => typeof id === 'string' && agents.has(id)
    switch (raw.type) {
      case 'seek':
        if (typeof raw.to === 'number' && Number.isFinite(raw.to)) out.push({ type: 'seek', to: raw.to })
        break
      case 'seekPrompt':
      case 'step':
      case 'seekMarker':
        if (raw.dir === 1 || raw.dir === -1) out.push({ type: raw.type, dir: raw.dir })
        break
      case 'live':
      case 'play':
      case 'compress':
      case 'relayout':
      case 'close':
        out.push({ type: raw.type })
        break
      case 'speed':
        if (typeof raw.speed === 'number' && SPEEDS.includes(raw.speed)) out.push({ type: 'speed', speed: raw.speed })
        break
      case 'select':
        if (raw.id === null || known(raw.id)) out.push({ type: 'select', id: raw.id })
        break
      case 'overlay':
        if (OVERLAYS.has(raw.overlay as Overlay)) out.push({ type: 'overlay', overlay: raw.overlay as Overlay })
        break
      case 'detailFollow':
        if (typeof raw.on === 'boolean') out.push({ type: 'detailFollow', on: raw.on })
        break
      case 'camera':
        if (CAMERAS.has(raw.mode as CameraMode)) out.push({ type: 'camera', mode: raw.mode as CameraMode })
        break
      case 'track':
        if (stale) break
        if (raw.from === null) out.push({ type: 'track', from: null })
        else if (Number.isSafeInteger(raw.from) && Number.isSafeInteger(raw.to) && (raw.from as number) < (raw.to as number))
          out.push({ type: 'track', from: raw.from as number, to: raw.to as number })
        break
      case 'pin':
        if (known(raw.id) && typeof raw.x === 'number' && typeof raw.y === 'number' && Number.isFinite(raw.x) && Number.isFinite(raw.y))
          out.push({ type: 'pin', id: raw.id, x: clampWorld(Math.round(raw.x)), y: clampWorld(Math.round(raw.y)) })
        break
    }
  }
  return out
}

/** The UI state with its track window as shown: a seek from there must not pan it from where it was stored. */
const shownTrack = (ui: UiState, timeline: Timeline): UiState => {
  if (!ui.track) return ui
  const shown = trackWindow(ui.track, timeline.length, timeline.playhead)
  if (shown.from === ui.track.from && shown.to === ui.track.to) return ui
  const { track: _, ...rest } = ui
  return shown.to - shown.from >= timeline.length ? rest : { ...ui, track: shown }
}

/** Applies intents in order to the timeline (in place) and the UI state; answers the new UI state and whether to close. */
export const applyIntents = (intents: readonly Intent[], timeline: Timeline, ui: UiState): { ui: UiState; close: boolean } => {
  let next: UiState = shownTrack(ui, timeline)
  let close = false
  for (const it of intents) {
    switch (it.type) {
      case 'seek':
        timeline.seek(it.to)
        break
      case 'seekPrompt':
        timeline.seekPrompt(it.dir)
        break
      case 'step':
        timeline.step(it.dir)
        break
      case 'seekMarker':
        timeline.seekMarker(it.dir)
        break
      case 'live':
        timeline.goLive()
        break
      case 'play':
        timeline.togglePlay()
        break
      case 'compress':
        timeline.toggleCompress()
        break
      case 'speed':
        timeline.speed = it.speed
        break
      case 'select':
        next = { ...next, selected: it.id ?? undefined }
        break
      case 'overlay':
        next = { ...next, overlay: it.overlay }
        break
      case 'detailFollow':
        next = { ...next, detailFollow: it.on }
        break
      case 'camera':
        next = { ...next, camera: it.mode }
        break
      case 'pin':
        next = { ...next, pinned: { ...next.pinned, [it.id]: { x: it.x, y: it.y } } }
        break
      case 'track': {
        const { track: _, ...rest } = next
        next = it.from === null ? rest : { ...next, track: { from: it.from, to: it.to } }
        break
      }
      case 'relayout':
        next = { ...next, pinned: {} }
        break
      case 'close':
        close = true
        break
    }
  }
  return { ui: next, close }
}

/**
 * The UI state recording a person's wheel tick over the pane, for the Client
 * to zoom by; undefined for a scroll key or a plugin's scroll, which move the
 * window as usual.
 */
export const wheelTick = (ui: UiState, e: Pick<UiScrollInput, 'by' | 'origin' | 'pointer'>): UiState | undefined => {
  if (!e.pointer || e.origin.kind !== 'person' || e.by === 0) return undefined
  const by = Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, Math.round(e.by)))
  return { ...ui, wheel: { seq: (ui.wheel?.seq ?? 0) + 1, by, column: e.pointer.column, row: e.pointer.row } }
}
