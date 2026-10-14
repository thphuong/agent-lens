import { describe, expect, test } from 'claude-code/testing'

import type { Fact } from '../hooks/model/facts'
import { apply, derive, foldAll, type SessionModel } from '../hooks/model/fold'
import { runsOf } from '../hooks/model/runs'
import { reference, rng, Session } from './fixtures/generate'

/** The model as sorted plain data, so two folds compare by value. */
const canonical = (m: SessionModel) => {
  const sortObj = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortObj)
    if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)).map(([k, x]) => [k, sortObj(x)])
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, x]) => [k, k === 'endedSeqs' ? [...(x as number[])].sort((p, q) => p - q) : sortObj(x)]),
      )
    return v
  }
  return JSON.stringify({ model: sortObj(m), derived: derive(m), runs: runsOf(m) })
}

const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
  const r = rng(seed)
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const byId = (facts: Fact[]) => new Map(derive(foldAll(facts)).map(d => [d.id, d]))

describe('fold', () => {
  test('the model depends only on the set of facts (200 shuffles)', () => {
    const facts = reference().numbered()
    const want = canonical(foldAll(facts))
    for (let seed = 1; seed <= 200; seed++) expect(canonical(foldAll(shuffle(facts, seed)))).toBe(want)
  })

  test('re-applying a fact changes nothing', () => {
    const facts = reference().numbered()
    const m = foldAll(facts)
    const want = canonical(m)
    for (const f of facts) apply(m, f)
    expect(canonical(m)).toBe(want)
  })

  test('a toolEnd before its toolStart still resolves', () => {
    const facts: Fact[] = [
      { seq: 2, agent: 'main', kind: 'toolEnd', call: 'c', outcome: 'err' },
      { seq: 1, agent: 'main', kind: 'toolStart', call: 'c', tool: 'Bash' },
    ]
    const runs = runsOf(foldAll(facts))
    expect(runs).toEqual([expect.objectContaining({ tool: 'Bash', count: 1, state: 'err' })])
  })

  test('the reference session derives subagents, a group and its rollup', () => {
    const d = byId(reference().numbered())
    expect(d.get('main')?.kind).toBe('main')
    const group = d.get('wf:run1')!
    expect(group.label).toBe('fake-review')
    expect(group.status).toBe('failed')
    const children = [...d.values()].filter(a => a.parent === 'wf:run1')
    expect(children).toHaveLength(3)
    const explorer = [...d.values()].find(a => a.label === 'scan again' || a.label === 'scan files')!
    expect([...d.values()].some(a => a.parent === explorer.id && a.label === 'nested look')).toBe(true)
    expect(d.get('main')?.tok).toBe(120)
  })
})

describe('usage', () => {
  const step = (seq: number, key: string, at: number | undefined, input: number, cacheRead = 0, agent = 'main'): Fact => ({
    seq,
    at,
    agent,
    kind: 'usage',
    key,
    input,
    output: 10,
    cacheRead,
    cacheWrite: 5,
  })

  test('ctx is the last call’s context, tok the sum of every call, in any order', () => {
    const facts: Fact[] = [step(1, 'step:t:0', 100, 1000, 0), step(2, 'step:t:1', 200, 200, 3000)]
    for (let seed = 0; seed <= 30; seed++) {
      const main = byId(seed === 0 ? facts : shuffle(facts, seed)).get('main')!
      expect(main.ctx).toBe(200 + 3000 + 5)
      expect(main.tok).toBe(1000 + 10 + 5 + 200 + 10 + 3000 + 5)
      expect(main.cacheRead).toBe(3000)
      expect(main.inputAll).toBe(1005 + 3205)
    }
  })

  test('a dated call is newer than an undated one whatever its seq', () => {
    const main = byId([step(5, 'req:old', undefined, 9000), step(1, 'step:t:0', 100, 40)]).get('main')!
    expect(main.ctx).toBe(45)
  })

  test('a legacy turn total counts only for an agent with no calls', () => {
    const legacy: Fact = { seq: 1, agent: 'main', kind: 'tokens', n: 777, turn: 't0' }
    expect(byId([legacy]).get('main')?.tok).toBe(777)
    expect(byId([legacy, step(2, 'step:t:0', 100, 40)]).get('main')?.tok).toBe(55)
  })

  test('a group rolls up tok and cache from its children and has no ctx', () => {
    const facts: Fact[] = [
      { seq: 1, agent: 'wf:r', kind: 'agent', agentKind: 'group' },
      { seq: 2, agent: 'a', kind: 'agent', agentKind: 'sub' },
      { seq: 3, agent: 'a', kind: 'spawn', parent: 'wf:r' },
      { seq: 4, agent: 'b', kind: 'agent', agentKind: 'sub' },
      { seq: 5, agent: 'b', kind: 'spawn', parent: 'wf:r' },
      step(6, 'step:x:0', 100, 100, 900, 'a'),
      step(7, 'step:y:0', 100, 100, 0, 'b'),
    ]
    const group = byId(facts).get('wf:r')!
    expect(group.ctx).toBe(0)
    expect(group.tok).toBe(1015 + 115)
    expect(group.cacheRead).toBe(900)
    expect(group.inputAll).toBe(1005 + 105)
  })
})

describe('groups', () => {
  test('an empty group runs while main does; a late child reverts its done', () => {
    const s = new Session()
    s.start()
    s.call(undefined, 'Workflow', false, { runId: 'r', workflowName: 'w' })
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('running')
    const a = s.spawn({ workflow: { runId: 'r', agentIndex: 0 } })
    s.finish(a)
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('done')
    s.spawn({ workflow: { runId: 'r', agentIndex: 1 } })
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('running')
  })

  test('an empty group is idle once main is, as after a resume without its agents', () => {
    const s = new Session()
    s.start()
    s.call(undefined, 'Workflow', false, { runId: 'r', workflowName: 'w' })
    s.finish(undefined)
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('idle')
  })
})

describe('lifecycle', () => {
  const each = (facts: Fact[], check: (d: Map<string, ReturnType<typeof derive>[number]>) => void) => {
    check(byId(facts))
    for (let seed = 1; seed <= 30; seed++) check(byId(shuffle(facts, seed)))
  }

  test('end, reopen, end resolves the same in any arrival order', () => {
    const s = new Session()
    const a = s.spawn({})
    s.finish(a)
    s.spawn({ resume: { agentId: a } })
    each(s.numbered(), d => expect(d.get(a)?.status).toBe('running'))
    s.finish(a, 'aborted')
    each(s.numbered(), d => expect(d.get(a)?.status).toBe('stopped'))
  })

  test('an agent keeps its first end, even after a resume ends it again', () => {
    const s = new Session()
    const a = s.spawn({})
    expect(byId(s.numbered()).get(a)?.endedSeq).toBeUndefined()
    s.finish(a)
    const first = byId(s.numbered()).get(a)!.endedSeq!
    expect(first).toBeGreaterThan(byId(s.numbered()).get(a)!.firstSeq)
    s.spawn({ resume: { agentId: a } })
    s.finish(a)
    each(s.numbered(), d => expect(d.get(a)?.endedSeq).toBe(first))
  })

  test('a workflow running its steps one after another is one wave with what main spawns meanwhile', () => {
    const s = new Session()
    const step = (i: number) => s.spawn({ workflow: { runId: 'run1', agentIndex: i } })
    s.finish(step(0))
    const second = step(1)
    const meanwhile = s.spawn({})
    s.finish(second)
    s.finish(meanwhile)
    const after = s.spawn({})
    each(s.numbered(), d => expect(['wf:run1', meanwhile, after].map(id => d.get(id)?.wave)).toEqual([0, 0, 1]))
  })

  test('siblings that overlap share a wave; one spawned after the wave ended starts the next', () => {
    const s = new Session()
    const a = s.spawn({})
    const b = s.spawn({})
    s.finish(a)
    const c = s.spawn({})
    const nested = s.spawn({ parentAgentId: c })
    s.finish(b)
    s.finish(c)
    s.finish(nested)
    const d = s.spawn({})
    s.spawn({ resume: { agentId: a } })
    each(s.numbered(), m => {
      expect([a, b, c, d].map(id => m.get(id)?.wave)).toEqual([0, 0, 0, 1])
      expect(m.get(nested)?.wave).toBe(0)
    })
  })

  test('a teammate wakes after going idle', () => {
    const s = new Session()
    const mate = s.spawn({ isTeammate: true })
    s.finish(mate)
    s.wake(mate)
    each(s.numbered(), d => expect(d.get(mate)?.status).toBe('running'))
  })

  test('a call in flight is closed by its agent ending', () => {
    const s = new Session()
    const a = s.spawn({})
    s.open(a, 'Bash')
    each(s.numbered(), d => expect(d.get(a)).toMatchObject({ status: 'running', tool: 'Bash' }))
    s.finish(a)
    each(s.numbered(), d => expect(d.get(a)).toMatchObject({ status: 'done', tool: undefined }))
    expect(runsOf(foldAll(s.numbered()))[0]?.state).toBe('unknown')
  })

  test('main is running from its turn start to its end; a command alone leaves it idle', () => {
    const s = new Session()
    s.prompt('/viz')
    expect(byId(s.numbered()).get('main')?.status).toBe('idle')
    s.start()
    expect(byId(s.numbered()).get('main')?.status).toBe('running')
    s.finish(undefined)
    expect(byId(s.numbered()).get('main')?.status).toBe('idle')
  })
})

describe('engine forks and runs', () => {
  test('an id seen only on tool calls is hidden', () => {
    const facts: Fact[] = [
      { seq: 1, agent: 'main', kind: 'agent', agentKind: 'main' },
      { seq: 2, agent: 'fork9', kind: 'toolStart', call: 'c', tool: 'Read' },
    ]
    expect(derive(foldAll(facts)).map(d => d.id)).toEqual(['main'])
  })

  test('consecutive same-tool calls form one run; a gap or another tool splits', () => {
    const s = new Session()
    s.call(undefined, 'Read')
    s.call(undefined, 'Read')
    s.call(undefined, 'Grep')
    s.tick(5000)
    s.call(undefined, 'Grep')
    const runs = runsOf(foldAll(s.numbered()))
    expect(runs.map(r => [r.tool, r.count])).toEqual([
      ['Read', 2],
      ['Grep', 1],
      ['Grep', 1],
    ])
    expect(runs[0]?.key).toBe(`main:${runs[0]?.firstSeq}`)
  })

  test('undated calls group by adjacency', () => {
    const facts: Fact[] = [1, 2, 3].map(i => ({ seq: i, agent: 'main', kind: 'toolStart' as const, call: `c${i}`, tool: 'Read' }))
    expect(runsOf(foldAll(facts))).toEqual([expect.objectContaining({ count: 3, state: 'run' })])
  })
})
