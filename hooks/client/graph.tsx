import type { ClientModule } from 'claude-code'

import { AMBER } from './palette'

const Graph: ClientModule = (_props, surface) => {
  const { Text } = surface.elements
  return <Text color={AMBER}>session-viz</Text>
}

export default Graph
