# session-viz

A Claude Code mod that draws the current session as a live graph in a
docked pane: the main agent, every subagent it spawns, workflow runs
grouped in a frame, and the tools each one is calling. Cards pulse while
an agent works, finished calls glow briefly as chips, and a timeline lets
you scrub back through the session or replay it.

```text
 ╭──────────────────╮
 │ main             │
 │ ○ idle           │
 ╰─────────┬────────╯
           │
           ├────────────────────┬─────────────────────────────────────────────────────────╮
           │         ╭╌╌╌╌╌╌╌╌╌╌│╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮         │
  ╭────────┴───────╮ ╎╭─────────┴────────╮                                      ╎ ╭───────┴───────╮
  │ scan again     │ ╎│ fake-review      │                                      ╎ │ pair          │
  │ ✓ done · explo │ ╎│ ✗ failed · workf │                                      ╎ │ ✓ done · team │
  ╰────────┬───────╯ ╎│                  │                                      ╎ ╰───────────────╯
           │         ╎╰─────────┬────────╯                                      ╎
           │         ╎          │                                               ╎
           │         ╎          ├───────────────────┬──────────────────╮        ╎
  ╭────────┴───────╮ ╎          │                   │                  │        ╎
  │ nested look    │ ╎ ╭────────┴───────╮  ╭────────┴───────╮  ╭───────┴───────╮╎
  │ ✓ done · helpe │ ╎ │ lens 0         │  │ lens 1         │  │ lens 2        │╎
  ╰────────────────╯ ╎ │ ✓ done · revie │  │ ✓ done · revie │  │ ✗ failed · re │╎
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
 ● LIVE  6 agents · 840 tok  ⌖ overview  ↺ layout
```

The capture above is drawn from the synthetic session in the test
fixtures, zoomed out to fit.

## Install for development

```sh
git clone <this repository> session-viz
cd session-viz
pnpm install         # TypeScript, for the typecheck only
claude --plugin-dir "$PWD"
```

Edits to the hooks module reload when the turn that saved them ends.
Edits under `hooks/client/` load the next time the pane draws afresh, so
run `/viz` again after changing them.

`pnpm check` typechecks, runs the plugin tests and validates the
plugin. [docs/architecture.md](./docs/architecture.md) explains how the
mod is built and why.

## Use

Run `/viz` to open the pane. It docks beside the transcript when the
terminal is wide enough and opens inline otherwise.

Click the graph once to give it the keyboard. Escape hands the keyboard
back to the prompt, so the graph uses `x` where you might expect Escape.

| Key | Does |
| --- | --- |
| `space` | play / pause replay |
| `[` `]` | previous / next prompt |
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
- Click `⌖ follow` / `⌖ manual` on the status bar to toggle follow, and
  `↺ layout` to put moved cards back where they first appeared.

Panning or zooming by hand switches the camera to manual; `f` or the
status-bar badge returns it to following the latest activity.

## Limits

- Terminal only: other surfaces show a one-line notice.
- The docked pane is capped at 45% of the terminal's width. Below 110
  columns, or outside fullscreen, the pane opens inline instead.
- Cards show agents, tools, tokens and status. Reasoning text and queued
  operations are not available to mods, so they are not shown.
- After a resume, history comes from the session's transcripts: the
  newest 4096 messages per agent, marked `truncated` when cut, and without
  timestamps, so it replays as one undated era. Workflow agents are not in
  the transcripts and so are missing from a resumed graph.

## License

MIT. See [LICENSE](./LICENSE).
