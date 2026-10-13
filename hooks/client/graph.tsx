import type { ClientModule } from 'claude-code'

import type { Props } from '../../types'
import { AMBER } from './palette'

const Graph: ClientModule<Props> = (props, surface) => {
  const { Text } = surface.elements
  // A hot reload can run this module against props an older hooks module built.
  if (props?.v !== 1) return <Text dimColor>session-viz: waiting for the session…</Text>
  const t = props.view.timeline
  return <Text color={AMBER}>{`session-viz · ${props.view.agents.length} agents · ${t.playhead}/${t.length} ${t.transport}`}</Text>
}

export default Graph
