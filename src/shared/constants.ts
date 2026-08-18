// Game-wide constants. Values follow the TriTetris spec.

export const BOARD_W = 10
export const VISIBLE_H = 20
export const BUFFER_H = 4
export const BOARD_H = VISIBLE_H + BUFFER_H // rows 0..3 are the hidden buffer

export const TICK_HZ = 60
export const TICK_MS = 1000 / TICK_HZ

export const NEXT_PREVIEW = 5
export const LOCK_DELAY_MS = 500
export const MAX_LOCK_RESETS = 15
export const GRAVITY_INITIAL_MS = 1000
// Speed-up: every 30 seconds the gravity interval is multiplied by 0.85 (floor 120ms).
export const GRAVITY_LEVEL_SECONDS = 30
export const GRAVITY_FACTOR = 0.85
export const GRAVITY_MIN_MS = 120

export const COUNTDOWN_MS = 3000
export const GARBAGE_ARRIVAL_DELAY_MS = 700
export const RECONNECT_GRACE_MS = 10000
export const PING_INTERVAL_MS = 5000
export const CONNECTION_TIMEOUT_MS = 15000

export const REQUIRED_PLAYERS = 3

// Anti-cheat / rate limits
export const MAX_INPUT_MSGS_PER_SECOND = 120
export const MAX_LOBBY_MSGS_PER_SECOND = 10
// Server sims run this many ticks behind real time so in-flight inputs can be
// applied at their exact claimed tick (keeps client/server sims identical).
export const SERVER_JITTER_TICKS = 12
// An input's claimed tick must be within this many ticks of server real time.
export const TICK_TOLERANCE = 120
// Claimed ticks may run at most this far ahead of server real time.
export const TICK_AHEAD_LIMIT = 12

export const OPPONENT_SNAPSHOT_EVERY_TICKS = 6 // 10 Hz

export const GARBAGE_CELL = 8 // board cell value for garbage

// Attack tables (competitive mode per spec)
export const ATTACK_BY_LINES = [0, 1, 2, 3, 4] // single..tetris
export const TSPIN_ATTACK = [0, 2, 4, 6] // t-spin single/double/triple
export const TSPIN_MINI_ATTACK = 1 // flat, per spec
export const B2B_BONUS = 1
export const PERFECT_CLEAR_ATTACK = 10
export function comboBonus(combo: number): number {
  if (combo <= 1) return 0
  if (combo <= 3) return 1
  if (combo <= 5) return 2
  if (combo <= 7) return 3
  return 4
}

// Scoring (display only; garbage is the competitive currency)
export const SCORE_BY_LINES = [0, 100, 300, 500, 800]
export const SCORE_TSPIN = [400, 800, 1200, 1600] // 0..3 lines
export const SCORE_TSPIN_MINI = [100, 200, 400, 400]
export const SCORE_PERFECT_CLEAR = 2000
export const SCORE_COMBO = 50
export const SCORE_SOFT_DROP = 1 // per cell
export const SCORE_HARD_DROP = 2 // per cell

export function gravityMsAtTick(tick: number): number {
  const level = Math.floor(tick / (TICK_HZ * GRAVITY_LEVEL_SECONDS))
  return Math.max(GRAVITY_MIN_MS, GRAVITY_INITIAL_MS * Math.pow(GRAVITY_FACTOR, level))
}

export function speedLevelAtTick(tick: number): number {
  return Math.floor(tick / (TICK_HZ * GRAVITY_LEVEL_SECONDS)) + 1
}
