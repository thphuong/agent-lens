// A synthetic session transcript: fake ids, tool names and prompts in the
// record shapes the transcript files use, with marker strings planted where
// tool inputs, tool outputs, answers and prompt bodies go. Never copied from
// a real transcript.

import { TranscriptReader, type TranscriptResult } from '../../hooks/transcript'

/** Strings that must never reach a fact. */
export const SECRETS = ['SECRET-INPUT', 'SECRET-OUTPUT', 'SECRET-ANSWER', 'SECRET-PROMPT-TAIL', 'SECRET-RESULT']

export const T0 = Date.UTC(2026, 9, 1, 9, 0, 0)

type Usage = { input?: number; output?: number; read?: number; write?: number }

export type TranscriptFiles = {
  main: string[]
  agents: { id: string; lines: string[]; meta?: string; runId?: string }[]
  journals: { runId: string; lines: string[] }[]
}

/** Builds transcript files record by record on a fake clock, one second per record. */
export class TranscriptBuilder {
  files: TranscriptFiles = { main: [], agents: [], journals: [] }
  /** Tokens of every request written so far, summed per agent: input, output, cache reads and writes. */
  tokens = new Map<string, number>()
  t = T0
  private n = 0

  private next(prefix: string) {
    this.n += 1
    return `${prefix}${this.n}`
  }

  private stamp() {
    this.t += 1000
    return new Date(this.t).toISOString()
  }

  private lines(agent: string): string[] {
    if (agent === 'main') return this.files.main
    return this.files.agents.find(a => a.id === agent)!.lines
  }

  /** Opens a subagent's file and its sidecar; `runId` for a workflow's agent. */
  subagent(id: string, meta: Record<string, unknown>, runId?: string) {
    this.files.agents.push({ id, lines: [], meta: JSON.stringify(meta), runId })
  }

  journal(runId: string, entries: Record<string, unknown>[]) {
    this.files.journals.push({ runId, lines: entries.map(e => JSON.stringify(e)) })
  }

  raw(agent: string, line: string) {
    this.lines(agent).push(line)
  }

  record(agent: string, r: Record<string, unknown>) {
    this.lines(agent).push(JSON.stringify({ uuid: this.next('uuid-'), timestamp: this.stamp(), sessionId: 'fake-session', ...r }))
  }

  prompt(text: string, origin: Record<string, unknown> | undefined = { kind: 'human' }) {
    this.record('main', { type: 'user', origin, message: { role: 'user', content: text } })
  }

  /**
   * One model request, written as two records as the transcript does: an
   * answer, then the tool calls. The last record says why the model stopped,
   * unless `streaming`: then the request is still being written.
   */
  request(agent: string, calls: { id: string; tool: string; input?: Record<string, unknown> }[], usage: Usage = {}, model = 'model-a', streaming = false, effort?: string) {
    const requestId = this.next('req-')
    const u = {
      input_tokens: usage.input ?? 100,
      output_tokens: usage.output ?? 20,
      cache_read_input_tokens: usage.read ?? 0,
      cache_creation_input_tokens: usage.write ?? 0,
      service_tier: 'standard',
    }
    const sum = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    this.tokens.set(agent, (this.tokens.get(agent) ?? 0) + sum)
    const stop = streaming ? null : calls.length > 0 ? 'tool_use' : 'end_turn'
    const message = (content: unknown[], last: boolean) => ({
      type: 'assistant',
      requestId,
      ...(effort === undefined ? {} : { effort }),
      message: { id: `msg-${requestId}`, model, role: 'assistant', content, usage: u, stop_reason: last ? stop : null },
    })
    this.record(agent, message([{ type: 'text', text: 'SECRET-ANSWER' }], calls.length === 0))
    if (calls.length > 0)
      this.record(agent, message(calls.map(c => ({ type: 'tool_use', id: c.id, name: c.tool, input: c.input ?? { arg: 'SECRET-INPUT' } })), true))
    return requestId
  }

  result(agent: string, call: string, opts: { failed?: boolean; toolUseResult?: Record<string, unknown> } = {}) {
    this.record(agent, {
      type: 'user',
      toolUseResult: opts.toolUseResult ?? { stdout: 'SECRET-OUTPUT' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: 'SECRET-OUTPUT', is_error: opts.failed }] },
    })
  }

  handback(from: string) {
    this.record('main', { type: 'user', isMeta: true, origin: { kind: 'peer', from, body: 'SECRET-RESULT' }, message: { role: 'user', content: 'SECRET-RESULT' } })
  }

  /** A background task's completion notice, queued as an attachment or written as a user record. */
  notification(taskId: string, status: string, form: 'attachment' | 'user') {
    const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>SECRET-RESULT</summary>\n<result>SECRET-RESULT</result>\n</task-notification>`
    if (form === 'attachment') this.record('main', { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: text } })
    else this.record('main', { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text } })
  }

  turnEnd() {
    this.record('main', { type: 'system', subtype: 'turn_duration', durationMs: 1000 })
  }
}

/**
 * The reference transcript: a prompt, a Read, a background subagent that
 * spawns a failing nested one, a workflow of two agents (one failing), a
 * second prompt, plus a malformed line, an unknown record type and an
 * ignored one.
 */
export const referenceTranscript = (): TranscriptBuilder => {
  const b = new TranscriptBuilder()
  b.raw('main', JSON.stringify({ type: 'ai-title', aiTitle: 'SECRET-ANSWER' }))
  b.prompt('map the fake repo\nSECRET-PROMPT-TAIL')
  b.request('main', [{ id: 'c1', tool: 'Read' }], { input: 1000, write: 500 })
  b.result('main', 'c1')
  b.request('main', [{ id: 'c2', tool: 'Agent', input: { description: 'scan files', subagent_type: 'explorer', prompt: 'SECRET-INPUT' } }], { input: 10, read: 1500 })
  b.result('main', 'c2', { toolUseResult: { agentId: 'a1', status: 'async_launched', isAsync: true, prompt: 'SECRET-RESULT' } })

  b.subagent('a1', { agentType: 'explorer', description: 'scan files', toolUseId: 'c2', finished: true })
  b.request('a1', [{ id: 'c3', tool: 'Grep' }])
  b.result('a1', 'c3')
  b.request('a1', [{ id: 'c4', tool: 'Agent', input: { description: 'nested look', subagent_type: 'helper', prompt: 'SECRET-INPUT' } }])
  b.subagent('a2', { agentType: 'helper', description: 'nested look', toolUseId: 'c4' })
  b.request('a2', [{ id: 'c5', tool: 'Bash' }])
  b.result('a2', 'c5', { failed: true })
  b.result('a1', 'c4', { failed: true, toolUseResult: { agentId: 'a2', status: 'completed', prompt: 'SECRET-RESULT' } })
  b.handback('a1')

  b.request('main', [{ id: 'c6', tool: 'Workflow' }])
  b.result('main', 'c6', { toolUseResult: { runId: 'wf_run1', workflowName: 'fake-review', status: 'async_launched', summary: 'SECRET-RESULT' } })
  b.subagent('w1', { agentType: 'workflow-subagent', description: 'lens 0' }, 'wf_run1')
  b.subagent('w2', { agentType: 'workflow-subagent', description: 'lens 1' }, 'wf_run1')
  b.request('w1', [{ id: 'c7', tool: 'Read' }])
  b.result('w1', 'c7')
  b.request('w2', [{ id: 'c8', tool: 'Read' }])
  b.result('w2', 'c8')
  b.journal('wf_run1', [
    { type: 'launched' },
    { type: 'started', agentId: 'w1', label: 'lens 0', key: 'k1' },
    { type: 'started', agentId: 'w2', label: 'lens 1', key: 'k2' },
    { type: 'result', agentId: 'w1', key: 'k1', result: 'SECRET-RESULT' },
    { type: 'result', agentId: 'w2', key: 'k2', error: 'SECRET-RESULT' },
  ])
  b.turnEnd()

  b.raw('main', '{"type": "user", "message": ')
  b.raw('main', JSON.stringify({ type: 'mystery-record', timestamp: new Date(b.t).toISOString() }))
  b.prompt('second fake prompt')
  b.request('main', [])
  b.turnEnd()
  return b
}

/** Reads transcript files as the importer feeds them. */
export const readTranscript = (files: TranscriptFiles, cutoff = Number.POSITIVE_INFINITY): TranscriptResult => {
  const reader = new TranscriptReader(cutoff)
  for (const line of files.main) reader.main(line)
  for (const a of files.agents) {
    for (const line of a.lines) reader.agent(a.id, line, a.runId)
    if (a.meta !== undefined) reader.meta(a.id, a.meta)
  }
  for (const j of files.journals) for (const line of j.lines) reader.journal(j.runId, line)
  return reader.result()
}
