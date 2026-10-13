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
    expect(d.get('main')?.tokens).toBe(120)
  })
})

describe('groups', () => {
  test('an empty group is running; a late child reverts its done', () => {
    const s = new Session()
    s.call(undefined, 'Workflow', false, { runId: 'r', workflowName: 'w' })
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('running')
    const a = s.spawn({ workflow: { runId: 'r', agentIndex: 0 } })
    s.finish(a)
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('done')
    s.spawn({ workflow: { runId: 'r', agentIndex: 1 } })
    expect(byId(s.numbered()).get('wf:r')?.status).toBe('running')
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
