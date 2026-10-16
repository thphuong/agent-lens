import { describe, expect, test } from 'claude-code/testing'

import { FAULT_WINDOW_MS, FaultGate } from '../hooks/fault-gate'

const PANE = {
  plugin: 'agent-lens',
  component: 'Pane',
  requestId: 'lens',
  props: {
    title: 'session graph',
    isFocused: false,
    bodyColumns: 87,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 32 },
    view: {},
  },
} as const

describe('fault gate', () => {
  test('the second failure within the window pauses; a reset resumes', () => {
    const gate = new FaultGate()
    expect(gate.record(0)).toBe(false)
    expect(gate.record(1000)).toBe(true)
    expect(gate.isPaused).toBe(true)
    expect(gate.record(2000)).toBe(false)
    expect(gate.reset()).toBe(true)
    expect(gate.isPaused).toBe(false)
  })

  test('failures further apart than the window do not pause', () => {
    const gate = new FaultGate()
    gate.record(0)
    expect(gate.record(FAULT_WINDOW_MS + 1)).toBe(false)
  })
})

test('an oversized region still draws a tree within the bounds', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 500, rows: 250 })
  expect(await ui.drawn({ in: 'graph' })).toBeDefined()
  await ui.unmount()
})
