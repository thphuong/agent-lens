// The one props builder: `ui.render` and `ui.message` both answer with what
// this returns, so a redraw never drops details, info or the selection. The
// payload is held under a measured serialized size by shedding detail in a
// fixed order.

import type { DetailCall, Details, Info, Props, UiState, ViewAgent, ViewModel, ViewRun } from '../types'
import { MAIN, type Fact } from './model/facts'
import { callOutcome, derive, type DerivedAgent, type SessionModel } from './model/fold'
import { runsOf } from './model/runs'
import type { Timeline } from './model/timeline'
import { cellText } from './text'

/** Shedding starts above this many serialized characters; the hard cap is 100,000. */
export const BUDGET = 85_000
export const SPARK_BUCKETS = 160
export const RUNS_PER_AGENT = 3
export const DETAIL_CALLS = 50
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export type PropsInput = {
  timeline: Timeline
  ui: UiState
  now: number
  /** Opening prompts already fetched, by agent id, sanitised. */
  prompts: ReadonlyMap<string, string>
  /** How many times the log was renumbered; 0 when never. */
  renumbered?: number
}

/** The agent details narrate: the selection, or the most recently active agent while following. */
export const detailAgent = (ui: UiState, agents: readonly DerivedAgent[]): string | undefined => {
  if (ui.selected !== undefined && agents.some(a => a.id === ui.selected)) return ui.selected
  if (!ui.detailFollow) return undefined
  let best: DerivedAgent | undefined
  for (const a of agents) if (a.kind !== 'group' && (!best || a.lastSeq > best.lastSeq)) best = a
  return best?.id
}

const narrate = (f: Fact | undefined, names: ReadonlyMap<string, string>): string | undefined => {
  if (!f) return undefined
  const who = names.get(f.agent) ?? f.agent
  switch (f.kind) {
    case 'prompt':
      return `◆ ${f.line}`
    case 'spawn':
      return `❋ ${who} spawned`
    case 'toolStart':
      return `⚒ ${who}: ${f.tool}`
    case 'toolEnd':
      return f.outcome === 'err' ? `✗ ${who}: call failed` : `✓ ${who}: call done`
    case 'ended':
      return f.status === 'failed' ? `✗ ${who} failed` : `${who} ${f.status}`
    case 'reopened':
      return `${who} resumed`
    default:
      return undefined
  }
}

const spark = (order: readonly Fact[], buckets: number): number[] => {
  const out = new Array<number>(buckets).fill(0)
  if (order.length === 0) return out
  order.forEach((f, i) => {
    if (f.kind === 'toolStart') out[Math.min(buckets - 1, Math.floor((i * buckets) / order.length))]! += 1
  })
  return out
}

const details = (m: SessionModel, agent: DerivedAgent, prompts: ReadonlyMap<string, string>, limit: number): Details => {
  const eras = [...m.prompts.values()].sort((a, b) => a.seq - b.seq)
  const calls = [...m.calls.values()]
    .filter(c => c.agent === agent.id && c.startSeq !== undefined && c.tool !== undefined)
    .sort((a, b) => a.startSeq! - b.startSeq!)
    .slice(-limit)
  const grouped: Details['eras'] = []
  for (const c of calls) {
    const era = eras.filter(p => p.seq < c.startSeq!).at(-1)?.line ?? 'history'
    const call: DetailCall = { tool: c.tool!, state: callOutcome(m, c) ?? 'run', start: c.start, end: c.end }
    if (grouped.at(-1)?.prompt === era) grouped.at(-1)!.calls.push(call)
    else grouped.push({ prompt: era, calls: [call] })
  }
  const st = m.agents.get(agent.id)
  const ended = st?.endedSeqs.length ? Math.max(...st.endedSeqs) : undefined
  return {
    agent: agent.id,
    label: agent.label,
    model: agent.model,
    type: agent.type,
    status: agent.status,
    prompt: prompts.get(agent.id),
    eras: grouped,
    ctx: agent.ctx,
    tok: agent.tok,
    cacheRead: agent.cacheRead,
    inputAll: agent.inputAll,
    spawnedSeq: agent.firstSeq,
    endedSeq: ended,
    start: calls.find(c => c.start !== undefined)?.start,
    end: calls.at(-1)?.end ?? calls.at(-1)?.start,
  }
}

const info = (m: SessionModel, agents: readonly DerivedAgent[], compress: boolean): Info => {
  let edits = 0
  for (const c of m.calls.values()) if (c.tool && EDIT_TOOLS.has(c.tool)) edits += 1
  const prompts = [...m.prompts.values()].sort((a, b) => a.seq - b.seq)
  const main = agents.find(a => a.id === MAIN)
  // A group's totals already include its children's.
  const own = agents.filter(a => a.kind !== 'group')
  return {
    model: main?.model,
    agents: agents.filter(a => a.kind === 'sub').length,
    tools: own.reduce((s, a) => s + a.tools, 0),
    edits,
    ctx: main?.ctx ?? 0,
    tok: own.reduce((s, a) => s + a.tok, 0),
    cacheRead: own.reduce((s, a) => s + a.cacheRead, 0),
    inputAll: own.reduce((s, a) => s + a.inputAll, 0),
    lastPrompt: prompts.at(-1)?.line,
    compress,
  }
}

type Shed = { runsPerAgent: number; openRunsOnly: boolean; spark: number; detailCalls: number; labelCells: number }

const LEVELS: Shed[] = [
  { runsPerAgent: RUNS_PER_AGENT, openRunsOnly: false, spark: SPARK_BUCKETS, detailCalls: DETAIL_CALLS, labelCells: 40 },
  { runsPerAgent: RUNS_PER_AGENT, openRunsOnly: true, spark: SPARK_BUCKETS, detailCalls: DETAIL_CALLS, labelCells: 40 },
  { runsPerAgent: RUNS_PER_AGENT, openRunsOnly: true, spark: 80, detailCalls: DETAIL_CALLS, labelCells: 40 },
  { runsPerAgent: RUNS_PER_AGENT, openRunsOnly: true, spark: 80, detailCalls: 20, labelCells: 40 },
  { runsPerAgent: RUNS_PER_AGENT, openRunsOnly: true, spark: 80, detailCalls: 20, labelCells: 24 },
]

/** Runs settled long enough ago that their chips have faded need not travel. */
const RECENT_RUNS = 48

/** Builds the Client's props from the timeline and UI state, shedding detail until it fits the budget. */
export const buildProps = (input: PropsInput): Props => {
  const { timeline, ui, now, prompts } = input
  const m = timeline.model()
  const derived = derive(m)
  const visible = new Set(derived.map(d => d.id))
  const allRuns = runsOf(m).filter(r => visible.has(r.agent))
  const markers = timeline.markers()
  const names = new Map(derived.map(d => [d.id, d.label]))
  const atHead = timeline.order[timeline.playhead - 1]
  const focus = detailAgent(ui, derived)
  const focusAgent = derived.find(d => d.id === focus)

  let json = ''
  for (let level = 0; level < LEVELS.length; level++) {
    const shed = LEVELS[level]!
    const perAgent = new Map<string, ViewRun[]>()
    for (const r of allRuns) {
      const list = perAgent.get(r.agent) ?? []
      list.push(r)
      if (list.length > shed.runsPerAgent) list.shift()
      perAgent.set(r.agent, list)
    }
    let runs = [...perAgent.values()].flat()
    if (shed.openRunsOnly) {
      const recent = new Set(
        [...runs]
          .sort((a, b) => b.lastSeq - a.lastSeq)
          .slice(0, RECENT_RUNS)
          .map(r => r.key),
      )
      runs = runs.filter(r => r.state === 'run' || recent.has(r.key))
    }
    const agents: ViewAgent[] = derived.map(d => ({
      id: d.id,
      parent: d.parent,
      kind: d.kind,
      label: cellText(d.label, shed.labelCells),
      type: cellText(d.type, shed.labelCells),
      status: d.status,
      tool: d.tool,
      tools: d.tools,
      ctx: d.ctx,
      tok: d.tok,
      cacheRead: d.cacheRead,
      inputAll: d.inputAll,
      model: d.kind === 'sub' ? undefined : d.model,
      lastSeq: d.lastSeq,
    }))
    const view: ViewModel = {
      agents,
      runs,
      timeline: {
        length: timeline.length,
        playhead: timeline.playhead,
        transport: timeline.transport(now),
        speed: timeline.speed,
        compress: timeline.compress,
        spark: spark(timeline.order, shed.spark),
        ...markers,
        lastEvent: narrate(atHead, names),
        playheadAt: atHead?.at,
        truncated: m.truncated,
      },
      now,
      seq: m.seq,
      renumbered: input.renumbered ?? 0,
    }
    const props: Props = {
      v: 1,
      view,
      ui,
      details: focusAgent ? details(m, focusAgent, prompts, shed.detailCalls) : undefined,
      info: ui.overlay === 'info' ? info(m, derived, timeline.compress) : undefined,
      degrade: level,
    }
    json = JSON.stringify(props)
    if (json.length <= BUDGET) break
  }
  // Parsed back from its serialization: absent fields drop out, as props require.
  return JSON.parse(json) as Props
}
