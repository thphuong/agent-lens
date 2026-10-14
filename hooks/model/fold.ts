// Folds facts into a SessionModel. The result depends only on the set of
// facts: every store is keyed, a fact about an agent not yet seen still
// attaches, re-applying a fact changes nothing, and where two facts compete
// the one with the higher seq wins. The model is mutated in place, so a full
// refold on every seek stays cheap.

import type { DisplayStatus } from '../../types'
import { MAIN, type AgentKind, type EndStatus, type Fact, type LiveStatus, type Outcome } from './facts'

/** A value with the seq of the fact that set it, so competing facts resolve by seq. */
type Stamped<T> = { seq: number; value: T }

export type AgentState = {
  id: string
  /** Declared by an `agent` fact; an id seen only on tool calls is the engine's own. */
  kind?: AgentKind
  /** From the earliest `spawn` fact. */
  parent?: Stamped<string>
  label?: Stamped<{ text: string; type?: string }>
  model?: Stamped<string>
  firstSeq: number
  lastSeq: number
  /** The newest lifecycle fact: `spawn`, `reopened`, `ended` or `status`. */
  lifecycle?: Stamped<Lifecycle>
  /** Seqs of this agent's `ended` facts, which close calls left open before them. */
  endedSeqs: number[]
  /** One entry per model call, by its usage key. */
  usage: Map<string, Usage>
  /** A legacy turn total, used only while `usage` is empty. */
  tokens?: Stamped<number>
  truncated: boolean
}

export type Usage = { seq: number; at?: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export type Lifecycle =
  | { kind: 'spawn' }
  | { kind: 'reopened' }
  | { kind: 'ended'; status: EndStatus }
  | { kind: 'status'; status: LiveStatus }

export type Call = {
  id: string
  agent?: string
  tool?: string
  startSeq?: number
  endSeq?: number
  start?: number
  end?: number
  outcome?: Outcome
}

export type { DisplayStatus }

export type Prompt = { seq: number; at?: number; line: string }

export type SessionModel = {
  agents: Map<string, AgentState>
  calls: Map<string, Call>
  prompts: Map<number, Prompt>
  truncated: boolean
  /** The highest seq applied. */
  seq: number
}

export const createModel = (): SessionModel => ({ agents: new Map(), calls: new Map(), prompts: new Map(), truncated: false, seq: 0 })

const agentOf = (m: SessionModel, id: string, seq: number): AgentState => {
  let a = m.agents.get(id)
  if (!a) {
    a = { id, firstSeq: seq, lastSeq: seq, endedSeqs: [], usage: new Map(), truncated: false }
    m.agents.set(id, a)
  }
  a.firstSeq = Math.min(a.firstSeq, seq)
  a.lastSeq = Math.max(a.lastSeq, seq)
  return a
}

const newer = <T>(cur: Stamped<T> | undefined, seq: number, value: T): Stamped<T> =>
  cur && cur.seq >= seq ? cur : { seq, value }

const callOf = (m: SessionModel, id: string): Call => {
  let c = m.calls.get(id)
  if (!c) {
    c = { id }
    m.calls.set(id, c)
  }
  return c
}

/** Applies one fact to the model in place. */
export const apply = (m: SessionModel, f: Fact): void => {
  m.seq = Math.max(m.seq, f.seq)
  const a = agentOf(m, f.agent, f.seq)
  switch (f.kind) {
    case 'agent':
      a.kind = f.agentKind
      break
    case 'spawn':
      // The earliest spawn names the parent; a later one is only a lifecycle step.
      if (!a.parent || a.parent.seq > f.seq) a.parent = { seq: f.seq, value: f.parent }
      a.lifecycle = newer(a.lifecycle, f.seq, { kind: 'spawn' })
      break
    case 'label':
      a.label = newer(a.label, f.seq, { text: f.text, type: f.type })
      break
    case 'model':
      a.model = newer(a.model, f.seq, f.model)
      break
    case 'prompt':
      m.prompts.set(f.seq, { seq: f.seq, at: f.at, line: f.line })
      break
    case 'toolStart': {
      const c = callOf(m, f.call)
      c.agent = f.agent
      c.tool = f.tool
      c.startSeq = f.seq
      c.start = f.at
      break
    }
    case 'toolEnd': {
      const c = callOf(m, f.call)
      c.agent ??= f.agent
      c.endSeq = f.seq
      c.end = f.at
      c.outcome = f.outcome
      break
    }
    case 'usage':
      a.usage.set(f.key, { seq: f.seq, at: f.at, input: f.input, output: f.output, cacheRead: f.cacheRead, cacheWrite: f.cacheWrite })
      break
    case 'tokens':
      a.tokens = newer(a.tokens, f.seq, f.n)
      break
    case 'ended':
      if (!a.endedSeqs.includes(f.seq)) a.endedSeqs.push(f.seq)
      a.lifecycle = newer(a.lifecycle, f.seq, { kind: 'ended', status: f.status })
      break
    case 'reopened':
      a.lifecycle = newer(a.lifecycle, f.seq, { kind: 'reopened' })
      break
    case 'status':
      a.lifecycle = newer(a.lifecycle, f.seq, { kind: 'status', status: f.status })
      break
    case 'truncated':
      a.truncated = true
      m.truncated = true
      break
  }
}

/** Folds the first `upTo` facts (all by default) into a fresh model. */
export const foldAll = (facts: readonly Fact[], upTo = facts.length): SessionModel => {
  const m = createModel()
  const n = Math.min(upTo, facts.length)
  for (let i = 0; i < n; i++) apply(m, facts[i]!)
  return m
}


/**
 * A call's settled outcome, or undefined while it is in flight. A call left
 * open is closed as `unknown` once its agent's turn ended after it started:
 * it was in flight across a reload, or its end was never observed.
 */
export const callOutcome = (m: SessionModel, c: Call): Outcome | undefined => {
  if (c.outcome !== undefined) return c.outcome
  const start = c.startSeq ?? 0
  const a = m.agents.get(c.agent ?? MAIN)
  return a?.endedSeqs.some(s => s > start) ? 'unknown' : undefined
}

const LIVE: Record<LiveStatus, DisplayStatus> = {
  pending: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const TERMINAL = new Set<DisplayStatus>(['done', 'failed', 'stopped'])

export type DerivedAgent = {
  id: string
  parent?: string
  kind: AgentKind
  label: string
  type: string
  model?: string
  status: DisplayStatus
  /** The tool of the newest call still in flight. */
  tool?: string
  tools: number
  /** Context size of the latest model call: its input, cache reads and cache writes. 0 for a group. */
  ctx: number
  /** Tokens consumed: every call's input, output, cache reads and writes. */
  tok: number
  cacheRead: number
  /** Input, cache reads and cache writes summed: what cache reads are a share of. */
  inputAll: number
  firstSeq: number
  lastSeq: number
  /**
   * The earliest end, not the latest, so a resumed agent never changes what
   * was decided while it first ran. Absent for a group, which runs while any
   * child that has spawned does. Only `ended` facts count: an agent whose end
   * arrived only as a `status` fact has none, so its wave never closes and
   * every later sibling joins it.
   */
  endedSeq?: number
  /**
   * Which batch of concurrent siblings the agent belongs to, counted from 0
   * under its parent in arrival order. An agent joins the newest batch if any
   * member was still running when it spawned; otherwise it starts the next.
   */
  wave: number
  truncated: boolean
}

/** The newer of two calls: a dated one beats an undated one, then the later time, then the higher seq. */
const later = (x: Usage, y: Usage): boolean => {
  if ((x.at === undefined) !== (y.at === undefined)) return x.at !== undefined
  if (x.at !== y.at) return x.at! > y.at!
  return x.seq > y.seq
}

/** An agent's token metrics from its calls; sums, so the arrival order never matters. */
const metrics = (a: AgentState) => {
  let tok = 0
  let cacheRead = 0
  let inputAll = 0
  let last: Usage | undefined
  for (const u of a.usage.values()) {
    const input = u.input + u.cacheRead + u.cacheWrite
    tok += input + u.output
    cacheRead += u.cacheRead
    inputAll += input
    if (!last || later(u, last)) last = u
  }
  if (a.usage.size === 0) tok = a.tokens?.value ?? 0
  return { ctx: last ? last.input + last.cacheRead + last.cacheWrite : 0, tok, cacheRead, inputAll }
}

const firstEnd = (a: AgentState): number | undefined => (a.endedSeqs.length ? Math.min(...a.endedSeqs) : undefined)

/**
 * The display projection of the model: one entry per visible agent (engine
 * forks left out), parents resolved to a visible agent, and groups rolled up
 * from their children. Pure; never stored.
 */
export const derive = (m: SessionModel): DerivedAgent[] => {
  const visible = new Map<string, AgentState>()
  for (const a of m.agents.values()) if (a.kind !== undefined) visible.set(a.id, a)
  // Main is always drawn, whether or not its `agent` fact is in the set yet.
  const main = m.agents.get(MAIN)
  visible.set(MAIN, { ...(main ?? { id: MAIN, firstSeq: 0, lastSeq: 0, endedSeqs: [], usage: new Map(), truncated: false }), kind: 'main' })

  const counts = new Map<string, { tools: number; open?: Call }>()
  for (const c of m.calls.values()) {
    if (c.startSeq === undefined || c.agent === undefined) continue
    const n = counts.get(c.agent) ?? { tools: 0 }
    n.tools += 1
    if (callOutcome(m, c) === undefined && (!n.open || (n.open.startSeq ?? 0) < c.startSeq)) n.open = c
    counts.set(c.agent, n)
  }

  const out = new Map<string, DerivedAgent>()
  for (const a of visible.values()) {
    const n = counts.get(a.id)
    let parent = a.parent?.value
    if (a.id === MAIN) parent = undefined
    else if (parent === undefined || !visible.has(parent) || parent === a.id) parent = MAIN
    let status: DisplayStatus
    if (a.id === MAIN) {
      // Main is only ever working or waiting: running from a turn's start to its end.
      const lc = a.lifecycle?.value
      status = n?.open || lc?.kind === 'reopened' ? 'running' : 'idle'
    } else {
      const lc = a.lifecycle?.value
      status =
        lc === undefined || lc.kind === 'spawn' || lc.kind === 'reopened'
          ? 'running'
          : lc.kind === 'ended'
            ? lc.status
            : LIVE[lc.status]
      if (n?.open && (!TERMINAL.has(status) || (a.lifecycle?.seq ?? 0) < (n.open.startSeq ?? 0))) status = 'running'
    }
    out.set(a.id, {
      id: a.id,
      parent,
      kind: a.kind!,
      label: a.label?.value.text ?? (a.id === MAIN ? 'main' : a.kind === 'group' ? 'workflow' : 'agent'),
      type: a.label?.value.type ?? (a.kind === 'group' ? 'workflow' : a.kind === 'main' ? 'main' : 'agent'),
      model: a.model?.value,
      status,
      tool: n?.open?.tool,
      tools: n?.tools ?? 0,
      ...metrics(a),
      firstSeq: a.firstSeq,
      lastSeq: a.lastSeq,
      endedSeq: firstEnd(a),
      wave: 0,
      truncated: a.truncated,
    })
  }

  // A group is running until it has children and all of them are settled;
  // then failed if any child failed, else done. Nested groups roll up first.
  // A group with no children is running only while main is: its agents may
  // not have spawned yet, but once main is idle they are not coming (agents
  // a resumed history lacks, or remote ones with no local loop).
  const groups = [...out.values()].filter(d => d.kind === 'group')
  const depth = (d: DerivedAgent): number => {
    let k = 0
    for (let p = d.parent; p !== undefined && k < 64; p = out.get(p)?.parent) k++
    return k
  }
  groups.sort((x, y) => depth(y) - depth(x))
  for (const g of groups) {
    const kids = [...out.values()].filter(d => d.parent === g.id)
    if (kids.length === 0) g.status = out.get(MAIN)?.status === 'running' ? 'running' : 'idle'
    else if (kids.some(k => !TERMINAL.has(k.status))) g.status = 'running'
    else g.status = kids.some(k => k.status === 'failed') ? 'failed' : 'done'
    g.tools = kids.reduce((s, k) => s + k.tools, g.tools)
    g.ctx = 0
    g.tok = kids.reduce((s, k) => s + k.tok, g.tok)
    g.cacheRead = kids.reduce((s, k) => s + k.cacheRead, g.cacheRead)
    g.inputAll = kids.reduce((s, k) => s + k.inputAll, g.inputAll)
    g.lastSeq = kids.reduce((s, k) => Math.max(s, k.lastSeq), g.lastSeq)
  }
  const sorted = [...out.values()].sort((x, y) => x.firstSeq - y.firstSeq || (x.id < y.id ? -1 : 1))
  assignWaves(sorted)
  return sorted
}

/** Numbers each agent's wave among its siblings; `agents` is in arrival order. */
const assignWaves = (agents: readonly DerivedAgent[]): void => {
  const kids = new Map<string, DerivedAgent[]>()
  for (const a of agents) {
    if (a.parent === undefined) continue
    const list = kids.get(a.parent) ?? []
    list.push(a)
    kids.set(a.parent, list)
  }
  // Whether an agent ran at seq t: facts after t cannot change the answer. A
  // group runs while any child spawned by then does, or before its first child.
  const runningAt = (a: DerivedAgent, t: number, depth = 0): boolean => {
    if (a.kind !== 'group') return a.endedSeq === undefined || a.endedSeq > t
    const spawned = (kids.get(a.id) ?? []).filter(k => k.firstSeq <= t)
    return spawned.length === 0 || depth > 64 || spawned.some(k => runningAt(k, t, depth + 1))
  }
  const current = new Map<string | undefined, { wave: number; members: DerivedAgent[] }>()
  for (const a of agents) {
    const w = current.get(a.parent)
    if (!w) current.set(a.parent, { wave: 0, members: [a] })
    else if (w.members.some(m => runningAt(m, a.firstSeq))) w.members.push(a)
    else current.set(a.parent, { wave: w.wave + 1, members: [a] })
    a.wave = current.get(a.parent)!.wave
  }
}
