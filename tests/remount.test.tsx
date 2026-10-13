import { expect, test } from 'claude-code/testing'

import { CHIP_TTL_MS } from '../hooks/client/anim'

const PANE = {
  plugin: 'session-viz',
  component: 'Pane',
  requestId: 'viz',
  props: { title: 'session graph', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('a remount neither flashes settled chips nor loses the camera mode', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'viz' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 50; i++) await $.tool.call({ tool: i % 2 ? 'Read' : 'Grep', command: 'x' } as never)

  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.resize({ columns: 120, rows: 40 })
  // Switch the camera to overview through the Client's own post.
  await first.post({ intents: [{ type: 'camera', mode: 'overview' }] })
  await first.advance(CHIP_TTL_MS + 100)
  await first.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await again.resize({ columns: 120, rows: 40 })
  expect(await again.find({ type: 'Text', text: /⌖ overview/, in: 'graph' })).toBeDefined()
  // Settled runs from before the mount are history: no chip glyph shows on a card.
  expect(await again.find({ type: 'Text', text: /✓ (Read|Grep)/, in: 'graph' })).toBeUndefined()
  await again.unmount()
})
