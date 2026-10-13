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

/** Which overlay covers the graph. */
export type Overlay = 'none' | 'help' | 'info'

/** How the camera moves: following the active agent, fitting everything, or where the person left it. */
export type CameraMode = 'follow' | 'overview' | 'manual'

export type Point = { x: number; y: number }

/** One wheel tick over the pane, in the Client's cells. */
export type Wheel = { seq: number; by: number; column: number; row: number }

/** Interface state that outlives one Client instance. */
export type UiState = {
  selected?: string
  overlay: Overlay
  /** Details narrate the most recently active agent instead of the selection. */
  detailFollow: boolean
  camera: CameraMode
  /** World positions of cards the person dragged. */
  pinned: Record<string, Point>
  wheel?: Wheel
  /** Bumped by a relayout request so every Client instance re-places its cards. */
  relayoutSeq: number
}

export type DisplayStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped'
export type RunState = 'run' | 'ok' | 'err' | 'unknown'
export type Transport = 'live' | 'playing' | 'paused' | 'history' | 'idle'

export type ViewAgent = {
  id: string
  parent?: string
  kind: AgentKind
  label: string
  type: string
  status: DisplayStatus
  tool?: string
  tools: number
  tokens: number
  model?: string
  lastSeq: number
}

export type ViewRun = {
  key: string
  agent: string
  tool: string
  count: number
  state: RunState
  firstSeq: number
  lastSeq: number
  start?: number
  end?: number
}

export type ViewTimeline = {
  length: number
  playhead: number
  transport: Transport
  speed: number
  compress: boolean
  /** Tool-call activity in equal buckets across the whole timeline. */
  spark: number[]
  spawns: number[]
  fails: number[]
  gaps: number[]
  prompts: number[]
  /** The fact at the playhead, narrated. */
  lastEvent?: string
  /** Epoch milliseconds of the fact at the playhead; absent for undated history. */
  playheadAt?: number
  truncated: boolean
}

export type ViewModel = {
  agents: ViewAgent[]
  runs: ViewRun[]
  timeline: ViewTimeline
  now: number
  /** The highest seq in view: a remount adopts it as its baseline. */
  seq: number
}

export type DetailCall = { tool: string; state: RunState; start?: number; end?: number }

export type Details = {
  agent: string
  label: string
  model?: string
  type: string
  status: DisplayStatus
  /** The agent's opening prompt, sanitised, first line only. */
  prompt?: string
  /** The newest calls, grouped under the prompt each followed. */
  eras: { prompt: string; calls: DetailCall[] }[]
  tokens: number
  spawnedSeq: number
  endedSeq?: number
  start?: number
  end?: number
}

export type Info = {
  model?: string
  agents: number
  tools: number
  /** Write, Edit and NotebookEdit calls. */
  edits: number
  tokens: number
  lastPrompt?: string
  compress: boolean
}

/** Everything the Client draws from, built by one function within a size budget. */
export type Props = {
  v: 1
  view: ViewModel
  ui: UiState
  details?: Details
  info?: Info
  /** How many shedding steps the size budget needed (0 when none). */
  degrade: number
}

/** What the Client asks of the hooks module; every one is validated before it acts. */
export type Intent =
  | { type: 'seek'; to: number }
  | { type: 'seekPrompt'; dir: 1 | -1 }
  | { type: 'live' }
  | { type: 'play' }
  | { type: 'compress' }
  | { type: 'speed'; speed: number }
  | { type: 'select'; id: string | null }
  | { type: 'overlay'; overlay: Overlay }
  | { type: 'detailFollow'; on: boolean }
  | { type: 'camera'; mode: CameraMode }
  | { type: 'pin'; id: string; x: number; y: number }
  | { type: 'relayout' }
  | { type: 'close' }

/** What the Client posts: its intents for one frame, in order. */
export type IntentBatch = { intents: Intent[] }

declare module 'claude-code' {
  interface PluginState {
    'session-viz': {
      logMeta: LogMeta
      logChunk: StateFamily<Fact[]>
      ui: Shaped<UiState>
    }
  }
}
