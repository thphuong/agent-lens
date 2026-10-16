# agent-lens

Read [docs/architecture.md](docs/architecture.md) before changing how data
flows between the hooks module and the Client.

## Commands

- Use `pnpm`.
- There is no build step. The engine loads the TypeScript in `hooks/`
  directly, so do not add a bundler or an output folder.
- Run the mod for a manual check with `claude --plugin-dir "$PWD"` from the
  repo root, then `/lens`. Hooks-module edits reload when the turn that saved
  them ends. Edits under `hooks/client/` load only when the pane draws
  afresh, so run `/lens` again.
- While iterating, `pnpm typecheck` is the fast check. `pnpm test` has no
  filter and always runs every test file. `pnpm validate` checks the plugin
  manifest and hooks.
- Before reporting work done, run `pnpm check`, which runs all three.

## Do not

- Do not edit `.claude-plugin/types/`. The engine regenerates it on load.
- Do not rename the plugin to anything starting with `claude-`. The engine
  reserves that prefix and `claude plugin validate` refuses it.
- Do not add npm runtime imports, `eval`, `import()` or WebAssembly to
  `hooks/`. Modules cannot load them. TypeScript is a dev dependency only.
- Do not build test fixtures from real sessions. Extend the synthetic
  generator in `tests/fixtures/generate.ts`.

## Invariants that tests do not fully catch

- An observer hook calls `next(e)` exactly once and returns its result
  unchanged, even when ingest throws.
- Never store a tool's input or output, an answer's text, or a prompt
  beyond its first line. Pass every drawn string through `cellText`.
- State that must survive a remount or a hot reload goes in `$.state` from
  the hooks module, never in Client or module memory.
- Props and the painted tree stay under their measured size budgets. Shed
  detail instead of raising `BUDGET` or `PAINT_BUDGET`.
