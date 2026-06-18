// Shared mutable state + input/look config. Plain data that the other modules read and write;
// using objects (not exported `let`s) keeps the bindings live across modules.

export type GameState = 'menu' | 'hiding' | 'seeking' | 'result'

// the game phase + per-round flags/timers (drives which menu shows and whether the sim runs)
export const game = {
  state: 'menu' as GameState,
  paused: false,         // Tab pause, only meaningful during hiding/seeking
  paintMode: false,      // painting sub-mode (Q during hiding); not a separate state
  confirmingHide: false, // showing the "done hiding?" confirm
  seekTimeLeft: 0,       // seconds left in the seek phase
}

// camera look state: written by input, read by the per-frame camera code
export const look = {
  yaw: 0,     // angle around the player (left/right)
  pitch: 0.5, // up/down (radians)
  zoom: 1,    // orbit-distance multiplier
}

// player-adjustable settings (changed from the Settings panel)
export const DEFAULT_MOVE_SPEED = 8 // chameleon walk speed (units/sec)
export const settings = {
  sensitivity: 1,                // mouse-look multiplier (0-10)
  moveSpeed: DEFAULT_MOVE_SPEED,  // scales all chameleon movement (incl. float)
}

// which keys are currently held
export const keys: Record<string, boolean> = {}

// look limits + base look speed (shared by input look and the paint-mode orbit)
export const BASE_SENSITIVITY = 0.0025 // look speed at sensitivity = 1
export const PITCH_MIN = -1.55 // look up from almost directly below the chameleon
export const PITCH_MAX = 1.55  // look down from almost directly above (a hair short so it can't flip)
