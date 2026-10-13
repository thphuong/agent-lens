import { describe, expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { agentSpawned, backfill, HISTORY_ROWS, promptLine, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted } from '../hooks/ingest'
import type { Fact, NewFact } from '../hooks/model/facts'
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

  test('turns: a subagent start reopens, a completion ends it with tokens', () => {
    expect(turnStarted({ text: '', turnId: 't1', agentId: 'a' }, 1)).toEqual([{ kind: 'reopened', at: 1, agent: 'a', turn: 't1' }])
    expect(turnStarted({ text: '', turnId: 't1' }, 1)).toEqual([{ kind: 'reopened', at: 1, agent: 'main', turn: 't1' }])
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, model: 'm' }
    const done = turnCompleted({ turnId: 't', agentId: 'a', reason: 'aborted', usage } as never, 2)
    expect(done).toContainEqual(expect.objectContaining({ kind: 'tokens', n: 10 }))
    expect(done).toContainEqual(expect.objectContaining({ kind: 'ended', status: 'stopped' }))
    const main = turnCompleted({ turnId: 't', reason: 'answer', usage } as never, 2)
    expect(main).toContainEqual(expect.objectContaining({ kind: 'ended', agent: 'main', status: 'done' }))
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
    const allowed = new Set(['kind', 'at', 'agent', 'agentKind', 'parent', 'text', 'type', 'model', 'line', 'turn', 'call', 'tool', 'outcome', 'n', 'status'])
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

  test('a reload restores the log with tokens, parents and groups intact', async () => {
    const { port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1')
    log.append(port, reference().facts)
    await log.flush(port)
    const again = new FactLog()
    await again.load(port, 's1')
    expect(again.facts).toEqual(log.facts)
    expect(again.facts.some(f => f.kind === 'tokens')).toBe(true)
    expect(again.facts.some(f => f.kind === 'spawn' && f.parent === 'wf:run1')).toBe(true)
    expect(again.append(port, [{ kind: 'truncated', agent: 'x' }])[0]?.seq).toBe(log.facts.length + 1)
  })

  test('a log kept for another session is dropped, and reset empties it', async () => {
    const { port } = memoryPort()
    const log = new FactLog()
    await log.load(port, 's1')
    log.append(port, reference().facts)
    await log.flush(port)
    const other = new FactLog()
    await other.load(port, 's2')
    expect(other.facts).toEqual([])
    log.reset(port, 's3')
    await log.flush(port)
    const after = new FactLog()
    await after.load(port, 's3')
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
    on('command.register', () => ({ value: { command: 'viz' } }))
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
