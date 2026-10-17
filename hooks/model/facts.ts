// The fact vocabulary: what the session log records. A fact holds ids, tool
// names, outcomes, token counts, times and sanitised labels, never a tool's
// input or output. Facts state what happened; the fold decides what absence
// means.

import type { NewFact } from '../../types'

export type { AgentKind, EndStatus, Fact, FactBody, LiveStatus, NewFact, Outcome } from '../../types'

export const MAIN = 'main'

/** The group agent id for a workflow run. */
export const groupId = (runId: string) => `wf:${runId}`

/**
 * The identity of a fact for deduplication: two facts with one key describe
 * the same thing, and only one is kept. Undefined for facts that never
 * duplicate (live status polls).
 */
export const dedupeKey = (f: NewFact): string | undefined => {
  switch (f.kind) {
    case 'agent':
      return `agent:${f.agent}`
    case 'spawn':
      return `spawn:${f.agent}`
    case 'label':
      return `label:${f.agent}`
    case 'model':
      return f.turn === undefined ? `model:${f.agent}:${f.model}` : `model:${f.agent}:turn:${f.turn}`
    case 'effort':
      return `effort:${f.agent}:${f.turn ?? ''}`
    case 'prompt':
      return f.turn === undefined ? undefined : `prompt:${f.turn}`
    case 'toolStart':
      return `toolStart:${f.call}`
    case 'toolEnd':
      return `toolEnd:${f.call}`
    case 'usage':
      return `usage:${f.agent}:${f.key}`
    case 'tokens':
      return `tokens:${f.agent}:${f.turn ?? ''}`
    case 'ended':
      return `ended:${f.agent}:${f.turn ?? ''}`
    case 'reopened':
      return `reopened:${f.agent}:${f.turn ?? ''}`
    case 'truncated':
      return `truncated:${f.agent}`
    case 'status':
      return undefined
  }
}
