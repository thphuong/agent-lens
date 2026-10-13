// The state contract of session-viz, and the types its hooks module and its
// Client surface module share.

/** What a card in the graph stands for. */
export type AgentKind = 'main' | 'sub' | 'group'

export type Outcome = 'ok' | 'err' | 'unknown'

/** How an agent's run ended, from its turn's completion reason. */
export type EndStatus = 'done' | 'stopped' | 'failed'

/** The engine's own word for an agent's state, as `$.agent.list()` reports it. */
export type LiveStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

/**
 * What the session log records about one agent. A fact holds ids, tool
 * names, outcomes, token counts, times and sanitised labels, never a tool's
 * input or output. Facts state what happened; the fold decides what absence
 * means.
 */
export type FactBody =
  | { kind: 'agent'; agentKind: AgentKind }
  | { kind: 'spawn'; parent: string }
  | { kind: 'label'; text: string; type?: string }
  | { kind: 'model'; model: string }
  | { kind: 'prompt'; line: string; turn?: string }
  | { kind: 'toolStart'; call: string; tool: string }
  | { kind: 'toolEnd'; call: string; outcome: Outcome }
  | { kind: 'tokens'; n: number; turn?: string }
  | { kind: 'ended'; status: EndStatus; turn?: string }
  | { kind: 'reopened'; turn?: string }
  | { kind: 'status'; status: LiveStatus }
  | { kind: 'truncated' }

export type FactHead = {
  /** Order of arrival in the log, assigned by the log. */
  seq: number
  /** Epoch milliseconds when observed live; absent for backfilled history. */
  at?: number
  /** The agent the fact is about: `main`, a subagent id, or `wf:<runId>`. */
  agent: string
}

export type Fact = FactHead & FactBody

/** A fact before the log numbers it. */
export type NewFact = Omit<FactHead, 'seq'> & FactBody

/** Which session the persisted log belongs to, how many chunks it spans, and its last seq. */
export type LogMeta = { sessionId: string; chunks: number; seq: number }

declare module 'claude-code' {
  interface PluginState {
    'session-viz': {
      logMeta: LogMeta
      logChunk: StateFamily<Fact[]>
    }
  }
}
