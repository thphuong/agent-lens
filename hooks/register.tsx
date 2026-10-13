import type { Register } from 'claude-code'

const PANE = 'viz'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'viz', description: 'Open the session graph pane' })
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
    return <Client key="graph" module="./client/graph.tsx" width="100%" height={bodyRows} props={{}} />
  })
}
