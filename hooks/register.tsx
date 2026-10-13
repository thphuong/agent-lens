import type { EngineInterface, Register } from 'claude-code'

import { agentSpawned, backfill, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted } from './ingest'
import { MAIN, type NewFact } from './model/facts'
import { FactLog, type LogPort } from './persist'

const PANE = 'viz'
const META = { plugin: 'session-viz', key: 'logMeta' } as const
const CHUNK = { plugin: 'session-viz', key: 'logChunk' } as const

// Module state starts over on a hot reload; the log reloads itself from `$.state`.
const log = new FactLog()

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
  $.ui.invalidate('ui.render')
}

const restart = async ($: EngineInterface, sessionId: string) => {
  log.reset(portFor($), sessionId)
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
  if (log.append(portFor($), facts).length > 0) $.ui.invalidate('ui.render')
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

  on('command.run', { command: 'viz' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'session graph' })
    return { text: opened.isPlaced ? 'Session graph opened.' : 'Session graph is waiting for room.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return <Text>The session graph draws on the terminal only.</Text>
    const { Client } = $.ui.resolve(e)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    return (
      <Client key="graph" module="./client/graph.tsx" width="100%" height={bodyRows} props={{ facts: log.facts.length }} />
    )
  })
}
