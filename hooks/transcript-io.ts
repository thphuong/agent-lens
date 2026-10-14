// Finds a session's transcript files and feeds them, line by line, to the
// transcript reader. The files sit under the Claude Code configuration
// directory: `projects/<project>/<sessionId>.jsonl` for main, and beside it a
// `<sessionId>/subagents/` folder with each subagent's lines and sidecar, and
// a `workflows/<runId>/` folder per workflow run with its journal.

import { TranscriptReader, type TranscriptResult } from './transcript'

/** `$.fs.read` refuses files larger than this; larger ones are streamed. */
export const READ_LIMIT = 4 * 1024 * 1024

/** What the importer reads through: register.tsx backs it with `$.fs` and `$.process`. */
export type FilePort = {
  /** Names of the directory's entries with their kinds; rejects when the directory is missing. */
  list: (dir: string) => Promise<readonly { name: string; kind: 'file' | 'dir' | 'other' }[]>
  exists: (path: string) => Promise<boolean>
  size: (path: string) => Promise<number>
  read: (path: string) => Promise<string>
  /** The file's text in pieces cut anywhere, for files over READ_LIMIT; throws when it cannot be read. */
  stream: (path: string) => AsyncIterable<string>
}

/** A file's lines, read whole when small enough, else streamed with lines rejoined across pieces. */
export async function* fileLines(port: FilePort, path: string): AsyncGenerator<string> {
  // A transcript still being written can pass the limit after its size was taken: then it streams.
  const text = (await port.size(path)) < READ_LIMIT ? await port.read(path).catch(() => undefined) : undefined
  if (text !== undefined) {
    yield* text.split('\n')
    return
  }
  let rest = ''
  for await (const piece of port.stream(path)) {
    const parts = (rest + piece).split('\n')
    rest = parts.pop()!
    yield* parts
  }
  if (rest !== '') yield rest
}

const listOr = async (port: FilePort, dir: string) => port.list(dir).catch(() => [])

/** The project folder holding `<sessionId>.jsonl`, or undefined when no project has it. */
export const locate = async (port: FilePort, configDir: string, sessionId: string): Promise<string | undefined> => {
  const projects = `${configDir}/projects`
  for (const entry of await listOr(port, projects)) {
    if (entry.kind !== 'dir') continue
    const dir = `${projects}/${entry.name}`
    if (await port.exists(`${dir}/${sessionId}.jsonl`)) return dir
  }
  return undefined
}

const AGENT = /^agent-(.+)\.jsonl$/

/** Feeds one folder's subagent files and sidecars; `runId` for a workflow run's folder. */
const readAgents = async (port: FilePort, reader: TranscriptReader, dir: string, runId?: string) => {
  const entries = await listOr(port, dir)
  for (const entry of entries) {
    const id = AGENT.exec(entry.name)?.[1]
    if (entry.kind !== 'file' || id === undefined) continue
    // A file that cannot be read stops there: what it gave so far stays, and the other files are still read.
    try {
      for await (const line of fileLines(port, `${dir}/${entry.name}`)) reader.agent(id, line, runId)
      const meta = `agent-${id}.meta.json`
      if (entries.some(e => e.name === meta)) reader.meta(id, await port.read(`${dir}/${meta}`))
    } catch {}
  }
  if (runId === undefined || !entries.some(e => e.name === 'journal.jsonl')) return
  try {
    for await (const line of fileLines(port, `${dir}/journal.jsonl`)) reader.journal(runId, line)
  } catch {}
}

/**
 * Reads the session's transcript into facts dated before `cutoff`. Answers
 * why not when the main file cannot be found or read; a subagent or workflow
 * file that cannot be read is left out.
 */
export const importTranscript = async (
  port: FilePort,
  configDir: string,
  sessionId: string,
  cutoff: number,
): Promise<TranscriptResult | { reason: string }> => {
  const dir = await locate(port, configDir, sessionId)
  if (dir === undefined) return { reason: `no transcript for this session under ${configDir}/projects` }
  const reader = new TranscriptReader(cutoff)
  try {
    for await (const line of fileLines(port, `${dir}/${sessionId}.jsonl`)) reader.main(line)
  } catch (err) {
    return { reason: `the transcript could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  const subagents = `${dir}/${sessionId}/subagents`
  await readAgents(port, reader, subagents)
  for (const run of await listOr(port, `${subagents}/workflows`)) {
    if (run.kind === 'dir') await readAgents(port, reader, `${subagents}/workflows/${run.name}`, run.name)
  }
  return reader.result()
}
