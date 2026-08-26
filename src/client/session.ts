import { Engine, type EngineEvent } from '../shared/engine'
import { TICK_MS } from '../shared/constants'
import { DEFAULT_RULES } from '../shared/types'
import type {
  C2S,
  InputAction,
  MatchPlayerInfo,
  MatchRules,
  PlayerStatePayload,
  S2C,
  StateCorrectionPayload,
} from '../shared/types'

export interface FloatEffect {
  kind: 'float'
  text: string
  color: string
  born: number
}

export interface PulseEffect {
  kind: 'pulse'
  color: string
  born: number
}

export type Effect = FloatEffect | PulseEffect

/**
 * Client-side match runtime: the locally predicted engine for the player's own
 * board, latest snapshots for the opponents, in-flight attack bookkeeping and
 * transient render effects. Rendered straight to canvas — React never sees
 * per-frame state.
 */
export class GameSession {
  engine: Engine | null = null
  matchId = ''
  seed = 0
  startAtServer = 0
  started = false
  myId = ''
  rules: MatchRules = { ...DEFAULT_RULES }
  players: MatchPlayerInfo[] = []
  opponents = new Map<string, PlayerStatePayload>()
  eliminated = new Map<string, number>()
  winnerId: string | null = null
  effects: Effect[] = []
  private seq = 0
  private baseTick = 0
  private baseServerTime = 0
  private lockHashes = new Map<number, number>()
  private lastResyncAt = 0

  constructor(
    private sendInput: (p: C2S['player_input']) => void,
    private requestResync: (matchId: string) => void,
    private serverNow: () => number,
  ) {}

  resetForMatch(matchId: string, seed: number, startAt: number, myId: string): void {
    this.matchId = matchId
    this.seed = seed
    this.startAtServer = startAt
    this.myId = myId
    this.started = false
    this.engine = new Engine(seed)
    this.seq = 0
    this.baseTick = 0
    this.baseServerTime = startAt
    this.opponents.clear()
    this.eliminated.clear()
    this.winnerId = null
    this.effects = []
    this.lockHashes.clear()
  }

  start(players: MatchPlayerInfo[], rules: MatchRules): void {
    this.players = players
    this.rules = { ...rules }
    this.started = true
  }

  countdownMsLeft(): number {
    return this.startAtServer - this.serverNow()
  }

  curTick(): number {
    const t = this.baseTick + Math.floor((this.serverNow() - this.baseServerTime) / TICK_MS)
    return Math.max(0, t, this.engine?.tick ?? 0)
  }

  /** Advance the local prediction to "now"; call once per animation frame. */
  frame(): void {
    if (!this.engine || !this.started) return
    if (this.serverNow() < this.startAtServer) return
    this.drive(this.engine.advanceTo(this.curTick()))
  }

  act(action: InputAction): void {
    if (!this.engine || !this.started || !this.engine.alive) return
    if (this.serverNow() < this.startAtServer) return
    if (action === 'HARD_DROP' && !this.rules.allow_hard_drop) return
    const tick = this.curTick()
    this.drive(this.engine.applyAction(action, tick))
    this.seq++
    this.sendInput({
      match_id: this.matchId,
      sequence: this.seq,
      action,
      client_time: Date.now(),
      tick,
    })
  }

  private drive(events: EngineEvent[]): void {
    const now = performance.now()
    for (const ev of events) {
      if (ev.kind === 'lock') {
        this.lockHashes.set(ev.piecesPlaced, ev.boardHash)
        if (this.lockHashes.size > 64) {
          const first = this.lockHashes.keys().next().value
          if (first !== undefined) this.lockHashes.delete(first)
        }
        if (ev.cleared > 0) {
          const label =
            ev.tspin === 'full'
              ? ['', 'T-SPIN SINGLE', 'T-SPIN DOUBLE', 'T-SPIN TRIPLE'][Math.min(ev.cleared, 3)]
              : ev.tspin === 'mini'
                ? 'T-SPIN MINI'
                : ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS'][Math.min(ev.cleared, 4)]
          this.effects.push({ kind: 'float', text: label, color: ev.tspin !== 'none' ? '#b45bff' : '#e8ecf4', born: now })
          if (ev.b2bBonus > 0) this.effects.push({ kind: 'float', text: 'BACK-TO-BACK', color: '#ffd60a', born: now + 60 })
          if (ev.combo >= 2) this.effects.push({ kind: 'float', text: `COMBO x${ev.combo}`, color: '#27e05c', born: now + 120 })
          if (ev.perfectClear) this.effects.push({ kind: 'float', text: 'PERFECT CLEAR!', color: '#00d5ff', born: now + 180 })
          if (ev.attackAfterCancel > 0) {
            this.effects.push({ kind: 'float', text: `+${ev.attackAfterCancel} ATTACK`, color: '#ff3b57', born: now + 240 })
          }
          const cancelledLines = ev.cancelled.reduce((a, c) => a + c.lines, 0)
          if (cancelledLines > 0) {
            this.effects.push({ kind: 'float', text: `BLOCKED ${cancelledLines}`, color: '#8bd0ff', born: now + 300 })
          }
        }
      } else if (ev.kind === 'garbage_inserted') {
        this.effects.push({ kind: 'pulse', color: '#ff3b57', born: now })
      }
    }
    this.effects = this.effects.filter((e) => now - e.born < 1400)
  }

  handleSnapshot(p: PlayerStatePayload): void {
    if (p.player_id === this.myId) {
      if (!this.engine || p.pieces_placed === 0) return
      const local = this.lockHashes.get(p.pieces_placed)
      if (local !== undefined && local !== p.hash) {
        const now = Date.now()
        if (now - this.lastResyncAt > 3000) {
          this.lastResyncAt = now
          this.requestResync(this.matchId)
        }
      }
      return
    }
    const prev = this.opponents.get(p.player_id)
    if (!prev || p.tick >= prev.tick || p.alive !== prev.alive || p.connected !== prev.connected) {
      this.opponents.set(p.player_id, p)
    }
  }

  handleAttackCreated(p: S2C['attack_created']): void {
    if (!this.engine) return
    if (p.target_player_id === this.myId) {
      this.engine.addIncoming({
        id: p.attack_id,
        sender: p.sender_player_id,
        lines: p.line_count,
        remaining: p.line_count,
        holes: p.holes,
        createdTick: p.created_tick,
        arrivalTick: p.arrival_tick,
      })
      this.effects.push({
        kind: 'float',
        text: `⚠ ${p.line_count} INCOMING`,
        color: '#ffb020',
        born: performance.now(),
      })
    }
  }

  handleEliminated(p: S2C['player_eliminated']): void {
    this.eliminated.set(p.player_id, p.placement)
    if (this.engine && p.player_id === this.myId) {
      // Server verdict is authoritative (covers disconnect/leave eliminations).
      this.engine.alive = false
    }
  }

  applyCorrection(c: StateCorrectionPayload): void {
    this.matchId = c.match_id
    this.seed = c.seed
    this.startAtServer = c.start_at
    this.myId = c.your_player_id
    this.rules = { ...c.rules }
    this.players = c.players
    this.started = true
    this.engine = Engine.deserialize(c.your_engine)
    this.baseTick = c.your_tick
    this.baseServerTime = c.server_now
    this.seq += 100000 // fresh margin; server only requires monotonicity
    this.lockHashes.clear()
    this.opponents.clear()
    for (const snap of c.snapshots) this.handleSnapshot(snap)
    for (const atk of c.attacks_in_flight) this.handleAttackCreated(atk)
    this.eliminated.clear()
    for (const e of c.eliminated) this.eliminated.set(e.player_id, e.placement)
  }

  nameOf(playerId: string): string {
    return this.players.find((p) => p.player_id === playerId)?.display_name ?? '???'
  }

  opponentList(): PlayerStatePayload[] {
    return this.players
      .filter((p) => p.player_id !== this.myId)
      .map((p) => this.opponents.get(p.player_id))
      .filter((s): s is PlayerStatePayload => s !== undefined)
  }
}
