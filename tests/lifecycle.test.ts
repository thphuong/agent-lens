import { describe, expect, mock, test, type TestBody } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { MAIN, type Fact } from '../hooks/model/facts'
import { foldAll } from '../hooks/model/fold'
import { runsOf } from '../hooks/model/runs'
import { FactLog, type LogPort } from '../hooks/persist'
import type { LogMeta, Props } from '../types'
import { Session } from './fixtures/generate'
import { TranscriptBuilder } from './fixtures/transcript'

const PROJECT = '/home/fake/.claude/projects/-fake-project'

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
  const state = { id: 's1', history: {} as Record<string, SessionMessage[]>, files: {} as Record<string, string>, gate: Promise.resolve(), toolCalls: 0 }
  const writes: { key: string; id?: string; value: unknown }[] = []
  const reads: string[] = []
  const logs: string[] = []
  on('state.set', (_, e, next) => {
    writes.push({ key: e.key, id: e.id, value: e.value })
    return next(e)
  })
  // A file system holding only `state.files`, under a fake home.
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/fake' : undefined }))
  const children = (dir: string) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(state.files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [name, ...rest] = path.slice(dir.length + 1).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    return names
  }
  on('fs.list', (_, e) => {
    const names = children(e.path)
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', (_, e) => ({ value: e.path in state.files || children(e.path).size > 0 }))
  on('fs.stat', (_, e) => {
    if (!(e.path in state.files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: state.files[e.path]!.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', async (_, e) => {
    reads.push(e.path)
    await state.gate
    if (!(e.path in state.files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: state.files[e.path]! }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: state.id }))
  on('session.messages', (_, e) => ({ value: state.history[`${state.id}:${e.agentId ?? MAIN}`] ?? [] }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'viz' } }))
  on('tool.call', () => {
    state.toolCalls += 1
    return { result: {} }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const open = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.resize({ columns: 87, rows: 32 })
    return ui
  }
  const viz = async () => {
    await $.command.run({ command: 'viz', args: '' } as never)
    await clock.advance(300)
  }
  /** What the pane is drawn from: the props its Client last received. */
  const view = async (ui: Awaited<ReturnType<typeof open>>) => {
    await ui.redraw()
    return ((await ui.find({ type: 'Client' }))!.props.props as Props).view
  }
  /** Narrates the fact just after the `n`th prompt, and its time. */
  const atPrompt = async (ui: Awaited<ReturnType<typeof open>>, n: number) => {
    const at = (await view(ui)).timeline.prompts[n]
    if (at === undefined) return undefined
    await ui.post({ intents: [{ type: 'seek', to: at + 1 }] })
    const { lastEvent, playheadAt } = (await view(ui)).timeline
    return { lastEvent, playheadAt }
  }
  /** The log as last persisted (its first chunk): the facts seen live. */
  const logged = () => writes.filter(w => w.key === 'logChunk' && w.id === '0').at(-1)?.value as Fact[]
  /** Writes a transcript's files for session `id` into the fake file system. */
  const transcript = (id: string, b: TranscriptBuilder) => {
    state.files[`${PROJECT}/${id}.jsonl`] = b.files.main.join('\n')
    for (const a of b.files.agents) {
      const dir = a.runId ? `${PROJECT}/${id}/subagents/workflows/${a.runId}` : `${PROJECT}/${id}/subagents`
      state.files[`${dir}/agent-${a.id}.jsonl`] = a.lines.join('\n')
      if (a.meta !== undefined) state.files[`${dir}/agent-${a.id}.meta.json`] = a.meta
    }
    for (const j of b.files.journals) state.files[`${PROJECT}/${id}/subagents/workflows/${j.runId}/journal.jsonl`] = j.lines.join('\n')
  }
  return { clock, state, writes, reads, logs, open, viz, view, atPrompt, logged, transcript }
}

describe('session end', () => {
  test('a /clear empties the graph, then shows the new session’s work', async ($, on) => {
    const { clock, state, open } = engine($, on)
    // The tool-call count shows in the info overlay, which a /clear closes.
    const calls = async (ui: Awaited<ReturnType<typeof open>>, n: number) => {
      await ui.post({ intents: [{ type: 'overlay', overlay: 'info' }] })
      await ui.redraw()
      return ui.find({ type: 'Text', text: new RegExp(`tool calls\\s+${n}\\b`), in: 'graph' })
    }
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Read', command: 'x' } as never)
    await clock.advance(300)
    const ui = await open()
    expect(await calls(ui, 3)).toBeDefined()

    state.id = 's2'
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(300)
    expect(await calls(ui, 0)).toBeDefined()

    await $.tool.call({ tool: 'Grep', command: 'x' } as never)
    await clock.advance(300)
    expect(await calls(ui, 1)).toBeDefined()
    await ui.unmount()
  })

  test('a resume starts over from the resumed session’s history', async ($, on) => {
    const { clock, state, open, viz } = engine($, on)
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
    // With no transcript to read, /viz backfills from the message history.
    await viz()
    const ui = await open()
    expect(await ui.find({ type: 'Text', text: /old survey/, in: 'graph' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 agents · /, in: 'graph' })).toBeDefined()
    await ui.unmount()
  })
})

/** A transcript recorded before this process: one prompt, a subagent, and usage, ending an hour ago. */
const earlier = () => {
  const b = new TranscriptBuilder()
  b.t = Date.now() - 3_600_000
  b.prompt('earlier fake prompt')
  b.request('main', [{ id: 'c1', tool: 'Agent', input: { description: 'old survey', subagent_type: 'explorer' } }])
  b.result('main', 'c1', { toolUseResult: { agentId: 'a1', status: 'completed' } })
  b.subagent('a1', { agentType: 'explorer', description: 'old survey', toolUseId: 'c1' })
  b.request('a1', [{ id: 'c2', tool: 'Grep' }])
  b.result('a1', 'c2')
  b.turnEnd()
  return b
}

describe('import', () => {
  test('/viz imports the transcript once, with times, and keeps it out of session state', async ($, on) => {
    const { reads, open, viz, view, atPrompt, logged, transcript } = engine($, on)
    const b = earlier()
    transcript('s1', b)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    const ui = await open()
    const agents = (await view(ui)).agents
    expect(agents.find(a => a.id === 'a1')).toMatchObject({ label: 'old survey', tok: b.tokens.get('a1') })
    expect(agents.find(a => a.id === MAIN)?.tok).toBe(b.tokens.get(MAIN))
    expect(await ui.find({ type: 'Text', text: /old survey/, in: 'graph' })).toBeDefined()
    expect(await atPrompt(ui, 0)).toEqual({ lastEvent: '◆ earlier fake prompt', playheadAt: expect.any(Number) })
    await ui.unmount()
    // History stays in memory: session state holds only what was seen live.
    expect((logged() ?? []).some(f => f.at !== undefined && f.at < Date.now() - 60_000)).toBe(false)

    const before = reads.length
    await viz()
    expect(reads.length).toBe(before)
    expect(reads.some(p => p.endsWith('/s1.jsonl'))).toBe(true)
  })

  test('what happened after the log began comes from live hooks only', async ($, on) => {
    const { viz, open, view, atPrompt, transcript } = engine($, on)
    const b = earlier()
    on('turn.step', async function* () {
      return {
        turnId: 't1',
        index: 0,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
      } as never
    })
    on('prompt.submit', (_, e) => ({ text: e.text }) as never)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    // Seen live, and also written to the transcript after the log began.
    await $.prompt.submit({ text: 'live fake prompt', turnId: 't1' } as never)
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
    while (!(await step.next()).done);
    const imported = b.tokens.get(MAIN)!
    b.t = Date.now() + 1000
    b.prompt('live fake prompt')
    b.request('main', [], { input: 5, output: 5 })
    transcript('s1', b)
    await viz()
    const ui = await open()
    expect((await view(ui)).timeline.prompts).toHaveLength(2)
    // The earlier request is imported; the live one is the step, not its transcript copy.
    expect((await view(ui)).agents.find(a => a.id === MAIN)?.tok).toBe(imported + 10)
    // Imported history replays before what was seen live.
    expect((await atPrompt(ui, 0))?.lastEvent).toBe('◆ earlier fake prompt')
    expect((await atPrompt(ui, 1))?.lastEvent).toBe('◆ live fake prompt')
    await ui.unmount()
  })

  test('with no transcript, /viz backfills from the message history and says why once', async ($, on) => {
    const { state, logs, viz, logged } = engine($, on)
    state.history['s1:main'] = [row({ role: 'user', text: 'backfilled fake prompt' })]
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    await viz()
    expect(logged().filter(f => f.kind === 'prompt')).toEqual([expect.objectContaining({ line: 'backfilled fake prompt' })])
    expect(logs.filter(l => l.includes('not the transcript'))).toHaveLength(1)
  })

  test('a reload of an imported log reads the transcript again, which covers what the module missed', async ($, on) => {
    const { clock, reads, viz, open, view, logged, transcript } = engine($, on)
    on('turn.step', async function* () {
      return {
        turnId: 't1',
        index: 0,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' },
      } as never
    })
    const b = earlier()
    transcript('s1', b)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    // A model call seen live, which the transcript also records.
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
    while (!(await step.next()).done);
    await clock.advance(300)
    b.t = Date.now() - 30_000
    b.request('main', [], { input: 5, output: 5 })
    // While the module was down, main launched a subagent and both made calls.
    b.request('main', [{ id: 'c9', tool: 'Agent', input: { description: 'missed look', subagent_type: 'explorer' } }], { input: 40 })
    b.result('main', 'c9', { toolUseResult: { agentId: 'a9', status: 'completed' } })
    b.subagent('a9', { agentType: 'explorer', description: 'missed look', toolUseId: 'c9' })
    b.request('a9', [{ id: 'c10', tool: 'Grep' }], { input: 70, read: 300 })
    b.result('a9', 'c10')
    // A call still streaming as the module comes back: its usage lands live, after the load.
    b.request('main', [], { input: 5, output: 5 }, 'model-a', true)
    transcript('s1', b)
    expect(logged().some(f => f.kind === 'usage' && f.key === 'step:t1:0')).toBe(true)

    const before = reads.filter(p => p.endsWith('/s1.jsonl')).length
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    expect(reads.filter(p => p.endsWith('/s1.jsonl')).length).toBe(before + 1)
    const late = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })
    while (!(await late.next()).done);
    await clock.advance(300)
    const ui = await open()
    const { agents } = await view(ui)
    for (const id of [MAIN, 'a1', 'a9']) expect(agents.find(a => a.id === id)?.tok).toBe(b.tokens.get(id))
    expect(agents.find(a => a.id === 'a9')).toMatchObject({ parent: MAIN, label: 'missed look' })
    // The calls made while the module was down are dated.
    await ui.post({ intents: [{ type: 'seek', to: (await view(ui)).timeline.spawns.at(-1)! + 1 }] })
    expect((await view(ui)).timeline).toMatchObject({ lastEvent: expect.stringMatching(/spawned$/), playheadAt: expect.any(Number) })
    await ui.unmount()
    // The live copy of the earlier call gave way to the transcript's; only the call seen after the load stays live.
    expect(logged().filter(f => f.kind === 'usage')).toEqual([expect.objectContaining({ key: 'step:t1:0' })])
  })

  test('a reload when the transcript can no longer be read keeps the facts seen live and backfills', async ($, on) => {
    const { clock, state, viz, open, view, logged, transcript } = engine($, on)
    transcript('s1', earlier())
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    await $.tool.call({ tool: 'Read', command: 'x' } as never)
    await clock.advance(300)
    state.files = {}
    state.history['s1:main'] = [
      row({ role: 'user', text: 'a prompt only the import had' }),
      row({ toolUses: [{ tool_use_id: 'u9', tool: 'Agent', input: { subagent_type: 'Explore', description: 'missed look' }, agentId: 'a9', result: {} }] }),
    ]
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await viz()
    const ui = await open()
    const { agents, timeline } = await view(ui)
    expect(agents.find(a => a.id === 'a9')?.label).toBe('missed look')
    expect(agents.find(a => a.id === MAIN)?.tools).toBeGreaterThanOrEqual(1)
    // Backfilled prompts have no turn to dedupe by, so a reload leaves them out.
    expect(timeline.prompts).toEqual([])
    expect(logged().some(f => f.kind === 'toolStart' && f.tool === 'Read')).toBe(true)
    await ui.unmount()
  })

  test('observer hooks pass straight through while an import is reading', async ($, on) => {
    const { state, viz, transcript } = engine($, on)
    let release = () => {}
    state.gate = new Promise(r => (release = r))
    transcript('s1', earlier())
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const opening = viz()
    expect(await $.tool.call({ tool: 'Bash', command: 'x' } as never)).toEqual({ result: {} })
    expect(state.toolCalls).toBe(1)
    release()
    await opening
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
    await before.load(port, 's1', 0)
    before.append(port, s.facts)
    await before.flush(port)

    // The module starts over; the log comes back from session state.
    const after = new FactLog()
    await after.load(port, 's1', 0)
    expect(runsOf(foldAll(after.facts)).find(r => r.agent === agent)?.state).toBe('run')
    s.facts = []
    s.finish(agent)
    after.append(port, s.facts)
    expect(runsOf(foldAll(after.facts)).find(r => r.agent === agent)?.state).toBe('unknown')
  })
})
