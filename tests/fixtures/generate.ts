// A seeded synthetic session: engine events with fake ids and tool names only,
// run through the real translators. Never captured from a real session.

import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'

import { agentSpawned, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted, usageStep } from '../../hooks/ingest'
import { MAIN, type Fact, type NewFact } from '../../hooks/model/facts'

/** A small deterministic PRNG (mulberry32). */
export const rng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const OK: ToolCallResult = { result: {} as never }
const ERR: ToolCallResult = { isError: true, result: undefined as never, text: 'failed' } as unknown as ToolCallResult

const spawnInput = (over: Partial<AgentSpawnInput>): AgentSpawnInput =>
  ({
    tool_use_id: '',
    prompt: 'do the thing',
    description: 'fake task',
    subagentType: 'fake-type',
    provider: { kind: 'engine' },
    parentModel: 'model-a',
    background: false,
    fork: false,
    ...over,
  }) as AgentSpawnInput

const USAGE = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'model-a' }

const turnDone = (agentId: string | undefined, turnId: string, reason: TurnCompleteInput['reason'] = 'answer') =>
  ({
    answer: '',
    durationMs: 10,
    isAborted: reason === 'aborted',
    turnId,
    agentId,
    reason,
    usage: USAGE,
  }) as unknown as TurnCompleteInput

/** A session builder that records facts as the hooks would, with a fake clock. */
export class Session {
  facts: NewFact[] = []
  private t = 1_000_000
  private n = 0

  tick(ms = 100) {
    this.t += ms
    return this.t
  }

  id(prefix: string) {
    this.n += 1
    return `${prefix}${this.n}`
  }

  prompt(text: string) {
    this.facts.push(...promptSubmitted({ text, turnId: this.id('turn') }, this.tick()))
  }

  call(agent: string | undefined, tool: string, failed = false, result?: unknown) {
    const e = { tool_use_id: this.id('call'), tool, agentId: agent }
    this.facts.push(...toolStarted(e, this.tick()))
    const r = failed ? ERR : result === undefined ? OK : ({ result } as ToolCallResult)
    this.facts.push(...toolEnded(e, r, this.tick()))
  }

  /** Starts a call and leaves it open. */
  open(agent: string | undefined, tool: string) {
    const e = { tool_use_id: this.id('call'), tool, agentId: agent }
    this.facts.push(...toolStarted(e, this.tick()))
    return e.tool_use_id
  }

  spawn(over: Partial<AgentSpawnInput>) {
    const agentId = over.resume?.agentId ?? this.id('agent')
    const r: AgentSpawnResult = { model: 'model-b', agentId }
    this.facts.push(...agentSpawned(spawnInput(over), r, this.tick()))
    return agentId
  }

  /** Main (or a subagent) starts a turn. */
  start(agentId?: string) {
    this.facts.push(...turnStarted({ text: '', turnId: this.id('turn'), agentId }, this.tick()))
  }

  wake(agentId: string) {
    this.facts.push(...turnStarted({ text: '', turnId: this.id('turn'), agentId }, this.tick()))
  }

  /** One model call's usage, as `turn.step` reports it. */
  step(agentId: string | undefined, turnId: string, index: number, usage: Partial<typeof USAGE> = {}) {
    this.facts.push(...usageStep({ turnId, index, agentId }, { ...USAGE, ...usage }, this.tick()))
  }

  /** Ends a turn of one model call. */
  finish(agentId: string | undefined, reason: TurnCompleteInput['reason'] = 'answer') {
    const turnId = this.id('turn')
    this.step(agentId, turnId, 0)
    this.facts.push(...turnCompleted(turnDone(agentId, turnId, reason), this.tick()))
  }

  /** The facts numbered in arrival order, as the log would hold them. */
  numbered(): Fact[] {
    return this.facts.map((f, i) => ({ ...f, seq: i + 1 }) as Fact)
  }
}

/**
 * The reference session: main, nested subagents, a workflow run of three
 * agents, an error call, a resumed subagent, a teammate wake and a /clear
 * prompt.
 */
export const reference = (): Session => {
  const s = new Session()
  s.facts.push({ kind: 'agent', agent: MAIN, agentKind: 'main' })
  s.prompt('map the fake repo\nwith more lines')
  s.start()
  s.call(undefined, 'Read')
  const explore = s.spawn({ subagentType: 'explorer', description: 'scan files' })
  s.call(explore, 'Grep')
  const nested = s.spawn({ subagentType: 'helper', description: 'nested look', parentAgentId: explore })
  s.call(nested, 'Bash', true)
  s.finish(nested)
  s.finish(explore)
  s.call(undefined, 'Workflow', false, { runId: 'run1', workflowName: 'fake-review', status: 'async_launched', taskId: 't1' })
  for (let i = 0; i < 3; i++) {
    const w = s.spawn({ subagentType: 'reviewer', description: `lens ${i}`, workflow: { runId: 'run1', agentIndex: i } })
    s.call(w, 'Read')
    s.finish(w, i === 2 ? 'error' : 'answer')
  }
  s.spawn({ subagentType: 'explorer', description: 'scan again', resume: { agentId: explore } })
  s.call(explore, 'Glob')
  s.finish(explore)
  const mate = s.spawn({ subagentType: 'teammate', description: 'pair', isTeammate: true })
  s.finish(mate)
  s.wake(mate)
  s.call(mate, 'Edit')
  s.finish(mate)
  s.finish(undefined)
  s.prompt('/clear')
  return s
}

/**
 * A large session: `agents` subagents sharing `calls` calls, for benchmarks
 * and budgets. With `batch`, agents finish in batches of that many as they
 * spawn, so siblings fall into many waves.
 */
export const large = (agents: number, calls: number, seed = 7, batch?: number): Session => {
  const r = rng(seed)
  const s = new Session()
  const tools = ['Read', 'Grep', 'Bash', 'Edit', 'Write', 'Glob', 'WebFetch']
  s.facts.push({ kind: 'agent', agent: MAIN, agentKind: 'main' })
  const ids: string[] = []
  for (let i = 0; i < agents; i++) {
    const parent = ids.length > 0 && r() < 0.3 ? ids[Math.floor(r() * ids.length)] : undefined
    ids.push(s.spawn({ description: `agent number ${i} with a long description`, parentAgentId: parent }))
    if (batch && (i + 1) % batch === 0) for (const id of ids.slice(-batch)) s.finish(id)
    if (i % 25 === 0) s.prompt(`prompt ${i}`)
  }
  for (let i = 0; i < calls; i++) {
    const agent = r() < 0.2 ? undefined : ids[Math.floor(r() * ids.length)]
    s.call(agent, tools[Math.floor(r() * tools.length)]!, r() < 0.05)
    if (r() < 0.01) s.tick(70_000)
  }
  for (const id of ids) s.finish(id)
  return s
}

/**
 * A waterfall session: batches of agents that run at the same time under
 * main, each batch finished before the next spawns. The second batch is six
 * wide and the first holds a nested child.
 */
export const waterfall = (): Session => {
  const s = new Session()
  s.facts.push({ kind: 'agent', agent: MAIN, agentKind: 'main' })
  s.prompt('fan out in batches')
  s.start()
  for (const [i, width] of [3, 6, 2].entries()) {
    const batch = Array.from({ length: width }, (_, k) => s.spawn({ description: `batch ${i} lens ${k}` }))
    for (const id of batch) s.call(id, 'Read')
    if (i === 0) {
      const nested = s.spawn({ description: 'nested look', parentAgentId: batch[0] })
      s.call(nested, 'Grep')
      s.finish(nested)
    }
    for (const id of batch) s.finish(id)
  }
  s.finish(undefined)
  return s
}
