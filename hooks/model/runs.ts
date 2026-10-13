// Groups an agent's consecutive calls of one tool into runs, so a burst of
// reads shows as one chip with a count.

import type { RunState } from '../../types'
import { callOutcome, type Call, type SessionModel } from './fold'

/** Dated calls further apart than this start a new run; it matches the chip TTL so a faded chip never revives. */
export const RUN_GAP_MS = 2500

export type { RunState }

export type Run = {
  key: string
  agent: string
  tool: string
  firstSeq: number
  lastSeq: number
  count: number
  state: RunState
  start?: number
  end?: number
}

/** Every agent's runs, oldest first within each agent, keyed `${agent}:${firstSeq}`. */
export const runsOf = (m: SessionModel): Run[] => {
  const byAgent = new Map<string, Call[]>()
  for (const c of m.calls.values()) {
    if (c.startSeq === undefined || c.agent === undefined || c.tool === undefined) continue
    const list = byAgent.get(c.agent) ?? []
    list.push(c)
    byAgent.set(c.agent, list)
  }
  const out: Run[] = []
  for (const [agent, calls] of [...byAgent].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    calls.sort((x, y) => x.startSeq! - y.startSeq!)
    let run: Run | undefined
    let states: RunState[] = []
    let prevEnd: number | undefined
    const close = () => {
      if (!run) return
      run.state = states.includes('run') ? 'run' : states.includes('err') ? 'err' : states.includes('unknown') ? 'unknown' : 'ok'
      out.push(run)
    }
    for (const c of calls) {
      const outcome = callOutcome(m, c)
      const gap = c.start !== undefined && prevEnd !== undefined ? c.start - prevEnd : 0
      if (!run || run.tool !== c.tool || gap > RUN_GAP_MS) {
        close()
        run = { key: `${agent}:${c.startSeq}`, agent, tool: c.tool!, firstSeq: c.startSeq!, lastSeq: c.startSeq!, count: 0, state: 'run', start: c.start }
        states = []
      }
      run.count += 1
      run.lastSeq = Math.max(run.lastSeq, c.endSeq ?? c.startSeq!)
      if (c.end !== undefined || c.start !== undefined) run.end = c.end ?? c.start
      states.push(outcome ?? 'run')
      prevEnd = c.end ?? c.start
    }
    close()
  }
  return out
}
