// Colour tokens for every drawing, in raw hex so fades can step between them.

export const AMBER = '#d7af00'
export const AMBER_DIM = '#8a7a3a'
export const ANT = '#ffd75f'
export const OK = '#5fd75f'
export const ERR = '#ff5f5f'
export const GREY = ['#3a3a3a', '#585858', '#808080', '#a8a8a8', '#d0d0d0'] as const

/**
 * The Client's frame interval. The surface clock quantises: 16 ms measured
 * ~62 fps idle and ~61 fps under 60k-character props every 100 ms, while
 * 33 ms dipped to ~17 fps, below the 18 fps floor.
 */
export const FRAME_MS = 16
