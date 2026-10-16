import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Props, UiState } from '../types'
import { FaultGate } from './fault-gate'
import { FRAME_MS } from './frame'
import { agentSpawned, backfill, promptSubmitted, toolEnded, toolStarted, turnCompleted, turnStarted, usageStep } from './ingest'
import { applyIntents, parseIntents, wheelTick } from './intents'
import { MAIN, type NewFact } from './model/facts'
import { derive } from './model/fold'
import { Timeline } from './model/timeline'
import { FactLog, type LogPort } from './persist'
import { buildProps, detailAgent } from './props'
import { cellText } from './text'
import { importTranscript, type FilePort } from './transcript-io'
import { EMPTY_UI } from './uistate'

const PANE = 'lens'
const META = { plugin: 'agent-lens', key: 'logMeta' } as const
const CHUNK = { plugin: 'agent-lens', key: 'logChunk' } as const
const uiAtom = atom({ plugin: 'agent-lens', key: 'ui' } as const, EMPTY_UI, { shape: 'ui-1' })

// Module state starts over on a hot reload: the log reloads its live facts
// from `$.state` and its history from the transcript, and the timeline
// returns to live.
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

const filesFor = ($: EngineInterface): FilePort => ({
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  size: async path => (await $.fs.stat(path)).size,
  read: path => $.fs.read(path),
  // `$.fs.read` stops at 4 MiB and `$.process.run` cuts its output there, so a
  // larger file is streamed. Without `cat` (Windows) the read fails, and the
  // import falls back to the message history.
  stream: async function* (path) {
    const child = $.process.spawn({ argv: ['cat', path] })
    let piece = await child.next()
    for (; !piece.done; piece = await child.next()) if (piece.value.stream === 'stdout') yield piece.value.text
    if (piece.value.code !== 0) throw new Error(`cat ended with ${piece.value.code ?? piece.value.signal}`)
  },
})

/** The Claude Code configuration directory, which holds the session transcripts. */
const configDir = async ($: EngineInterface): Promise<string | undefined> => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir.replace(/[\\/]+$/, '')
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

const warned = new Set<string>()
const warn = ($: EngineInterface, kind: string, err: unknown) => {
  if (warned.has(kind)) return
  warned.add(kind)
  $.ui.log(`agent-lens: ${kind} ingest failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
}

// Ingest work runs in order on its own queue, never awaited by an observed
// event's chain, so a slow `$` call cannot hold up a tool call or a turn.
let queue: Promise<void> = Promise.resolve()
const enqueue = ($: EngineInterface, kind: string, work: () => Promise<void>) => {
  queue = queue.then(work).catch(err => warn($, kind, err))
}

/** The track's window indexes facts: an import that renumbers them, or undated facts sorted in first, moves them. */
const clearTrack = ($: EngineInterface) => update($, uiAtom, ({ track: _, ...ui }) => ui)

/** Backfills from the message history; its prompts have no turn to dedupe by, so `withPrompts` false leaves them out. */
const fill = async ($: EngineInterface, withPrompts: boolean) => {
  const facts = await backfill(
    {
      messages: agentId => (agentId === undefined ? $.session.messages() : $.session.messages({ agentId })),
      agents: () => $.agent.list(),
    },
    withPrompts && !log.facts.some(f => f.kind === 'prompt'),
  )
  if (log.append(portFor($), facts).length > 0) await clearTrack($)
  changed($)
}

/** The log changed: the timeline follows it, and the pane redraws. */
const changed = ($: EngineInterface) => {
  timeline.setFacts(log.facts)
  $.ui.invalidate('ui.render')
}

/**
 * Imports the session's history from its transcript, reading only records
 * dated before the cutoff. The first time, the cutoff is when the log began
 * recording live; a load passes its own start, so the transcript also covers
 * what happened while the module was down. When the transcript cannot be
 * found or read, backfills from the message history instead, with prompts
 * only the first time: a backfilled prompt has no turn to dedupe by.
 */
const importHistory = async ($: EngineInterface, loadAt?: number) => {
  await ensureSession($)
  if (loadAt === undefined && log.imported) return
  let cutoff = loadAt ?? log.liveSince
  // A fact observed before the log noted its start still counts as live.
  if (loadAt === undefined) for (const f of log.facts) if (f.at !== undefined && f.at < cutoff) cutoff = f.at
  const dir = await configDir($).catch(() => undefined)
  const r =
    dir === undefined
      ? { reason: 'no home or configuration directory is set' }
      : await importTranscript(filesFor($), dir, log.sessionId, cutoff).catch((err: unknown) => ({
          reason: err instanceof Error ? err.message : String(err),
        }))
  if ('reason' in r || r.records === 0) {
    const why = 'reason' in r ? r.reason : 'the transcript holds no messages'
    $.ui.log(`agent-lens: history from the message list, not the transcript: ${why}`, { to: 'debug' })
    await fill($, loadAt === undefined)
  } else {
    if (r.skipped > 0) $.ui.log(`agent-lens: skipped ${r.skipped} transcript lines it could not read`, { to: 'debug' })
    log.adopt(portFor($), r.facts, cutoff)
    await clearTrack($)
    changed($)
  }
  log.markImported(portFor($))
}

/** Starts the log over for `sessionId`, live from `since` (the earliest event waiting to be logged, else now). */
const restart = async ($: EngineInterface, sessionId: string, since = Date.now()) => {
  // A log the pane had imported into is followed by an import of the next session's.
  const wasImported = log.imported
  log.reset(portFor($), sessionId, Math.min(since, Date.now()))
  prompts.clear()
  timeline.goLive()
  await update($, uiAtom, () => EMPTY_UI)
  log.append(portFor($), [{ kind: 'agent', agent: MAIN, agentKind: 'main' }])
  changed($)
  if (wasImported) await importHistory($)
}

const load = async ($: EngineInterface) => {
  const loadAt = Date.now()
  await log.load(portFor($), await $.session.id(), loadAt)
  if (log.facts.length === 0) log.append(portFor($), [{ kind: 'agent', agent: MAIN, agentKind: 'main' }])
  changed($)
  // History stays in memory only, so a load of an imported log reads it
  // again, up to now: that also covers what happened while the module was
  // down. Events meanwhile wait on the ingest queue and are dated after it.
  if (log.imported) await importHistory($, loadAt)
}

/** Starts the log over when the session id moved on (a /clear or resume seen first through an event). */
const ensureSession = async ($: EngineInterface, since?: number) => {
  const sessionId = await $.session.id()
  if (sessionId !== log.sessionId) await restart($, sessionId, since)
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
  // These facts belong to the new log, so its import must stop before them.
  await ensureSession($, Math.min(...facts.map(f => f.at ?? Number.POSITIVE_INFINITY)))
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
  return buildProps({ timeline, ui, now: Date.now(), prompts, renumbered: log.renumbered })
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
    await $.command.register({ name: 'lens', description: 'Open the session graph pane' })
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

  // One model call's usage. A stream hook must be a generator; it passes every
  // chunk through and returns the result unchanged.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r.usage) {
      const usage = r.usage
      ingest($, 'turn.step', () => usageStep(e, usage, Date.now()))
    }
    return r
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

  // A Client that keeps failing is left out of the pane until /lens asks again.
  on('ui.fault', { requestId: PANE }, async ($, e, next) => {
    if (faults.record(Date.now())) {
      $.ui.log(`agent-lens: graph paused after repeated errors (${e.phase}): ${e.reason}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'lens' }, async $ => {
    if (faults.reset()) $.ui.invalidate('ui.render')
    if (!log.imported) enqueue($, 'import', () => importHistory($))
    const opened = await $.ui.open({ id: PANE, title: 'session graph' })
    return { text: opened.isPlaced ? 'Session graph opened.' : 'Session graph is waiting for room.' }
  })

  // The Client posts one batch of intents per frame; each is validated, all
  // apply in order, and the answer is the props they lead to.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const agents = new Set(derive(timeline.model()).map(a => a.id))
    const renumbered = log.renumbered
    const intents = parseIntents(e.data, agents, renumbered)
    if (intents.length === 0) return {}
    const before = await read($, uiAtom)
    const applied = applyIntents(intents, timeline, before)
    const close = applied.close
    // An import that renumbered the log meanwhile cleared the window; keep it cleared.
    const { track: _, ...rest } = applied.ui
    const ui = log.renumbered === renumbered ? applied.ui : rest
    if (ui !== before) await update($, uiAtom, () => ui)
    syncReplay($)
    if (close) await $.ui.close({ id: PANE })
    return { props: propsFor($, ui) }
  })

  // The wheel over the graph zooms it rather than scrolling the pane: the
  // tick goes to the Client through its props. Scroll keys pass through.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const ui = wheelTick(await read($, uiAtom), e)
    if (!ui) return next(e)
    await update($, uiAtom, () => ui)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return <Text>The session graph draws on the terminal only.</Text>
    if (faults.isPaused) return <Text dimColor>graph paused after an error — /lens to retry</Text>
    const { Client } = $.ui.resolve(e)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const props = propsFor($, await read($, uiAtom))
    return <Client key="graph" module="./client/graph.tsx" width="100%" height={bodyRows} props={props} />
  })
}
