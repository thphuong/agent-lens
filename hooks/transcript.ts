// Translates a session's transcript files into facts, for history the live
// hooks never saw. Pure: the caller feeds lines and sidecar texts, and reads
// the facts back. The format is undocumented and drifts between versions, so
// every field is optional and a record that does not match is skipped.
//
// Only what the log may hold is kept: ids, tool names, outcomes, times, token
// counts and cellText-ed labels, and a human prompt's first line. Tool inputs
// and results, answer text and the rest of a prompt are never read out.

import { LABEL_CELLS, promptLine, workflowRun } from './ingest'
import { groupId, MAIN, type EndStatus, type NewFact } from './model/facts'
import { cellText } from './text'

/**
 * At most this many facts are imported (about 2 MB of the 4 MiB `$.state`
 * holds for the whole mod). Past it the oldest calls, prompts and usage are
 * dropped and the log is marked truncated; agents and their ends are kept.
 */
export const IMPORT_FACTS = 15_000

const STRUCTURE = new Set<NewFact['kind']>(['agent', 'spawn', 'label', 'model', 'ended'])

const INTERRUPTED = /^\[Request interrupted/

/** A background task's completion notice: the agent it names and how it ended. Nothing else of it is read. */
const TASK_ID = /<task-id>\s*([^<\s]+)\s*<\/task-id>/
const TASK_STATUS = /<status>\s*([a-z_]+)\s*<\/status>/

const NOTIFIED: Record<string, EndStatus> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

/** The turn key every imported `ended` fact of a subagent shares, so one end is kept. */
const ENDED = 'transcript'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const blocks = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((b): b is Obj => b !== undefined) : [])

/** What one transcript file says about its agent beyond the facts it produced. */
type FileInfo = { first?: number; last?: number; model?: string }

type AgentMeta = { label?: string; type?: string; toolUseId?: string; finished?: boolean }

type End = { at: number; status: EndStatus }

export type TranscriptResult = {
  facts: NewFact[]
  /**
   * Lines that did not parse as a typed record. Record types this reader has
   * no use for (titles, snapshots, request logs) are passed over uncounted:
   * new ones appear often and say nothing about drift in the ones it reads.
   */
  skipped: number
  /** User and assistant records read, before or after the cutoff. */
  records: number
}

/**
 * Collects a session's transcript, file by file, into facts dated before
 * `cutoff` (epoch ms). Records at or after it are left to the live hooks.
 */
export class TranscriptReader {
  private facts: NewFact[] = []
  private skipped = 0
  private records = 0
  private usage = new Map<string, NewFact>()
  /** Requests with a record at or after the cutoff: the live hooks count those. */
  private late = new Set<string>()
  private files = new Map<string, FileInfo>()
  private metas = new Map<string, AgentMeta>()
  /** Workflow agents by id, with their run. */
  private runs = new Map<string, string>()
  /** Who made each tool call, and when, for parenting subagents. */
  private calls = new Map<string, { agent: string; at: number; label?: string; type?: string }>()
  /** Subagents by id, with the Agent call that launched them, from its result. */
  private launches = new Map<string, string>()
  private ends = new Map<string, End>()
  /** Agents a journal reports as ended, and whether they failed; dated in `result`. */
  private journaled = new Map<string, boolean>()
  private launched = new Set<string>()

  constructor(private readonly cutoff: number) {}

  /** One line of the main transcript. */
  main(line: string): void {
    this.line(MAIN, line)
  }

  /** One line of a subagent's transcript; `runId` for a workflow's agent. */
  agent(id: string, line: string, runId?: string): void {
    if (runId !== undefined) this.runs.set(id, runId)
    this.line(id, line)
  }

  /** A subagent's `.meta.json` text. */
  meta(id: string, text: string): void {
    let m: Obj | undefined
    try {
      m = obj(JSON.parse(text))
    } catch {
      this.skipped += 1
      return
    }
    if (!m) return
    this.metas.set(id, {
      label: str(m.description),
      type: str(m.agentType),
      toolUseId: str(m.toolUseId),
      finished: m.finished === true,
    })
  }

  /** One line of a workflow run's journal: it says how each of the run's agents ended. */
  journal(runId: string, line: string): void {
    const e = this.parse(line)
    if (!e) return
    const agent = str(e.agentId)
    if (e.type !== 'result' || agent === undefined) return
    this.runs.set(agent, runId)
    this.journaled.set(agent, e.error !== undefined || e.isError === true)
  }

  /** The facts, with subagents parented and dated, and how much was skipped. */
  result(): TranscriptResult {
    const usage = [...this.usage].flatMap(([key, f]) => (this.late.has(key) ? [] : [f]))
    const out: NewFact[] = [{ kind: 'agent', agent: MAIN, agentKind: 'main' }, ...this.facts, ...usage]
    // An agent named only by its launch still shows: its files may have been cleaned up.
    const ids = new Set([...this.files.keys(), ...this.metas.keys(), ...this.journaled.keys(), ...this.launches.keys()])
    ids.delete(MAIN)
    const shown = new Set<string>()
    for (const id of ids) {
      const facts = this.spawned(id)
      if (facts.length > 0) shown.add(id)
      out.push(...facts)
    }
    for (const [id, e] of this.ends) {
      if (e.at >= this.cutoff || !shown.has(id)) continue
      out.push({ kind: 'ended', at: e.at, agent: id, status: e.status, turn: ENDED })
    }
    return { facts: capped(out), skipped: this.skipped, records: this.records }
  }

  private spawned(id: string): NewFact[] {
    const file = this.files.get(id)
    const meta = this.metas.get(id) ?? {}
    const run = this.runs.get(id)
    const callId = meta.toolUseId ?? this.launches.get(id)
    const call = callId === undefined ? undefined : this.calls.get(callId)
    const at = call?.at ?? file?.first
    // An agent started after the cutoff is the live hooks' to report.
    if (at === undefined || at >= this.cutoff) return []
    const parent = run !== undefined ? groupId(run) : (call?.agent ?? MAIN)
    const type = cellText(meta.type ?? call?.type ?? 'agent', LABEL_CELLS)
    const facts: NewFact[] = [
      { kind: 'agent', at, agent: id, agentKind: 'sub' },
      { kind: 'spawn', at, agent: id, parent },
      { kind: 'label', at, agent: id, text: cellText(meta.label ?? call?.label ?? type, LABEL_CELLS), type },
    ]
    if (file?.model !== undefined) facts.push({ kind: 'model', at, agent: id, model: file.model })
    if (run !== undefined && !this.launched.has(run)) {
      // The run's launch was not read: the group still shows, under main.
      facts.push({ kind: 'agent', at, agent: groupId(run), agentKind: 'group' }, { kind: 'spawn', at, agent: groupId(run), parent: MAIN })
    }
    // A journal and a finished sidecar have no times: the end is dated by the agent's last record.
    const journaled = this.journaled.get(id)
    if (file?.last !== undefined && (journaled !== undefined || meta.finished)) this.end(id, file.last, journaled === true ? 'failed' : 'done')
    return facts
  }

  /** Which request an assistant record belongs to, per agent. */
  private requestOf(agent: string, r: Obj): string {
    return `${agent}\n${str(r.requestId) ?? str(obj(r.message)?.id) ?? ''}`
  }

  /** Reads a completion notice's task id and status; a task that is no shown agent is dropped in `result`. */
  private notified(text: unknown, at: number) {
    if (typeof text !== 'string') return
    const id = TASK_ID.exec(text)?.[1]
    const status = NOTIFIED[TASK_STATUS.exec(text)?.[1] ?? '']
    if (id !== undefined && status !== undefined) this.end(id, at, status)
  }

  /** Records an agent's end once: the first source to tell it wins. */
  private end(agent: string, at: number, status: EndStatus) {
    if (!this.ends.has(agent)) this.ends.set(agent, { at, status })
  }

  private parse(line: string): Obj | undefined {
    if (line.trim() === '') return undefined
    try {
      const r = obj(JSON.parse(line))
      if (r) return r
    } catch {
      // Counted below.
    }
    this.skipped += 1
    return undefined
  }

  private line(agent: string, line: string) {
    const r = this.parse(line)
    if (!r) return
    const type = r.type
    if (typeof type !== 'string') this.skipped += 1
    if (type !== 'user' && type !== 'assistant' && type !== 'system' && type !== 'attachment') return
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN
    if (!Number.isFinite(at)) return
    if (type === 'attachment') {
      // A background agent's completion may arrive queued as an attachment.
      const a = obj(r.attachment)
      if (at < this.cutoff && a?.commandMode === 'task-notification') this.notified(a.prompt, at)
      return
    }
    if (type !== 'system') {
      this.records += 1
      const file = this.files.get(agent) ?? {}
      file.first = Math.min(file.first ?? at, at)
      file.last = Math.max(file.last ?? at, at)
      this.files.set(agent, file)
    }
    if (at >= this.cutoff) {
      if (type === 'assistant') this.late.add(this.requestOf(agent, r))
      return
    }
    if (type === 'assistant') this.assistant(agent, r, at)
    else if (type === 'user') this.user(agent, r, at)
    else if (r.subtype === 'turn_duration' && agent === MAIN) {
      this.facts.push({ kind: 'ended', at, agent, status: 'done', turn: `uuid:${str(r.uuid) ?? at}` })
    }
  }

  private assistant(agent: string, r: Obj, at: number) {
    const message = obj(r.message)
    if (!message) return
    const model = str(message.model)
    if (model !== undefined && !model.startsWith('<')) {
      const m = cellText(model, LABEL_CELLS)
      this.facts.push({ kind: 'model', at, agent, model: m })
      const file = this.files.get(agent)
      if (file) file.model = m
    }
    // One request is written as several records; the last one's usage stands.
    const u = obj(message.usage)
    const request = str(r.requestId) ?? str(message.id)
    if (u && request !== undefined) {
      const key = this.requestOf(agent, r)
      this.usage.set(key, {
        kind: 'usage',
        at: this.usage.get(key)?.at ?? at,
        agent,
        key: `req:${request}`,
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
      })
    }
    for (const b of blocks(message.content)) {
      const call = str(b.id)
      if (b.type !== 'tool_use' || call === undefined) continue
      // An Agent call's description and type label its subagent; nothing else of its input is read.
      const input = obj(b.input)
      this.calls.set(call, { agent, at, label: str(input?.description), type: str(input?.subagent_type) })
      this.facts.push({ kind: 'toolStart', at, agent, call, tool: cellText(str(b.name) ?? 'tool', LABEL_CELLS) })
    }
  }

  private user(agent: string, r: Obj, at: number) {
    const message = obj(r.message)
    const content = message?.content
    const results = blocks(content).filter(b => b.type === 'tool_result')
    const outcome = obj(r.toolUseResult)
    for (const b of results) {
      const call = str(b.tool_use_id)
      if (call === undefined) continue
      const failed = b.is_error === true
      this.facts.push({ kind: 'toolEnd', at, agent, call, outcome: failed ? 'err' : 'ok' })
      if (!failed && outcome && str(outcome.runId) !== undefined) {
        this.launched.add(str(outcome.runId)!)
        this.facts.push(...workflowRun(agent, outcome, at))
      }
      // A subagent that ran in the foreground ended when its call answered.
      const child = outcome && str(outcome.agentId)
      if (child !== undefined && !this.launches.has(child)) this.launches.set(child, call)
      if (child !== undefined && outcome!.status !== 'async_launched') this.end(child, at, failed ? 'failed' : 'done')
    }
    if (results.length > 0) return
    const origin = obj(r.origin)
    // A background subagent's report coming back is its end.
    if (origin?.kind === 'peer' && str(origin.from) !== undefined) {
      this.end(str(origin.from)!, at, 'done')
      return
    }
    if (origin?.kind === 'task-notification') {
      this.notified(content, at)
      return
    }
    if (agent !== MAIN || r.isMeta === true || r.isCompactSummary === true) return
    if (origin !== undefined && origin.kind !== 'human') return
    const text = typeof content === 'string' ? content : str(blocks(content).find(b => b.type === 'text')?.text)
    // An interruption is written as a user record but was never typed.
    const line = text === undefined || INTERRUPTED.test(text) ? undefined : promptLine(text)
    if (line === undefined) return
    const turn = `uuid:${str(r.uuid) ?? at}`
    this.facts.push({ kind: 'prompt', at, agent, line, turn }, { kind: 'reopened', at, agent, turn })
  }
}

/** Keeps every structural fact and the newest of the rest, up to IMPORT_FACTS in all. */
const capped = (facts: NewFact[]): NewFact[] => {
  if (facts.length <= IMPORT_FACTS) return facts
  const kept = facts.filter(f => STRUCTURE.has(f.kind))
  const rest = facts.filter(f => !STRUCTURE.has(f.kind)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return [...kept, ...rest.slice(0, Math.max(0, IMPORT_FACTS - kept.length - 1)), { kind: 'truncated', agent: MAIN }]
}
