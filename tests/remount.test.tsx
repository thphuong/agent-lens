import { expect, mock, test } from 'claude-code/testing'

import { CHIP_TTL_MS } from '../hooks/client/anim'
import { FRAME_MS } from '../hooks/frame'
import type { Props } from '../types'

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

test('a zoomed track keeps its window across a remount', async ($, on) => {
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'viz' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 60; i++) await $.tool.call({ tool: 'Read', command: 'x' } as never)
  const timelineOf = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
    ((await ui.find({ type: 'Client' }))!.props.props as Props).view.timeline

  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await first.resize({ columns: 120, rows: 40 })
  await first.post({ intents: [{ type: 'seek', to: 30 }, { type: 'track', from: 10, to: 40 }] })
  await first.redraw()
  expect(await timelineOf(first)).toMatchObject({ from: 10, to: 40, playhead: 30 })
  await first.unmount()

  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await again.resize({ columns: 120, rows: 40 })
  expect(await timelineOf(again)).toMatchObject({ from: 10, to: 40 })
  expect(await again.find({ type: 'Text', text: /━/, in: 'graph' })).toBeDefined()
  await again.unmount()
})

// The test runtime has timers, but no DOM or Node types declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

type Drawn = { children?: unknown[] }

/** The text of the canvas rows a Client painted: the rows above the timeline panel and the status bar. */
const canvasRows = (tree: unknown): string[] => {
  const text = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as Drawn).children ?? []).map(text).join('') : '')
  return ((tree as Drawn).children ?? []).map(text).slice(0, 24)
}

/**
 * Lets cards and the camera glide home. The Client steps them by real time
 * between frames, at most 250 ms a frame, so three frames that far apart
 * close all but a thousandth of any gap and snap the rest.
 */
const settle = async (ui: { advance: (ms: number) => Promise<void> }) => {
  for (let k = 0; k < 3; k++) {
    await new Promise<void>(done => setTimeout(done, 260))
    await ui.advance(FRAME_MS)
  }
}

test('the cards lie where a fresh mount puts them, whether reached live or by a seek', async ($, on) => {
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'viz' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  let n = 0
  on('agent.spawn', () => ({ model: 'model-b', agentId: `agent${++n}` }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const mount = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 120, rows: 40 })
    await ui.post({ intents: [{ type: 'camera', mode: 'overview' }] })
    return ui
  }
  const drawn = async (ui: Awaited<ReturnType<typeof mount>>) => canvasRows(await ui.drawn({ in: 'graph' }))
  const spawn = async (description: string, parentAgentId?: string) => {
    await clock.advance(100)
    const r = (await $.agent.spawn({ tool_use_id: '', prompt: 'p', description, subagentType: 'fake-type', parentAgentId } as never)) as { agentId: string }
    return r.agentId
  }
  const finish = async (agentId: string) => {
    await clock.advance(100)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: `t-${agentId}`, agentId, reason: 'answer' } as never)
  }

  const ui = await mount()
  // Six agents at once wrap to a second row; then the first one spawns a
  // child, which pushes the second row down.
  const wide: string[] = []
  for (let k = 0; k < 6; k++) wide.push(await spawn(`wide lens ${k}`))
  await clock.advance(300)
  await ui.advance(FRAME_MS)
  const late = await spawn('late child', wide[0])
  await finish(late)
  for (const id of wide) await finish(id)
  await clock.advance(300)
  await settle(ui)
  const live = await drawn(ui)
  expect(live.join('\n')).toContain('late child')

  // A seek back to before the late child, and a mount there.
  await ui.post({ intents: [{ type: 'seek', to: 12 }] })
  await settle(ui)
  const seeked = await drawn(ui)
  expect(seeked).not.toEqual(live)
  await ui.unmount()
  const atSeek = await mount()
  expect(await drawn(atSeek)).toEqual(seeked)

  // Back to live, and a mount there.
  await atSeek.post({ intents: [{ type: 'live' }] })
  await settle(atSeek)
  expect(await drawn(atSeek)).toEqual(live)
  await atSeek.unmount()
  const fresh = await mount()
  expect(await drawn(fresh)).toEqual(live)
  await fresh.unmount()
})
