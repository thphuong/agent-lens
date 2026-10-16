// Interface state that must outlive one Client instance: the selection, the
// open overlay, the camera mode, the cards the person dragged and the
// timeline track's zoom window. register.tsx keeps it in `$.state`, so a
// remount or a hot reload restores it.

import type { UiState } from '../types'

export const EMPTY_UI: UiState = { overlay: 'none', detailFollow: false, camera: 'follow', pinned: {} }
