import { describe, expect, mock, test, type TestBody } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { MAIN, type Fact } from '../hooks/model/facts'
import { foldAll } from '../hooks/model/fold'
import { runsOf } from '../hooks/model/runs'
import { FactLog, type LogPort } from '../hooks/persist'
import type { LogMeta } from '../types'
import { Session } from './fixtures/generate'

const PANE = {
  plugin: 'session-viz',
  component: 'Pane',
  requestId: 'viz',
  props: { title: 'session graph', isFocused: false, bodyColumns: 87, placement: 'dock', scroll: { offset: 0, bodyRows: 32 }, view: {} },
} as const

const row = (over: Partial<SessionMessage>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [], ...over })

/** A session whose id and history the test can switch, as a /clear or resume does. */
const engine = (...[$, on]: Parameters<TestBody>) => {
  const clock = mock.clock(on)
  const state = { id: 's1', history: {} as Record<string, SessionMessage[]> }
  const writes: { key: string; value: unknown }[] = []
  on('state.set', (_, e, next) => {
    writes.push({ key: e.key, value: e.value })
    return next(e)
  })
  on('session.id', () => ({ value: state.id }))
  on('session.messages', (_, e) => ({ value: state.history[`${state.id}:${e.agentId ?? MAIN}`] ?? [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'viz' } }))
  on('tool.call', () => ({ result: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const open = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 87, rows: 32 })
    return ui
  }
  return { clock, state, writes, open }
}

describe('session end', () => {
  test('a /clear empties the graph, then shows the new session’s work', async ($, on) => {
    const { clock, state, open } = engine($, on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', command: 'x' } as never)
    await clock.advance(300)
    const ui = await open()
    expect(await ui.find({ type: 'Text', text: /×3 /, in: 'graph' })).toBeDefined()

    state.id = 's2'
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(300)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /×0 /, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /×3 /, in: 'graph' })).toBeUndefined()

    await $.tool.call({ tool: 'Grep', command: 'x' } as never)
    await clock.advance(300)
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /×1 /, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })

  test('a resume starts over from the resumed session’s history', async ($, on) => {
    const { clock, state, open } = engine($, on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Read', command: 'x' } as never)
    await clock.advance(300)

    state.history['s2:main'] = [
      row({ role: 'user', text: 'pick up where we left off' }),
      row({ toolUses: [{ tool_use_id: 'u1', tool: 'Agent', input: { subagent_type: 'Explore', description: 'old survey' }, agentId: 'a1', result: {} }] }),
    ]
    state.history['s2:a1'] = [row({ toolUses: [{ tool_use_id: 'u2', tool: 'Grep', input: {}, result: {} }] })]
    state.id = 's2'
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } })
    await clock.advance(300)
    const ui = await open()
    expect(await ui.find({ type: 'Text', text: /old survey/, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 agents · /, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })
})

describe('reload', () => {
  test('a pinned card is kept in session state, which outlives a reload', async ($, on) => {
    const { writes, open } = engine($, on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await open()
    await ui.post({ intents: [{ type: 'pin', id: MAIN, x: 7, y: 3 }] })
    // An atom is stored under its shape tag, so a reload's code reads it back only when the shape matches.
    const saved = writes.filter(w => w.key === 'ui').at(-1)?.value as { shape: string; value: { pinned: Record<string, unknown> } }
    expect(saved.shape).toBe('ui-1')
    expect(saved.value.pinned).toEqual({ [MAIN]: { x: 7, y: 3 } })
    await ui.unmount()
  })

  test('a call in flight across a reload closes when its agent’s turn ends', async () => {
    const store = { meta: undefined as LogMeta | undefined, chunks: new Map<number, Fact[]>() }
    const port: LogPort = {
      readMeta: async () => store.meta,
      writeMeta: async m => void (store.meta = m),
      readChunk: async i => store.chunks.get(i),
      writeChunk: async (i, f) => void store.chunks.set(i, JSON.parse(JSON.stringify(f))),
      after: () => {},
    }
    const s = new Session()
    s.facts.push({ kind: 'agent', agent: MAIN, agentKind: 'main' })
    const agent = s.spawn({ subagentType: 'Explore', description: 'look' })
    s.open(agent, 'Bash')
    const before = new FactLog()
    await before.load(port, 's1')
    before.append(port, s.facts)
    await before.flush(port)

    // The module starts over; the log comes back from session state.
    const after = new FactLog()
    await after.load(port, 's1')
    expect(runsOf(foldAll(after.facts)).find(r => r.agent === agent)?.state).toBe('run')
    s.facts = []
    s.finish(agent)
    after.append(port, s.facts)
    expect(runsOf(foldAll(after.facts)).find(r => r.agent === agent)?.state).toBe('unknown')
  })
})
