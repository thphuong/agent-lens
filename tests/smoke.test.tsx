import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-viz',
  component: 'Pane',
  requestId: 'viz',
  props: {
    title: 'session graph',
    isFocused: false,
    bodyColumns: 87,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 32 },
    view: {},
  },
} as const

test('the pane mounts the graph Client on the terminal', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 87, rows: 32 })
  const title = await ui.find({ type: 'Text', text: /session-viz/, in: 'graph' })
  expect(title).toBeDefined()
  await ui.unmount()
})

test('other surfaces get a one-line notice', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/terminal only/)
  await ui.unmount()
})
