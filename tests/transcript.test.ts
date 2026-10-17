import { describe, expect, test } from 'claude-code/testing'

import type { Fact, NewFact } from '../hooks/model/facts'
import { derive, foldAll } from '../hooks/model/fold'
import { ordered } from '../hooks/model/timeline'
import { FactLog, type LogPort } from '../hooks/persist'
import { fileLines, READ_LIMIT, type FilePort } from '../hooks/transcript-io'
import { readTranscript, referenceTranscript, SECRETS, T0, TranscriptBuilder } from './fixtures/transcript'

const port: LogPort = { readMeta: async () => undefined, writeMeta: async () => {}, readChunk: async () => undefined, writeChunk: async () => {}, after: () => {} }

const logOf = (facts: readonly NewFact[]) => {
  const log = new FactLog()
  log.adopt(port, facts, Number.POSITIVE_INFINITY)
  return log
}

const derived = (facts: readonly NewFact[]) => new Map(derive(foldAll(logOf(facts).facts)).map(d => [d.id, d]))

describe('transcript', () => {
  test('the reference transcript folds to its agents, parents, groups, calls, prompts and tokens', () => {
    const { facts } = readTranscript(referenceTranscript().files)
    const d = derived(facts)
    expect(d.get('a1')).toMatchObject({ parent: 'main', label: 'scan files', type: 'explorer', status: 'done', tools: 2 })
    expect(d.get('a2')).toMatchObject({ parent: 'a1', label: 'nested look', status: 'failed', tools: 1 })
    expect(d.get('wf:wf_run1')).toMatchObject({ kind: 'group', parent: 'main', label: 'fake-review', status: 'failed' })
    expect(d.get('w1')).toMatchObject({ parent: 'wf:wf_run1', label: 'lens 0', status: 'done' })
    expect(d.get('w2')).toMatchObject({ parent: 'wf:wf_run1', status: 'failed' })
    const main = d.get('main')!
    expect(main).toMatchObject({ status: 'idle', tools: 3, model: 'model-a' })
    // Four requests: 1000+20+500, 10+20+1500, 100+20, 100+20.
    expect(main.tok).toBe(1520 + 1530 + 120 + 120)
    expect(main.ctx).toBe(100)
    expect(main.cacheRead).toBe(1500)
    const prompts = facts.filter(f => f.kind === 'prompt').map(f => (f as { line: string }).line)
    expect(prompts).toEqual(['map the fake repo', 'second fake prompt'])
    expect(facts.every(f => f.kind === 'agent' && f.agent === 'main' ? f.at === undefined : f.at !== undefined)).toBe(true)
  })

  test('a subagent whose files were cleaned up still shows from its launch and hand-back', () => {
    const b = referenceTranscript()
    b.files.agents = b.files.agents.filter(a => a.id !== 'a1' && a.id !== 'a2')
    const d = derived(readTranscript(b.files).facts)
    expect(d.get('a1')).toMatchObject({ parent: 'main', label: 'scan files', type: 'explorer', status: 'done', tools: 0 })
    // Its nested agent was launched inside its own, now missing, file.
    expect(d.has('a2')).toBe(false)
  })

  test('a background agent ends by a completion notice, queued or written as a user record', () => {
    const b = new TranscriptBuilder()
    for (const [call, id] of [['c1', 'q1'], ['c2', 'q2'], ['c3', 'q3']] as const) {
      b.request('main', [{ id: call, tool: 'Agent', input: { description: `look ${id}`, subagent_type: 'Explore' } }])
      b.result('main', call, { toolUseResult: { agentId: id, status: 'async_launched' } })
    }
    b.notification('q1', 'completed', 'attachment')
    b.notification('q2', 'failed', 'user')
    b.notification('q3', 'killed', 'attachment')
    // A notice about a task that is no agent, a shell say, adds nothing.
    b.notification('shell-task-1', 'completed', 'user')
    const { facts } = readTranscript(b.files)
    const d = derived(facts)
    expect([d.get('q1')?.status, d.get('q2')?.status, d.get('q3')?.status]).toEqual(['done', 'failed', 'stopped'])
    expect(d.has('shell-task-1')).toBe(false)
    expect(facts.some(f => f.kind === 'prompt')).toBe(false)
    expect(JSON.stringify(facts)).not.toContain('SECRET')
  })

  test('records at or after the cutoff produce no facts', () => {
    const b = referenceTranscript()
    const all = readTranscript(b.files).facts
    const cutoff = T0 + 10_000
    const { facts } = readTranscript(b.files, cutoff)
    expect(facts.length).toBeGreaterThan(1)
    expect(facts.length).toBeLessThan(all.length)
    expect(facts.every(f => f.at === undefined || f.at < cutoff)).toBe(true)
    // An agent started before the cutoff whose end came after it is left running for the live hooks.
    const d = derived(readTranscript(b.files, T0 + 9_000).facts)
    expect(d.get('a1')?.status).toBe('running')
    expect(d.has('w1')).toBe(false)
  })

  test('the records of one request make one usage fact', () => {
    const b = new TranscriptBuilder()
    b.request('main', [{ id: 'c', tool: 'Read' }])
    expect(b.files.main).toHaveLength(2)
    const usage = readTranscript(b.files).facts.filter(f => f.kind === 'usage')
    expect(usage).toEqual([expect.objectContaining({ key: 'req:req-1', input: 100, output: 20 })])
  })

  test('a request still being written at the cutoff is left to the live hooks', () => {
    const b = new TranscriptBuilder()
    b.request('main', [{ id: 'c', tool: 'Read' }])
    // The answer record lands before the cutoff, the tool-call record of the same request after it.
    const usage = readTranscript(b.files, T0 + 1500).facts.filter(f => f.kind === 'usage')
    expect(usage).toEqual([])
  })

  test('a request with no record saying it stopped is left to the live hooks', () => {
    const b = new TranscriptBuilder()
    b.request('main', [{ id: 'c', tool: 'Read' }], { input: 7 })
    b.request('main', [], { input: 300 }, 'model-a', true)
    const usage = readTranscript(b.files).facts.filter(f => f.kind === 'usage')
    expect(usage).toEqual([expect.objectContaining({ key: 'req:req-1', input: 7 })])
  })

  test('a transcript that never says why the model stopped counts every request', () => {
    const b = new TranscriptBuilder()
    b.request('main', [{ id: 'c', tool: 'Read' }])
    b.request('main', [])
    for (const lines of [b.files.main]) lines.forEach((l, i) => (lines[i] = l.replace(/,"stop_reason":(null|"[a-z_]+")/, '')))
    expect(readTranscript(b.files).facts.filter(f => f.kind === 'usage')).toHaveLength(2)
  })

  test('an interruption is not a prompt', () => {
    const b = new TranscriptBuilder()
    b.prompt('[Request interrupted by user]', undefined)
    b.prompt('an older fake prompt', undefined)
    const prompts = readTranscript(b.files).facts.filter(f => f.kind === 'prompt')
    expect(prompts).toEqual([expect.objectContaining({ line: 'an older fake prompt' })])
  })

  test('a session many times past the old 15,000-fact cap imports in full', () => {
    const b = referenceTranscript()
    for (let i = 0; i < 12_000; i++) {
      const agent = i % 3 === 0 ? 'a1' : 'main'
      b.request(agent, [{ id: `bulk${i}`, tool: 'Read' }], { input: 1 + (i % 7), output: i % 5, read: i % 11, write: i % 2 })
      b.result(agent, `bulk${i}`)
    }
    const { facts } = readTranscript(b.files)
    expect(facts.length).toBeGreaterThan(2 * 15_000)
    expect(facts.some(f => f.kind === 'truncated')).toBe(false)
    const d = derived(facts)
    for (const agent of ['main', 'a1', 'a2', 'w1', 'w2']) expect(d.get(agent)?.tok).toBe(b.tokens.get(agent))
    expect(d.get('main')?.tools).toBe(3 + 8000)
    expect(d.get('a2')).toMatchObject({ parent: 'a1', status: 'failed' })
    // The first prompt replays first of everything dated.
    const log = logOf(facts)
    expect(ordered(log.facts).find(f => f.at !== undefined)).toMatchObject({ kind: 'prompt', line: 'map the fake repo' })
  })

  test('each agent reports a model when it changes, so switching back shows it again', () => {
    const b = new TranscriptBuilder()
    for (let i = 0; i < 5; i++) b.request('main', [])
    for (let i = 0; i < 3; i++) b.request('main', [], {}, 'model-b')
    b.request('main', [])
    const models = readTranscript(b.files).facts.filter(f => f.kind === 'model')
    expect(models).toEqual([
      expect.objectContaining({ agent: 'main', model: 'model-a', at: T0 + 1000 }),
      expect.objectContaining({ agent: 'main', model: 'model-b' }),
      expect.objectContaining({ agent: 'main', model: 'model-a' }),
    ])
    expect(derived(readTranscript(b.files).facts).get('main')?.model).toBe('model-a')
  })

  test('each agent reports its effort when it changes, and none once a model takes none', () => {
    const b = new TranscriptBuilder()
    b.request('main', [], {}, 'model-a', false, 'medium')
    b.request('main', [], {}, 'model-a', false, 'medium')
    b.request('main', [], {}, 'model-a', false, 'high')
    b.subagent('a1', { agentType: 'fake' })
    b.request('a1', [], {}, 'model-a', false, 'low')
    const facts = readTranscript(b.files).facts
    expect(facts.filter(f => f.kind === 'effort').map(f => [f.agent, (f as { effort?: string }).effort])).toEqual([
      ['main', 'medium'],
      ['main', 'high'],
      ['a1', 'low'],
    ])
    expect(derived(facts).get('main')?.effort).toBe('high')
    b.request('main', [], {}, 'model-b')
    expect(derived(readTranscript(b.files).facts).get('main')?.effort).toBeUndefined()
  })

  test('malformed lines are skipped and counted, other record types passed over, never thrown', () => {
    const b = referenceTranscript()
    b.raw('main', 'not json')
    b.raw('main', '[1, 2]')
    b.subagent('x', { agentType: 'fake' })
    b.files.agents.at(-1)!.meta = '{broken'
    const r = readTranscript(b.files)
    // Three bad lines and the broken sidecar; record types the reader has no use for are not counted.
    expect(r.skipped).toBe(4)
    expect(r.records).toBeGreaterThan(0)
  })

  test('no fact carries a tool input, a tool output, an answer or a prompt body', () => {
    const text = JSON.stringify(readTranscript(referenceTranscript().files).facts)
    for (const s of SECRETS) expect(text).not.toContain(s)
  })

  test('importing the same transcript twice leaves the log as one import did', () => {
    const { facts } = readTranscript(referenceTranscript().files)
    const once = logOf(facts)
    const twice = logOf(facts)
    twice.adopt(port, readTranscript(referenceTranscript().files).facts, Number.POSITIVE_INFINITY)
    expect(twice.facts).toEqual(once.facts)
  })

  test('adopted history is numbered before the facts seen live', () => {
    const log = new FactLog()
    const live: NewFact[] = [
      { kind: 'agent', agent: 'main', agentKind: 'main' },
      { kind: 'ended', at: T0 + 500_000, agent: 'a1', status: 'done', turn: 't9' },
    ]
    log.append(port, live)
    log.adopt(port, readTranscript(referenceTranscript().files, T0 + 9_000).facts, T0 + 9_000)
    const seqs = log.facts.map((f: Fact) => f.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    const end = log.facts.find(f => f.kind === 'ended' && f.turn === 't9')!
    expect(end.seq).toBe(log.facts.length)
    // The live end is newest, so the subagent the transcript left running reads as done.
    expect(new Map(derive(foldAll(log.facts)).map(d => [d.id, d])).get('a1')?.status).toBe('done')
  })
})

describe('reading files', () => {
  const text = ['{"a":1}', '{"b":"two"}', '{"c":[3]}'].join('\n')
  const fake = (size: number, piece: number): FilePort & { streamed: boolean } => {
    const port = {
      streamed: false,
      list: async () => [],
      exists: async () => true,
      size: async () => size,
      read: async () => text,
      stream: async function* () {
        port.streamed = true
        for (let i = 0; i < text.length; i += piece) yield text.slice(i, i + piece)
      },
    }
    return port
  }
  const collect = async (port: FilePort) => {
    const out: string[] = []
    for await (const line of fileLines(port, 'f')) out.push(line)
    return out
  }

  test('a small file is read whole', async () => {
    const port = fake(text.length, 4)
    expect(await collect(port)).toEqual(text.split('\n'))
    expect(port.streamed).toBe(false)
  })

  test('a small file that fails to read, as when it grew past the limit, is streamed', async () => {
    const port = { ...fake(text.length, 2), read: async () => Promise.reject(new Error('over 4 MiB')) }
    port.stream = fake(text.length, 2).stream
    expect(await collect(port)).toEqual(text.split('\n'))
  })

  test('a file over the read limit is streamed, with lines rejoined across pieces', async () => {
    for (const piece of [1, 3, 5, 64]) {
      const port = fake(READ_LIMIT, piece)
      expect(await collect(port)).toEqual(text.split('\n'))
      expect(port.streamed).toBe(true)
    }
  })
})
