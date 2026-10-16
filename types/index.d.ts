// The state contract of agent-lens, and the types its hooks module and its
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
  | { kind: 'usage'; key: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  /** A turn's summed usage, written by logs older than `usage`; read only for an agent with no `usage` facts. */
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

/**
 * Which session the persisted log belongs to, how many chunks of live facts
 * it spans, its last seq, where history ends and live facts begin (epoch
 * ms, moved to the load time on each load of an imported log), and whether
 * the pane asked for the session's history, so every load reads it again.
 * History itself is never persisted. Logs kept before the last two fields
 * existed lack them.
 */
export type LogMeta = { sessionId: string; chunks: number; seq: number; liveSince?: number; imported?: boolean }

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
  /**
   * The part of the timeline its track shows, as indices into replay order
   * (`from` inclusive, `to` exclusive); absent for the whole timeline. Cleared
   * whenever the log is renumbered, since it indexes facts.
   */
  track?: TrackWindow
}

/** A span of the timeline, as indices into replay order: `from` inclusive, `to` exclusive. */
export type TrackWindow = { from: number; to: number }

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
  /** Context size of the agent's latest model call; 0 for a group. */
  ctx: number
  /** Tokens consumed so far: input, output, cache reads and writes, summed over every call. */
  tok: number
  /** Input tokens served from the prompt cache, and all input tokens; the Client computes the share. */
  cacheRead: number
  inputAll: number
  model?: string
  /**
   * Which batch of siblings that ran at the same time the agent belongs to,
   * counted under its parent in arrival order; absent for the first batch.
   */
  wave?: number
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
  /**
   * The span the track shows: the stored window clamped to the timeline and
   * shifted to hold the playhead, or the whole timeline when not zoomed.
   */
  from: number
  to: number
  /** Tool-call activity in equal buckets across the track's span. */
  spark: number[]
  /** Tool-call activity across the whole timeline, coarser; only while zoomed, and shed first. */
  overview?: number[]
  /** Marker positions within the track's span, as indices into replay order, at most one per spark bucket. */
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
  /** Bumped each time the log is renumbered by an import, so the Client re-takes its baseline and arrival order. */
  renumbered: number
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
  ctx: number
  tok: number
  cacheRead: number
  inputAll: number
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
  /** Main's context size. */
  ctx: number
  tok: number
  cacheRead: number
  inputAll: number
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
  /** One narrated fact back or forward. */
  | { type: 'step'; dir: 1 | -1 }
  /** To the previous or next spawn or failure. */
  | { type: 'seekMarker'; dir: 1 | -1 }
  | { type: 'live' }
  | { type: 'play' }
  | { type: 'compress' }
  | { type: 'speed'; speed: number }
  | { type: 'select'; id: string | null }
  | { type: 'overlay'; overlay: Overlay }
  | { type: 'detailFollow'; on: boolean }
  | { type: 'camera'; mode: CameraMode }
  | { type: 'pin'; id: string; x: number; y: number }
  /** Shows a window of the timeline on its track; `from: null` shows all of it. */
  | { type: 'track'; from: number; to: number }
  | { type: 'track'; from: null }
  | { type: 'relayout' }
  | { type: 'close' }

/**
 * What the Client posts: its intents for one frame, in order, and the
 * renumber count of the props it built them from, so a track window that
 * indexes facts numbered since is dropped.
 */
export type IntentBatch = { intents: Intent[]; renumbered?: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-lens': {
      logMeta: LogMeta
      logChunk: StateFamily<Fact[]>
      ui: Shaped<UiState>
    }
  }
}
