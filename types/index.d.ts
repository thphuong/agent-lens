// The state contract of session-viz, and the types its hooks module and its
// Client surface module share.

declare module 'claude-code' {
  interface PluginState {
    'session-viz': {}
  }
}

/** What a card in the graph stands for. */
export type AgentKind = 'main' | 'sub' | 'group'
