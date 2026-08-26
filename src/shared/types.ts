// Protocol types shared by client and server.

export type PieceType = 'I' | 'J' | 'L' | 'O' | 'S' | 'T' | 'Z'

export type InputAction =
  | 'MOVE_LEFT'
  | 'MOVE_RIGHT'
  | 'SOFT_DROP'
  | 'HARD_DROP'
  | 'ROTATE_CW'
  | 'ROTATE_CCW'
  | 'HOLD'

export type LobbyStatus = 'WAITING' | 'READY_CHECK' | 'COUNTDOWN' | 'PLAYING' | 'FINISHED'

export type BotTier = 'easy' | 'medium' | 'hard'

/** Match rules, set by the host in the lobby and enforced by the server. */
export interface MatchRules {
  allow_hard_drop: boolean
}

export const DEFAULT_RULES: MatchRules = { allow_hard_drop: true }

export interface Envelope<T extends string = string, P = unknown> {
  type: T
  message_id: string
  timestamp: number
  payload: P
}

export interface LobbyPlayerInfo {
  player_id: string
  display_name: string
  slot: 1 | 2 | 3
  connected: boolean
  ready: boolean
  host: boolean
  latency_ms: number
  alive: boolean
  is_bot: boolean
  bot_tier: BotTier | null
}

export interface ActivePieceInfo {
  type: PieceType
  rot: number
  x: number
  y: number
}

export interface PlayerStatePayload {
  player_id: string
  tick: number
  board: string[] // BOARD_H strings of BOARD_W digits ('0' empty .. '8' garbage)
  active_piece: ActivePieceInfo | null
  hold_piece: PieceType | null
  next_pieces: PieceType[]
  score: number
  lines: number
  combo: number
  back_to_back: boolean
  alive: boolean
  connected: boolean
  pieces_placed: number
  hash: number // board hash right after the most recent lock
  last_seq: number // last input sequence the server has processed for this player
  incoming_total: number // pending (uninserted) garbage lines
}

export interface AttackCreatedPayload {
  attack_id: string
  sender_player_id: string
  target_player_id: string
  line_count: number
  holes: number[] // hole column per garbage line, server-generated
  created_tick: number // in the target's timeline
  arrival_tick: number // in the target's timeline
  arrival_at: number // server timestamp
}

export interface MatchPlayerInfo {
  player_id: string
  display_name: string
  slot: 1 | 2 | 3
  is_bot: boolean
}

export interface PlayerStats {
  placement: number | null
  survival_time_ms: number
  score: number
  total_lines_cleared: number
  singles: number
  doubles: number
  triples: number
  tetrises: number
  t_spins: number
  perfect_clears: number
  highest_combo: number
  garbage_sent: number
  garbage_received: number
  garbage_cancelled: number
  pieces_placed: number
  pieces_per_second: number
}

export interface SerializedIncomingAttack {
  id: string
  sender: string
  lines: number
  remaining: number
  holes: number[]
  createdTick: number
  arrivalTick: number
}

export interface SerializedEngine {
  seed: number
  board: string[]
  active: (ActivePieceInfo & { lowestY: number }) | null
  hold: PieceType | null
  canHold: boolean
  drawn: number // pieces drawn from the bag stream (active + held + placed)
  tick: number
  gravAccMs: number
  lockMs: number
  lockResets: number
  grounded: boolean
  lastMoveWasRotate: boolean
  lastRotateKickIndex: number
  combo: number
  b2b: boolean
  score: number
  lines: number
  piecesPlaced: number
  alive: boolean
  incoming: SerializedIncomingAttack[]
  lastLockHash: number
  stats: {
    singles: number
    doubles: number
    triples: number
    tetrises: number
    t_spins: number
    perfect_clears: number
    highest_combo: number
    garbage_received: number
    garbage_cancelled: number
  }
}

// ---- client -> server payloads ----

export interface C2S {
  create_lobby: { display_name: string }
  join_lobby: { join_code: string; display_name: string }
  leave_lobby: Record<string, never>
  set_ready: { ready: boolean }
  player_input: {
    match_id: string
    sequence: number
    action: InputAction
    client_time: number
    tick: number
  }
  ping: { client_time: number }
  request_rematch: { match_id: string }
  reconnect: { session_token: string; lobby_id: string }
  resync_request: { match_id: string }
  add_bot: { tier: BotTier }
  remove_bot: { player_id: string }
  set_rules: { rules: Partial<MatchRules> }
}

// ---- server -> client payloads ----

export interface LobbyStatePayload {
  lobby_id: string
  join_code: string
  status: LobbyStatus
  players: LobbyPlayerInfo[]
  required_players: number
  rematch_votes: string[]
  rules: MatchRules
}

export interface StateCorrectionPayload {
  match_id: string
  seed: number
  start_at: number
  server_now: number
  rules: MatchRules
  your_player_id: string
  your_tick: number
  your_engine: SerializedEngine
  players: MatchPlayerInfo[]
  snapshots: PlayerStatePayload[]
  attacks_in_flight: AttackCreatedPayload[]
  eliminated: { player_id: string; placement: number }[]
}

export interface S2C {
  lobby_created: { lobby_id: string; join_code: string; player_id: string; session_token: string }
  lobby_joined: { lobby_id: string; join_code: string; player_id: string; session_token: string }
  lobby_state: LobbyStatePayload
  player_joined: { player: LobbyPlayerInfo }
  player_left: { player_id: string; reason: string }
  player_ready_changed: { player_id: string; ready: boolean }
  match_countdown: { match_id: string; start_at: number; seed: number; server_now: number }
  match_start: {
    match_id: string
    players: MatchPlayerInfo[]
    seed: number
    initial_piece_queue: PieceType[]
    start_at: number
    server_now: number
    rules: MatchRules
  }
  player_state: PlayerStatePayload
  attack_created: AttackCreatedPayload
  garbage_cancelled: { player_id: string; cancelled_lines: number; attack_ids: string[] }
  garbage_applied: {
    player_id: string
    attack_id: string
    sender_player_id: string
    line_count: number
    holes: number[]
    at_tick: number
    pieces_placed: number
  }
  player_eliminated: {
    player_id: string
    placement: number
    eliminated_at: number
    eliminated_by: string | null
    reason: 'topout' | 'disconnect_timeout' | 'left'
  }
  match_end: {
    winner_player_id: string | null
    ranking: { player_id: string; placement: number }[]
    statistics: Record<string, PlayerStats>
  }
  rematch_status: { votes: string[]; needed: number }
  state_correction: StateCorrectionPayload
  pong: { client_time: number; server_time: number }
  error: { code: string; message: string }
}

export type C2SType = keyof C2S
export type S2CType = keyof S2C

export function makeEnvelope<T extends string, P>(type: T, payload: P): Envelope<T, P> {
  return {
    type,
    message_id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36),
    timestamp: Date.now(),
    payload,
  }
}
