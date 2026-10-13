// The frame interval shared by the Client's animation clock and the hooks
// module's replay clock. The surface clock quantises: 16 ms measured ~62 fps
// idle and ~61 fps under 60k-character props every 100 ms, while 33 ms dipped
// to ~17 fps, below the 18 fps floor.

export const FRAME_MS = 16
