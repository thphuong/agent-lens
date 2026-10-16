# agent-lens

A Claude Code mod that draws the current session as a live graph in a
docked pane: the main agent, every subagent it spawns, workflow runs
grouped in a frame, and the tools each one is calling. Cards pulse while
an agent works, finished calls glow briefly as chips, and a timeline lets
you scrub back through the session or replay it.

```text
 ╭──────────────────╮
 │ main             │
 │ ○ idle           │
 │                  │
 ╰─────────┬────────╯
           │
           ├────────────────────┬─────────────────────────────────────────────────────────╮
           │         ╭╌╌╌╌╌╌╌╌╌╌│╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮         │
  ╭────────┴───────╮ ╎╭─────────┴────────╮                                      ╎ ╭───────┴───────╮
  │ scan again     │ ╎│ fake-review      │                                      ╎ │ pair          │
  │ ✓ done · explo │ ╎│ ✗ failed · workf │                                      ╎ │ ✓ done · team │
  │                │ ╎│                  │                                      ╎ │               │
  ╰────────┬───────╯ ╎╰─────────┬────────╯                                      ╎ ╰───────────────╯
           │         ╎          │                                               ╎
           │         ╎          ├───────────────────┬──────────────────╮        ╎
           │         ╎          │                   │                  │        ╎
  ╭────────┴───────╮ ╎ ╭────────┴───────╮  ╭────────┴───────╮  ╭───────┴───────╮╎
  │ nested look    │ ╎ │ lens 0         │  │ lens 1         │  │ lens 2        │╎
  │ ✓ done · helpe │ ╎ │ ✓ done · revie │  │ ✓ done · revie │  │ ✗ failed · re │╎
  ╰────────────────╯ ╎ │                │  │                │  │               │╎
                     ╎ ╰────────────────╯  ╰────────────────╯  ╰───────────────╯╎
                     ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯


╭─ timeline ───────────────────────────────────────────────────────────────────────────────────────╮
│  ┊     ❋     ❋   ✗              ❋           ❋           ❋         ✗ ❋          ❋               ┊ │
│    █     █      █       █           █           █           █           █            █           │
│  ┊ █     █      █       █           █           █           █           █            █         ┊ │
│                                                                        07:16:43  88/88  ● LIVE ▲ │
│──────────────────────────────────────────────────────────────────────────────────────────────────│
│ ◆ /clear                                                                                         │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
 ● LIVE  6 agents · 1.1k tok · 100 ctx · 0% cache  ⌖ overview  ↺ layout
```

The capture above is drawn from the synthetic session in the test
fixtures, zoomed out to fit.

## Install for development

```sh
git clone <this repository> agent-lens
cd agent-lens
pnpm install         # TypeScript, for the typecheck only
claude --plugin-dir "$PWD"
```

Edits to the hooks module reload when the turn that saved them ends.
Edits under `hooks/client/` load the next time the pane draws afresh, so
run `/lens` again after changing them.

`pnpm check` typechecks, runs the plugin tests and validates the
plugin. [docs/architecture.md](./docs/architecture.md) explains how the
mod is built and why.

## Use

Run `/lens` to open the pane. It docks beside the transcript when the
terminal is wide enough and opens inline otherwise.

The first `/lens` in a session reads the session's transcript files, so the
graph shows everything from before as well: a resumed session, one
restarted or compacted, or one recorded before the mod was installed. To
see an old session, resume it with `claude --resume <id>` and run `/lens`.
The whole history is read, however long the session, and read again each
time the mod reloads.

Each card counts tokens three ways, and the status bar does the same for
the whole session:

- **tok**: tokens consumed so far, input, output and cache reads and
  writes across every model call. It only grows, also across a
  compaction.
- **cache share** (`87%` beside tok): how much of the input was served
  from the prompt cache. It dips after a compaction and recovers.
- **ctx**: the context size of the agent's latest model call. The status
  bar shows main's. Workflow cards have none.

Narrow cards and a narrow status bar drop the cache share first, then (on
the status bar) ctx.

Click the graph once to give it the keyboard. Escape hands the keyboard
back to the prompt, so the graph uses `x` where you might expect Escape.

| Key | Does |
| --- | --- |
| `space` | play / pause replay |
| `[` `]` | previous / next prompt |
| `,` `.` | step one event back / forward |
| `<` `>` | previous / next spawn or failure |
| `g` `End` | go live |
| `s` | toggle gap compression |
| `o` | overview: fit the whole graph |
| `f` | follow the latest activity on / off |
| `r` | reset the layout, clearing dragged positions |
| `c` | centre the selection |
| `i` `?` | session info / help |
| `Tab` arrows | move the selection |
| `h` `j` `k` `l` | pan (`j`/`k` scroll the details when open) |
| `+` `-` `0` | zoom in, out, reset |
| `x` | close the overlay, then the details |
| `q` | close the pane |

With the mouse:

- Click a card to open its details; drag it to pin it somewhere else.
- Drag the background to pan, and click it to close the details.
- Scroll the wheel over the graph to zoom about the pointer, or over the
  details to scroll them.
- Click or drag along the timeline to seek.
- Scroll the wheel over the timeline to zoom it about the pointer, down to
  one event per column. While zoomed, the timeline's top border shows
  where the zoomed part sits in the whole session; drag along it to move
  that part.
- Click `⌖ follow` / `⌖ manual` on the status bar to toggle follow, and
  `↺ layout` to put dragged cards back into the layout.

Panning or zooming by hand switches the camera to manual; `f` or the
status-bar badge returns it to following the latest activity.

## Limits

- Terminal only: other surfaces show a one-line notice.
- The docked pane is capped at 45% of the terminal's width. Below 110
  columns, or outside fullscreen, the pane opens inline instead.
- Cards show agents, tools, tokens and status. Reasoning text and queued
  operations are not available to mods, so they are not shown.
- The model call that writes a compaction's summary reports no usage to
  mods, so tok leaves it out.
- When the transcript file cannot be found or read (it is streamed with
  `cat` when over 4 MiB, which Windows lacks), history comes from the
  message list instead: the newest 4096 messages per agent, marked
  `truncated` when cut, with no times or token counts and no workflow
  agents. The debug log says why.
- Events that fire while the mod hot-reloads are not seen live. The
  transcript, read again on the reload, fills them in with their times
  and tokens. Only when it cannot be read does the message history fill
  them in, and then a prompt or a model call's tokens can be missing.

## License

MIT. See [LICENSE](./LICENSE).
