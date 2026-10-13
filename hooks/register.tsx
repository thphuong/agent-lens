import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Props, UiState } from '../types'
import { FaultGate } from './fault-gate'
import { FRAME_MS } from './frame'
import { agentSpawned, backfill, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted } from './ingest'
import { applyIntents, parseIntents } from './intents'
import { MAIN, type NewFact } from './model/facts'
import { derive } from './model/fold'
import { Timeline } from './model/timeline'
import { FactLog, type LogPort } from './persist'
import { buildProps, detailAgent } from './props'
import { cellText } from './text'
import { EMPTY_UI } from './uistate'

const PANE = 'viz'
const META = { plugin: 'session-viz', key: 'logMeta' } as const
const CHUNK = { plugin: 'session-viz', key: 'logChunk' } as const
const uiAtom = atom({ plugin: 'session-viz', key: 'ui' } as const, EMPTY_UI, { shape: 'ui-1' })

// Module state starts over on a hot reload: the log reloads itself from
// `$.state`, and the timeline returns to live.
const log = new FactLog()
const timeline = new Timeline()
/** Opening prompts fetched for details, by agent id, sanitised. */
const prompts = new Map<string, string>()
const fetching = new Set<string>()
let stopReplay: (() => void) | undefined
const faults = new FaultGate()
const PROMPT_CHARS = 600

const portFor = ($: EngineInterface): LogPort => ({
  readMeta: async () => (await $.state.get(META)).value,
  writeMeta: async meta => void (await $.state.set(META, meta)),
  readChunk: async i => (await $.state.get({ ...CHUNK, id: String(i) })).value,
  writeChunk: async (i, facts) => void (await $.state.set({ ...CHUNK, id: String(i) }, facts)),
  after: (ms, fn) => void $.clock.after(ms, fn),
})

const warned = new Set<string>()
const warn = ($: EngineInterface, kind: string, err: unknown) => {
  if (warned.has(kind)) return
  warned.add(kind)
  $.ui.log(`session-viz: ${kind} ingest failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
}

// Ingest work runs in order on its own queue, never awaited by an observed
// event's chain, so a slow `$` call cannot hold up a tool call or a turn.
let queue: Promise<void> = Promise.resolve()
const enqueue = ($: EngineInterface, kind: string, work: () => Promise<void>) => {
  queue = queue.then(work).catch(err => warn($, kind, err))
}

const fill = async ($: EngineInterface) => {
  const facts = await backfill(
    {
      messages: agentId => (agentId === undefined ? $.session.messages() : $.session.messages({ agentId })),
      agents: () => $.agent.list(),
    },
    !log.facts.some(f => f.kind === 'prompt'),
  )
  log.append(portFor($), facts)
  changed($)
}

/** The log changed: the timeline follows it, and the pane redraws. */
const changed = ($: EngineInterface) => {
  timeline.setFacts(log.facts)
  $.ui.invalidate('ui.render')
}

const restart = async ($: EngineInterface, sessionId: string) => {
  log.reset(portFor($), sessionId)
  prompts.clear()
  timeline.goLive()
  await update($, uiAtom, () => EMPTY_UI)
  log.append(portFor($), [{ kind: 'agent', agent: MAIN, agentKind: 'main' }])
  await fill($)
}

const load = async ($: EngineInterface) => {
  await log.load(portFor($), await $.session.id())
  if (log.facts.length === 0) log.append(portFor($), [{ kind: 'agent', agent: MAIN, agentKind: 'main' }])
  await fill($)
}

/** A /clear or resume: wait for the new session id, then start the log over. */
const reopen = async ($: EngineInterface, ended: string) => {
  let sessionId = await $.session.id()
  for (let i = 0; i < 20 && sessionId === ended; i++) {
    await $.clock.sleep(50)
    sessionId = await $.session.id()
  }
  await restart($, sessionId)
}

/** Appends facts once the log is known to belong to the current session. */
const append = async ($: EngineInterface, facts: NewFact[]) => {
  const sessionId = await $.session.id()
  if (sessionId !== log.sessionId) await restart($, sessionId)
  if (log.append(portFor($), facts).length > 0) changed($)
}

/** Steps replay on a timer while playing; stops itself once replay ends. */
const syncReplay = ($: EngineInterface) => {
  if (timeline.mode !== 'playing') {
    stopReplay?.()
    stopReplay = undefined
    return
  }
  if (stopReplay) return
  let last = Date.now()
  const timer = $.clock.every(FRAME_MS, () => {
    const now = Date.now()
    if (timeline.tick(now - last)) $.ui.invalidate('ui.render')
    last = now
    if (timeline.mode !== 'playing') syncReplay($)
  })
  stopReplay = () => timer.cancel()
}

/** Fetches an agent's opening prompt for its details, once; redraws when it lands. */
const fetchPrompt = async ($: EngineInterface, agent: string) => {
  if (agent === MAIN || prompts.has(agent) || fetching.has(agent)) return
  fetching.add(agent)
  try {
    const rows = await $.session.messages({ agentId: agent })
    const first = 'deny' in rows ? undefined : rows.find(r => r.role === 'user' && r.text.trim() !== '')
    const line = first?.text.split('\n').find(l => l.trim() !== '')
    prompts.set(agent, line === undefined ? '' : cellText(line.trim(), PROMPT_CHARS))
    $.ui.invalidate('ui.render')
  } finally {
    fetching.delete(agent)
  }
}

/** The props for the current timeline and UI state, starting a details prompt fetch when one is missing. */
const propsFor = ($: EngineInterface, ui: UiState): Props => {
  const agent = detailAgent(ui, derive(timeline.model()))
  if (agent !== undefined && !prompts.has(agent)) void fetchPrompt($, agent).catch(err => warn($, 'details', err))
  return buildProps({ timeline, ui, now: Date.now(), prompts })
}

/** Runs a translator and queues its facts; a translator that throws is logged once per kind. */
const ingest = ($: EngineInterface, kind: string, translate: () => NewFact[]) => {
  let facts: NewFact[]
  try {
    facts = translate()
  } catch (err) {
    warn($, kind, err)
    return
  }
  if (facts.length > 0) enqueue($, kind, () => append($, facts))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'viz', description: 'Open the session graph pane' })
    enqueue($, 'session.start', () => load($))
    return next(e)
  })

  // A /clear or an in-process resume carries on under a new session id with no
  // session.start: start the log over once the new id is in place.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') enqueue($, 'session.end', () => reopen($, e.sessionId))
    return r
  })

  // Observer hooks: each calls next once and returns its result unchanged.
  on('tool.call', async ($, e, next) => {
    ingest($, 'tool.call', () => toolStarted(e, Date.now()))
    const r = await next(e)
    ingest($, 'tool.call', () => toolEnded(e, r, Date.now()))
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    ingest($, 'agent.spawn', () => agentSpawned(e, r, Date.now()))
    return r
  })

  on('turn.start', async ($, e, next) => {
    ingest($, 'turn.start', () => turnStarted(e, Date.now()))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    ingest($, 'turn.complete', () => turnCompleted(e, Date.now()))
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    ingest($, 'prompt.submit', () => promptSubmitted(e, Date.now()))
    return next(e)
  })

  // A Client that keeps failing is left out of the pane until /viz asks again.
  on('ui.fault', { requestId: PANE }, async ($, e, next) => {
    if (faults.record(Date.now())) {
      $.ui.log(`session-viz: graph paused after repeated errors (${e.phase}): ${e.reason}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'viz' }, async $ => {
    if (faults.reset()) $.ui.invalidate('ui.render')
    const opened = await $.ui.open({ id: PANE, title: 'session graph' })
    return { text: opened.isPlaced ? 'Session graph opened.' : 'Session graph is waiting for room.' }
  })

  // The Client posts one batch of intents per frame; each is validated, all
  // apply in order, and the answer is the props they lead to.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const agents = new Set(derive(timeline.model()).map(a => a.id))
    const intents = parseIntents(e.data, agents)
    if (intents.length === 0) return {}
    const before = await read($, uiAtom)
    const { ui, close } = applyIntents(intents, timeline, before)
    if (ui !== before) await update($, uiAtom, () => ui)
    syncReplay($)
    if (close) await $.ui.close({ id: PANE })
    return { props: propsFor($, ui) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return <Text>The session graph draws on the terminal only.</Text>
    if (faults.isPaused) return <Text dimColor>graph paused after an error — /viz to retry</Text>
    const { Client } = $.ui.resolve(e)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const props = propsFor($, await read($, uiAtom))
    return <Client key="graph" module="./client/graph.tsx" width="100%" height={bodyRows} props={props} />
  })
}
