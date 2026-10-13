import type { ClientModule } from 'claude-code'

import { AMBER } from './palette'

type Props = { facts?: number }

const Graph: ClientModule<Props> = (props, surface) => {
  const { Text } = surface.elements
  return <Text color={AMBER}>{`session-viz · ${props.facts ?? 0} facts`}</Text>
}

export default Graph
