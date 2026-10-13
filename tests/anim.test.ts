import { describe, expect, test } from 'claude-code/testing'

import { CHIP_TTL_ERR_MS, CHIP_TTL_MS, Presentation } from '../hooks/client/anim'
import { Camera, GLIDE_SECS } from '../hooks/client/camera'
import type { ViewRun } from '../types'

const run = (over: Partial<ViewRun>): ViewRun => ({ key: 'a:1', agent: 'a', tool: 'Read', count: 1, state: 'ok', firstSeq: 1, lastSeq: 5, ...over })

describe('afterglow', () => {
  test('a settled chip glows, fades, and freezes while paused', () => {
    const p = new Presentation()
    const r = run({})
    p.observe([r])
    expect(p.chipGlow(r)).toBe(3)
    p.advance(CHIP_TTL_MS / 2, true)
    const mid = p.chipGlow(r)
    expect(mid).toBeLessThan(3)
    p.advance(10_000, false)
    expect(p.chipGlow(r)).toBe(mid)
    p.advance(CHIP_TTL_MS, true)
    expect(p.chipGlow(r)).toBeUndefined()
  })

  test('a run gaining a member glows again from the start', () => {
    const p = new Presentation()
    p.observe([run({})])
    p.advance(CHIP_TTL_MS - 100, true)
    const grown = run({ count: 2, lastSeq: 9 })
    p.observe([grown])
    expect(p.chipGlow(grown)).toBe(3)
  })

  test('an error chip lasts 4 s, others 2.5 s', () => {
    const p = new Presentation()
    const ok = run({ key: 'ok' })
    const err = run({ key: 'err', state: 'err' })
    p.observe([ok, err])
    p.advance(CHIP_TTL_MS + 1, true)
    expect(p.chipGlow(ok)).toBeUndefined()
    expect(p.chipGlow(err)).toBeDefined()
    p.advance(CHIP_TTL_ERR_MS - CHIP_TTL_MS, true)
    expect(p.chipGlow(err)).toBeUndefined()
  })

  test('nothing at or below the baseline flashes; a running chip stays bright', () => {
    const p = new Presentation()
    p.adoptBaseline(10)
    const old = run({ lastSeq: 7 })
    p.observe([old])
    expect(p.chipGlow(old)).toBeUndefined()
    expect(p.chipGlow(run({ state: 'run', lastSeq: 7 }))).toBe(3)
    const fresh = run({ key: 'n', lastSeq: 11 })
    p.observe([fresh])
    expect(p.chipGlow(fresh)).toBe(3)
  })
})

describe('camera', () => {
  test('a glide converges within three glide times', () => {
    const c = new Camera()
    c.aim({ x: 200, y: -80, z: 0.5 })
    for (let t = 0; t < GLIDE_SECS * 3000; t += 16) c.glide(16)
    expect(c.isSettling).toBe(false)
    expect({ x: c.x, y: c.y, z: c.z }).toEqual({ x: 200, y: -80, z: 0.5 })
  })

  test('zooming keeps the cell under the pointer fixed', () => {
    const c = new Camera({ x: 10, y: 5, z: 1 })
    const before = c.screenToWorld(30, 12)
    c.zoomAt(30, 12, 1.5)
    const after = c.screenToWorld(30, 12)
    expect(Math.abs(after.x - before.x)).toBeLessThan(1e-9)
    expect(Math.abs(after.y - before.y)).toBeLessThan(1e-9)
    c.zoomAt(0, 0, 100)
    expect(c.z).toBe(2.5)
  })

  test('fit shows the whole rect', () => {
    const v = Camera.fit({ x: 0, y: 0, w: 200, h: 40 }, 80, 30)
    expect(v.z).toBe(0.4)
    expect(v.x + 80 / v.z / 2).toBe(100)
  })
})

test('a running card keeps pulsing and its ants keep moving while paused', () => {
  const p = new Presentation()
  const pulse = p.pulse()
  const ants = p.antPhase()
  p.advance(240, false)
  expect(p.pulse()).not.toBe(pulse)
  expect(p.antPhase()).toBeGreaterThan(ants)
  expect(p.watchMs).toBe(0)
})
