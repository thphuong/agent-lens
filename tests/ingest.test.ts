import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { agentSpawned, backfill, HISTORY_ROWS, promptLine, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted, usageStep } from '../hooks/ingest'
import type { Fact, NewFact } from '../hooks/model/facts'
import { derive, foldAll } from '../hooks/model/fold'
import { FactLog, type LogPort } from '../hooks/persist'
import type { LogMeta } from '../types'
import { cellText, cellWidth } from '../hooks/text'
import { reference } from './fixtures/generate'

describe('cellText', () => {
  test('strips escape sequences and controls', () => {
    expect(cellText('a\x1b[2Jb\x1b]0;title\x07c', 20)).toBe('abc')
    expect(cellText('one\rtwo\nthree\tfour', 40)).toBe('one two three four')
    expect(cellText('x\x00\x07\x7f\x9by', 10)).toBe('xy')
  })

  test('removes bidi controls and joiners', () => {
    expect(cellText('abc\u202edef', 10)).toBe('abcdef')
    expect(cellText('\u{1F468}\u200d\u{1F469}', 10)).not.toContain('\u200d')
  })

  test('counts wide cells and cuts on grapheme boundaries', () => {
    expect(cellWidth('漢字')).toBe(4)
    expect(cellText('漢字漢字', 5)).toBe('漢字…')
    expect(cellWidth(cellText('漢字漢字', 5))).toBeLessThanOrEqual(5)
    expect(cellText('abcdef', 4)).toBe('abc…')
    expect(cellText('abcd', 4)).toBe('abcd')
  })

  test('drops a split surrogate', () => {
    expect(cellText('a\uD83Db', 10)).toBe('ab')
  })
})

describe('translators', () => {
  test('tool.call gives toolStart, then toolEnd with the outcome', () => {
    const e = { tool_use_id: 'c1', tool: 'Bash', agentId: 'a1' }
    expect(toolStarted(e, 5)).toEqual([{ kind: 'toolStart', at: 5, agent: 'a1', call: 'c1', tool: 'Bash' }])
    expect(toolEnded(e, { result: {} } as never, 6)[0]).toMatchObject({ kind: 'toolEnd', outcome: 'ok' })
    expect(toolEnded(e, { deny: 'no' } as never, 6)[0]).toMatchObject({ outcome: 'err' })
    expect(toolEnded({ ...e, agentId: undefined }, { isError: true } as never, 6)[0]).toMatchObject({ agent: 'main', outcome: 'err' })
  })

  test('a Workflow result makes a group under the caller', () => {
    const facts = toolEnded({ tool_use_id: 'c', tool: 'Workflow' }, { result: { runId: 'r9', workflowName: 'rev' } } as never, 1)
    expect(facts).toContainEqual({ kind: 'agent', at: 1, agent: 'wf:r9', agentKind: 'group' })
    expect(facts).toContainEqual({ kind: 'spawn', at: 1, agent: 'wf:r9', parent: 'main' })
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'label', agent: 'wf:r9', text: 'rev' }))
  })

  test('agent.spawn gives agent, spawn, label and model', () => {
    const e = { tool_use_id: 't', prompt: 'secret body', description: 'look', subagentType: 'Explore', parentAgentId: 'p1' } as never
    const facts = agentSpawned(e, { model: 'm', agentId: 'a2' }, 3)
    expect(facts.map(f => f.kind)).toEqual(['agent', 'spawn', 'label', 'model'])
    expect(facts[1]).toMatchObject({ parent: 'p1' })
    expect(JSON.stringify(facts)).not.toContain('secret body')
  })

  test('a workflow spawn parents to its group, a resume reopens', () => {
    const wf = agentSpawned({ description: 'd', subagentType: 's', workflow: { runId: 'r1', agentIndex: 0 } } as never, { model: 'm', agentId: 'w' }, 1)
    expect(wf).toContainEqual({ kind: 'spawn', at: 1, agent: 'w', parent: 'wf:r1' })
    const re = agentSpawned({ description: 'd', subagentType: 's', resume: { agentId: 'old' } } as never, { model: 'm', agentId: 'old' }, 2)
    expect(re).toContainEqual(expect.objectContaining({ kind: 'reopened', agent: 'old' }))
    expect(agentSpawned({ description: 'd', subagentType: 's' } as never, { deny: 'x' }, 1)).toEqual([])
  })

  test('turns: a subagent start reopens, a completion ends it and keeps its model', () => {
    expect(turnStarted({ text: '', turnId: 't1', agentId: 'a' }, 1)).toEqual([{ kind: 'reopened', at: 1, agent: 'a', turn: 't1' }])
    expect(turnStarted({ text: '', turnId: 't1' }, 1)).toEqual([{ kind: 'reopened', at: 1, agent: 'main', turn: 't1' }])
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' }
    const done = turnCompleted({ turnId: 't', agentId: 'a', reason: 'aborted', usage } as never, 2)
    expect(done).toContainEqual(expect.objectContaining({ kind: 'model', model: 'm' }))
    expect(done).toContainEqual(expect.objectContaining({ kind: 'ended', status: 'stopped' }))
    // The turn's usage sums its steps', which are counted on their own.
    expect(done.some(f => f.kind === 'tokens' || f.kind === 'usage')).toBe(false)
    const main = turnCompleted({ turnId: 't', reason: 'answer', usage } as never, 2)
    expect(main).toContainEqual(expect.objectContaining({ kind: 'ended', agent: 'main', status: 'done' }))
  })

  test('a step gives one usage fact keyed by its turn and position', () => {
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' }
    expect(usageStep({ turnId: 't', index: 2, agentId: 'a' }, usage, 5)).toEqual([
      { kind: 'usage', at: 5, agent: 'a', key: 'step:t:2', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    ])
  })

  test('prompts keep a sanitised first line, commands their name only', () => {
    expect(promptSubmitted({ text: 'hidden', isMeta: true }, 1)).toEqual([])
    expect(promptSubmitted({ text: '/deploy prod --force', command: { name: 'deploy', args: 'prod --force' } }, 1)[0]).toMatchObject({ line: '/deploy' })
    expect(promptLine('\n  first line\nsecond')).toBe('first line')
    expect(promptLine('x'.repeat(200))?.length).toBe(80)
    expect(promptLine('<system-reminder>x</system-reminder>')).toBeUndefined()
    expect(promptLine('<command-name>/clear</command-name>')).toBe('/clear')
  })

  test('the reference session holds only allowlisted fields', () => {
    const allowed = new Set(['kind', 'at', 'agent', 'agentKind', 'parent', 'text', 'type', 'model', 'line', 'turn', 'call', 'tool', 'outcome', 'status', 'key', 'input', 'output', 'cacheRead', 'cacheWrite'])
    for (const f of reference().facts) for (const k of Object.keys(f)) expect(allowed.has(k)).toBe(true)
  })
})

const memoryPort = () => {
  const store = { meta: undefined as LogMeta | undefined, chunks: new Map<number, Fact[]>() }
  const port: LogPort = {
    readMeta: async () => store.meta,
    writeMeta: async m => void (store.meta = m),
    readChunk: async i => store.chunks.get(i),
    writeChunk: async (i, f) => void store.chunks.set(i, JSON.parse(JSON.stringify(f))),
    after: () => {},
  }
  return { store, port }
}

describe('fact log', () => {
  test('a dated fact replaces an undated duplicate, keeping its seq', () => {
    const { port } = memoryPort()
    const log = new FactLog()
    log.append(port, [{ kind: 'toolStart', agent: 'main', call: 'c', tool: 'Read' }])
    const changed = log.append(port, [{ kind: 'toolStart', at: 9, agent: 'main', call: 'c', tool: 'Read' }])
    expect(changed).toHaveLength(1)
    expect(log.facts).toEqual([{ kind: 'toolStart', at: 9, agent: 'main', call: 'c', tool: 'Read', seq: 1 }])
    expect(log.append(port, [{ kind: 'toolStart', agent: 'main', call: 'c', tool: 'Read' }])).toEqual([])
  })

  test('switching back to an earlier model shows it again, and replay before the switch shows the one between', () => {
    const { port } = memoryPort()
    const log = new FactLog()
    // A fact kept before model facts carried their turn.
    log.append(port, [{ kind: 'model', at: 1, agent: 'main', model: 'model-a' }])
    const usage = (model: string) => ({ input_tokens: 1, output_tokens: 1, model })
    for (const [turn, model] of [['t1', 'model-a'], ['t2', 'model-b'], ['t3', 'model-a']] as const) {
      log.append(port, turnCompleted({ turnId: turn, reason: 'answer', usage: usage(model) } as never, 2))
    }
    const main = (upTo?: number) => derive(foldAll(log.facts, upTo)).find(d => d.id === 'main')?.model
    expect(main()).toBe('model-a')
    const switchBack = log.facts.findIndex(f => f.kind === 'model' && f.turn === 't3')
    expect(main(switchBack)).toBe('model-b')
  })

  test('a reload restores the log with usage, parents and groups intact', async () => {
    const { port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1', 0)
    log.append(port, reference().facts)
    await log.flush(port)
    const again = new FactLog()
    await again.load(port, 's1', 0)
    expect(again.facts).toEqual(log.facts)
    expect(again.facts.some(f => f.kind === 'usage')).toBe(true)
    expect(again.facts.some(f => f.kind === 'spawn' && f.parent === 'wf:run1')).toBe(true)
    expect(again.append(port, [{ kind: 'truncated', agent: 'x' }])[0]?.seq).toBe(log.facts.length + 1)
  })

  test('a reload keeps when the log began and whether it was imported', async () => {
    const { port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1', 1000)
    expect(log).toMatchObject({ liveSince: 1000, imported: false })
    log.markImported(port)
    await log.flush(port)
    const again = new FactLog()
    await again.load(port, 's1', 9000)
    expect(again).toMatchObject({ liveSince: 1000, imported: true })
    again.reset(port, 's2', 9000)
    expect(again).toMatchObject({ liveSince: 9000, imported: false })
  })

  test('a log kept before it recorded its start loads as not imported, live from now', async () => {
    const { store, port } = memoryPort()
    store.meta = { sessionId: 's1', chunks: 0, seq: 0 }
    const log = new FactLog()
    await log.load(port, 's1', 5000)
    expect(log).toMatchObject({ liveSince: 5000, imported: false })
  })

  test('after an adopt only the facts seen live are persisted, and a load restores no history', async () => {
    const { store, port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1', 0)
    const history: NewFact[] = [{ kind: 'agent', agent: 'main', agentKind: 'main' }]
    for (let i = 0; i < 1200; i++) history.push({ kind: 'toolStart', at: 100 + i, agent: 'main', call: `h${i}`, tool: 'Read' })
    log.append(port, [
      { kind: 'agent', agent: 'main', agentKind: 'main' },
      { kind: 'toolStart', at: 50, agent: 'main', call: 'early', tool: 'Grep' },
      { kind: 'toolStart', at: 5000, agent: 'main', call: 'live', tool: 'Bash' },
    ])
    log.adopt(port, history, 4000)
    expect(log.facts.map(f => f.seq)).toEqual(log.facts.map((_, i) => i + 1))
    // The undated fact and the one dated before the cutoff gave way to the history.
    expect(log.facts.some(f => f.kind === 'toolStart' && f.call === 'early')).toBe(false)
    expect(log.facts.at(-1)).toMatchObject({ call: 'live', seq: 1202 })
    await log.flush(port)
    expect(store.meta).toMatchObject({ chunks: 1, liveSince: 4000 })
    expect(store.chunks.get(0)).toEqual([log.facts.at(-1)])
    log.append(port, [{ kind: 'toolEnd', at: 5100, agent: 'main', call: 'live', outcome: 'ok' }])
    await log.flush(port)
    expect(store.chunks.get(0)?.map(f => f.seq)).toEqual([1202, 1203])
    const again = new FactLog()
    await again.load(port, 's1', 9000)
    expect(again.facts).toEqual(log.facts.slice(-2))
    // A history read again replaces the old one rather than adding to it.
    log.adopt(port, history, 4000)
    expect(log.facts).toHaveLength(1203)
  })

  test('a log kept with its import in its chunks loads that part as history and stops persisting it', async () => {
    const { store, port } = memoryPort()
    const facts: Fact[] = [
      { kind: 'agent', agent: 'main', agentKind: 'main', seq: 1 },
      ...Array.from({ length: 1200 }, (_, i): Fact => ({ kind: 'toolStart', at: 100 + i, agent: 'main', call: `h${i}`, tool: 'Read', seq: i + 2 })),
      { kind: 'toolStart', at: 5000, agent: 'main', call: 'live', tool: 'Bash', seq: 1202 },
    ]
    for (let i = 0; i * 500 < facts.length; i++) store.chunks.set(i, facts.slice(i * 500, (i + 1) * 500))
    store.meta = { sessionId: 's1', chunks: 3, seq: 1202, liveSince: 4000, imported: true }
    const log = new FactLog()
    await log.load(port, 's1', 9000)
    expect(log.facts).toHaveLength(1202)
    await log.flush(port)
    expect(store.meta.chunks).toBe(1)
    expect(store.chunks.get(0)?.map(f => f.seq)).toEqual([1, 1202])
    // The chunks the history filled are emptied, so session state no longer holds it.
    expect([store.chunks.get(1), store.chunks.get(2)]).toEqual([[], []])
    const again = new FactLog()
    await again.load(port, 's1', 9000)
    expect(again.facts.map(f => f.seq)).toEqual([1, 1202])
  })

  test('a log kept for another session is dropped, and reset empties it', async () => {
    const { store, port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1', 0)
    log.append(port, reference().facts)
    await log.flush(port)
    const other = new FactLog()
    await other.load(port, 's2', 0)
    expect(other.facts).toEqual([])
    // The other session's chunks are emptied, so they no longer take up session state.
    await other.flush(port)
    expect([...store.chunks.values()].every(c => c.length === 0)).toBe(true)
    log.reset(port, 's3', 0)
    await log.flush(port)
    const after = new FactLog()
    await after.load(port, 's3', 0)
    expect(after.facts).toEqual([])
  })
})

describe('backfill', () => {
  const row = (over: Partial<SessionMessage>): SessionMessage => ({ role: 'assistant', text: '', toolUses: [], ...over })

  test('recurses through Agent calls even when no agent is listed', async () => {
    const rows: Record<string, SessionMessage[]> = {
      main: [
        row({ role: 'user', text: 'find things' }),
        row({ toolUses: [{ tool_use_id: 'u1', tool: 'Agent', input: { subagent_type: 'Explore', description: 'look' }, agentId: 'a1', result: {} }] }),
      ],
      a1: [row({ toolUses: [{ tool_use_id: 'u2', tool: 'Grep', input: {}, result: {} }, { tool_use_id: 'u3', tool: 'Read', input: {} }] })],
    }
    const facts = await backfill({ messages: async id => rows[id ?? 'main']!, agents: async () => [] }, true)
    expect(facts).toContainEqual({ kind: 'prompt', agent: 'main', line: 'find things' })
    expect(facts).toContainEqual({ kind: 'spawn', agent: 'a1', parent: 'main' })
    expect(facts).toContainEqual({ kind: 'toolStart', agent: 'a1', call: 'u2', tool: 'Grep' })
    expect(facts).toContainEqual({ kind: 'toolEnd', agent: 'a1', call: 'u2', outcome: 'ok' })
    expect(facts.some(f => f.kind === 'toolEnd' && f.call === 'u3')).toBe(false)
    expect(facts.every(f => f.at === undefined)).toBe(true)
  })

  test('a denied transcript leaves a placeholder, a full history is truncated', async () => {
    const big = Array.from({ length: HISTORY_ROWS }, () => row({}))
    big.push(row({ toolUses: [{ tool_use_id: 'u', tool: 'Agent', input: {}, agentId: 'wf1' }] }))
    const facts: NewFact[] = await backfill(
      { messages: async id => (id === undefined ? big : { deny: 'workflow run' }), agents: async () => [] },
      true,
    )
    expect(facts).toContainEqual({ kind: 'truncated', agent: 'main' })
    expect(facts).toContainEqual({ kind: 'agent', agent: 'wf1', agentKind: 'sub' })
    expect(facts.some(f => f.agent === 'wf1' && f.kind === 'toolStart')).toBe(false)
  })
})

describe('hooks', () => {
  test('an observer returns exactly the result next resolved, even when ingest fails', async ($, on) => {
    const answer = { result: { stdout: 'x' } }
    on('tool.call', () => answer)
    on('session.id', () => {
      throw new Error('no id')
    })
    const got = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(got).toEqual(answer)
  })

  test('a turn.step observer passes every chunk and the result through, even when ingest fails', async ($, on) => {
    const result = {
      turnId: 't',
      index: 0,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' },
    }
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'h' } as never
      yield { kind: 'text', index: 0, text: 'i' } as never
      return result as never
    })
    on('session.id', () => {
      throw new Error('no id')
    })
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1 })
    const chunks: unknown[] = []
    // `for await` drops a generator's return value; step by hand to read it.
    let r = await stream.next()
    for (; !r.done; r = await stream.next()) chunks.push(r.value)
    expect(chunks).toHaveLength(2)
    expect(r.value).toEqual(result)
  })

  test('a turn.step result with usage is logged as one usage fact', async ($, on) => {
    const clock = mock.clock(on)
    const writes: { key: string; value: unknown }[] = []
    on('state.set', ($, e, next) => {
      writes.push({ key: e.key, value: e.value })
      return next(e)
    })
    on('session.id', () => ({ value: 's1' }))
    on('session.messages', () => ({ value: [] }))
    on('agent.list', () => ({ value: [] }))
    on('turn.step', async function* () {
      return {
        turnId: 't',
        index: 1,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' },
      } as never
    })
    const stream = $.turn.step({ turnId: 't', index: 1, model: 'm', messageCount: 1 })
    while (!(await stream.next()).done);
    await clock.advance(300)
    const chunk = writes.filter(w => w.key === 'logChunk').at(-1)?.value as Fact[]
    expect(chunk.filter(f => f.kind === 'usage')).toEqual([expect.objectContaining({ agent: 'main', key: 'step:t:1', cacheWrite: 4 })])
  })

  test('session.end with clear starts the log over for the new session', async ($, on) => {
    const clock = mock.clock(on)
    const writes: { key: string; id?: string; value: unknown }[] = []
    let id = 's1'
    on('state.set', ($, e, next) => {
      writes.push({ key: e.key, id: e.id, value: e.value })
      return next(e)
    })
    on('session.id', () => ({ value: id }))
    on('session.messages', () => ({ value: [] }))
    on('agent.list', () => ({ value: [] }))
    on('command.register', () => ({ value: { command: 'lens' } }))
    on('tool.call', () => ({ result: {} }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('session.end', (_, e) => ({ sessionId: e.sessionId }))
    const lastMeta = () => writes.filter(w => w.key === 'logMeta').at(-1)?.value
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(300)
    expect(lastMeta()).toMatchObject({ sessionId: 's1' })
    id = 's2'
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await clock.advance(300)
    expect(lastMeta()).toMatchObject({ sessionId: 's2', chunks: 1 })
    const chunk = writes.filter(w => w.key === 'logChunk' && w.id === '0').at(-1)?.value as Fact[]
    expect(chunk.some(f => f.kind === 'toolStart')).toBe(false)
  })
})
