// Translates engine events into facts. Each translator is pure: it keeps ids,
// tool names, outcomes, token counts, times and cellText-ed labels, and never
// a tool's input or result, a prompt's body beyond its first line, or an
// answer's text.

import type {
  AgentInfo,
  AgentSpawnInput,
  AgentSpawnResult,
  PromptSubmitInput,
  SessionMessage,
  ToolCallResult,
  TurnCompleteInput,
  TurnStartInput,
  TurnStepInput,
  TurnUsage,
} from 'claude-code'

import { groupId, MAIN, type EndStatus, type LiveStatus, type NewFact } from './model/facts'
import { cellText } from './text'

export const LABEL_CELLS = 40
export const PROMPT_CELLS = 80
/** `$.session.messages` answers at most this many rows; a full answer means older history was cut. */
export const HISTORY_ROWS = 4096

const who = (agentId: string | undefined) => agentId ?? MAIN

/** The part of a `tool.call` input the translators read. */
export type ToolCallSeen = { tool_use_id: string; tool: unknown; agentId?: string }

export const toolStarted = (e: ToolCallSeen, at: number): NewFact[] => [
  { kind: 'toolStart', at, agent: who(e.agentId), call: e.tool_use_id, tool: cellText(String(e.tool), LABEL_CELLS) },
]

/** A Workflow call's result names its run; the run becomes a group card under the caller. */
export const workflowRun = (agent: string, result: unknown, at?: number): NewFact[] => {
  const r = result as { runId?: unknown; workflowName?: unknown } | undefined
  if (typeof r?.runId !== 'string' || r.runId === '') return []
  const id = groupId(r.runId)
  const name = typeof r.workflowName === 'string' && r.workflowName ? r.workflowName : 'workflow'
  return [
    { kind: 'agent', at, agent: id, agentKind: 'group' },
    { kind: 'spawn', at, agent: id, parent: agent },
    { kind: 'label', at, agent: id, text: cellText(name, LABEL_CELLS), type: 'workflow' },
  ]
}

export const toolEnded = (e: ToolCallSeen, r: ToolCallResult, at: number): NewFact[] => {
  const agent = who(e.agentId)
  const failed = r.deny !== undefined || r.isError === true
  const facts: NewFact[] = [{ kind: 'toolEnd', at, agent, call: e.tool_use_id, outcome: failed ? 'err' : 'ok' }]
  if (!failed && String(e.tool) === 'Workflow') facts.push(...workflowRun(agent, r.result, at))
  return facts
}

export const agentSpawned = (e: AgentSpawnInput, r: AgentSpawnResult, at: number): NewFact[] => {
  if (r.agentId === undefined) return []
  const agent = r.agentId
  const parent = e.workflow ? groupId(e.workflow.runId) : (e.parentAgentId ?? MAIN)
  const facts: NewFact[] = [
    { kind: 'agent', at, agent, agentKind: 'sub' },
    { kind: 'spawn', at, agent, parent },
    {
      kind: 'label',
      at,
      agent,
      text: cellText(e.name || e.description || e.subagentType, LABEL_CELLS),
      type: cellText(e.subagentType, LABEL_CELLS),
    },
    { kind: 'model', at, agent, model: cellText(r.model, LABEL_CELLS) },
  ]
  if (e.workflow) {
    // The group may be seen here before its Workflow call answers.
    const group = groupId(e.workflow.runId)
    facts.push({ kind: 'agent', at, agent: group, agentKind: 'group' })
    if (e.parentAgentId === undefined) facts.push({ kind: 'spawn', at, agent: group, parent: MAIN })
  }
  if (e.resume) facts.push({ kind: 'reopened', at, agent: e.resume.agentId, turn: `resume:${at}` })
  return facts
}

/** A turn starting: main getting to work, a teammate waking or a resumed run. */
export const turnStarted = (e: TurnStartInput, at: number): NewFact[] => [{ kind: 'reopened', at, agent: who(e.agentId), turn: e.turnId }]

const END: Record<TurnCompleteInput['reason'], EndStatus> = {
  answer: 'done',
  aborted: 'stopped',
  error: 'failed',
  refusal: 'failed',
}

/** The usage of one model call, keyed by its turn and position so a live step is counted once. */
export const usageStep = (e: Pick<TurnStepInput, 'turnId' | 'index' | 'agentId'>, u: TurnUsage, at: number): NewFact[] => [
  {
    kind: 'usage',
    at,
    agent: who(e.agentId),
    key: `step:${e.turnId}:${e.index}`,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  },
]

/** The effort a step asks for, kept once per turn; absent when its model takes none. */
export const effortStep = (e: Pick<TurnStepInput, 'turnId' | 'agentId' | 'effort'>, at: number): NewFact[] => [
  {
    kind: 'effort',
    at,
    agent: who(e.agentId),
    turn: e.turnId,
    ...(e.effort === undefined ? {} : { effort: cellText(String(e.effort), LABEL_CELLS) }),
  },
]

/** A turn ending. Its usage is the sum of its steps', which `usageStep` already counted, so only its model is kept. */
export const turnCompleted = (e: TurnCompleteInput, at: number): NewFact[] => {
  const agent = who(e.agentId)
  const facts: NewFact[] = []
  if (e.usage) facts.push({ kind: 'model', at, agent, model: cellText(e.usage.model, LABEL_CELLS), turn: e.turnId })
  facts.push({ kind: 'ended', at, agent, status: END[e.reason], turn: e.turnId })
  return facts
}

/** The line a prompt is kept as: `/name` for a command, else its first line; undefined to skip it. */
export const promptLine = (text: string, command?: { name: string }): string | undefined => {
  if (command) return cellText(`/${command.name}`, PROMPT_CELLS)
  const tag = /^<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text.trim())
  if (tag) return cellText(`/${tag[1]}`, PROMPT_CELLS)
  if (text.trimStart().startsWith('<')) return undefined
  const first = text.split('\n').find(l => l.trim() !== '')
  return first === undefined ? undefined : cellText(first.trim(), PROMPT_CELLS)
}

export const promptSubmitted = (e: Pick<PromptSubmitInput, 'text' | 'command' | 'isMeta' | 'turnId'>, at: number): NewFact[] => {
  if (e.isMeta) return []
  const line = promptLine(e.text, e.command)
  return line === undefined ? [] : [{ kind: 'prompt', at, agent: MAIN, line, turn: e.turnId ?? `prompt:${at}` }]
}

const LIVE: Record<string, LiveStatus> = {
  pending: 'pending',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}

export const listedAgents = (list: readonly AgentInfo[]): NewFact[] =>
  list.flatMap(a => (LIVE[a.status] ? [{ kind: 'status' as const, agent: a.id, status: LIVE[a.status]! }] : []))

/** What backfill reads through: the session's messages and its live agents. */
export type HistoryPort = {
  messages: (agentId?: string) => Promise<readonly SessionMessage[] | { deny: string }>
  agents: () => Promise<readonly AgentInfo[]>
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * Rebuilds what the history holds as undated facts in row order: main's
 * messages, then every subagent reached through an Agent call's `agentId`.
 *
 * A transcript the session cannot read leaves its agent a placeholder with no
 * calls. A full answer of HISTORY_ROWS rows adds `truncated`. A call with no
 * result yet gets no `toolEnd`; the fold closes it when its agent's turn ends.
 * `withPrompts` false skips prompts, for a log that already holds live ones.
 */
export const backfill = async (port: HistoryPort, withPrompts: boolean): Promise<NewFact[]> => {
  const out: NewFact[] = [{ kind: 'agent', agent: MAIN, agentKind: 'main' }]
  const seen = new Set<string>([MAIN])
  const visit = async (agent: string) => {
    const rows = await port.messages(agent === MAIN ? undefined : agent)
    if ('deny' in rows) return
    if (rows.length >= HISTORY_ROWS) out.push({ kind: 'truncated', agent })
    for (const row of rows) {
      if (agent === MAIN && withPrompts && row.role === 'user' && !row.toolResults?.length && row.text) {
        const line = promptLine(row.text)
        if (line !== undefined) out.push({ kind: 'prompt', agent, line })
      }
      for (const use of row.toolUses) {
        const tool = cellText(use.tool, LABEL_CELLS)
        out.push({ kind: 'toolStart', agent, call: use.tool_use_id, tool })
        const answered = use.result !== undefined || use.text !== undefined || use.isError === true
        if (answered) out.push({ kind: 'toolEnd', agent, call: use.tool_use_id, outcome: use.isError ? 'err' : 'ok' })
        if (answered && use.tool === 'Workflow' && !use.isError) out.push(...workflowRun(agent, use.result))
        const child = use.agentId
        if (child === undefined || seen.has(child)) continue
        seen.add(child)
        const type = str(use.input.subagent_type) || 'agent'
        out.push(
          { kind: 'agent', agent: child, agentKind: 'sub' },
          { kind: 'spawn', agent: child, parent: agent },
          { kind: 'label', agent: child, text: cellText(str(use.input.description) || type, LABEL_CELLS), type: cellText(type, LABEL_CELLS) },
        )
        await visit(child)
        if (answered) out.push({ kind: 'ended', agent: child, status: use.isError ? 'failed' : 'done', turn: 'history' })
      }
    }
  }
  await visit(MAIN)
  out.push(...listedAgents(await port.agents()))
  return out
}
