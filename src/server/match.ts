import type { WebSocket } from 'ws'
import { Engine, type EngineEvent } from '../shared/engine'
import { BagStream } from '../shared/rng'
import {
  BOARD_W,
  COUNTDOWN_MS,
  GARBAGE_ARRIVAL_DELAY_MS,
  MAX_INPUT_MSGS_PER_SECOND,
  OPPONENT_SNAPSHOT_EVERY_TICKS,
  RECONNECT_GRACE_MS,
  SERVER_JITTER_TICKS,
  TICK_AHEAD_LIMIT,
  TICK_MS,
  TICK_TOLERANCE,
} from '../shared/constants'
import type {
  AttackCreatedPayload,
  C2S,
  MatchPlayerInfo,
  MatchRules,
  PlayerStatePayload,
  PlayerStats,
  S2C,
  S2CType,
  StateCorrectionPayload,
} from '../shared/types'
import { TokenBucket, send, uuid } from './util'

export interface MatchPlayerHandle {
  playerId: string
  displayName: string
  slot: 1 | 2 | 3
  isBot: boolean
  getWs(): WebSocket | null
}

interface PendingInput {
  seq: number
  action: C2S['player_input']['action']
  tick: number
}

interface AttackRecord {
  id: string
  senderId: string
  targetId: string
  lines: number
  remaining: number
  holes: number[]
  createdTick: number
  arrivalTick: number
  arrivalAt: number
  status: 'PENDING' | 'APPLIED' | 'CANCELLED'
}

interface MatchPlayer {
  handle: MatchPlayerHandle
  engine: Engine
  pending: PendingInput[]
  lastSeq: number
  lastClaimedTick: number
  inputBucket: TokenBucket
  resyncBucket: TokenBucket
  tickLag: number
  frozenAtRealTick: number | null
  graceTimer: NodeJS.Timeout | null
  placement: number | null
  eliminatedAt: number | null
  eliminatedBy: string | null
  garbageSent: number
  invalidInputs: number
}

export type MatchStatus = 'COUNTDOWN' | 'PLAYING' | 'FINISHED' | 'CANCELLED'

export interface ServerMatchCallbacks {
  /** Countdown reached zero but the lobby was no longer valid. */
  onAborted(): void
  /** Match transitioned to PLAYING. */
  onStarted(): void
  /** Match finished; ranking is final. */
  onEnded(): void
}

export class ServerMatch {
  readonly id = uuid()
  readonly seed: number
  status: MatchStatus = 'COUNTDOWN'
  startAt = 0
  finishedAt = 0
  private players = new Map<string, MatchPlayer>()
  private order: string[] = []
  private attacks = new Map<string, AttackRecord>()
  private eliminationOrder: string[] = []
  private loopTimer: NodeJS.Timeout | null = null
  private beginTimer: NodeJS.Timeout | null = null
  private lastSnapshotTick = -1

  constructor(
    handles: MatchPlayerHandle[],
    readonly rules: MatchRules,
    private cb: ServerMatchCallbacks,
  ) {
    this.seed = Math.floor(Math.random() * 0xffffffff) >>> 0
    for (const handle of handles) {
      this.players.set(handle.playerId, {
        handle,
        engine: new Engine(this.seed),
        pending: [],
        lastSeq: 0,
        lastClaimedTick: 0,
        inputBucket: new TokenBucket(MAX_INPUT_MSGS_PER_SECOND, 40),
        resyncBucket: new TokenBucket(0.5, 2),
        tickLag: 0,
        frozenAtRealTick: null,
        graceTimer: null,
        placement: null,
        eliminatedAt: null,
        eliminatedBy: null,
        garbageSent: 0,
        invalidInputs: 0,
      })
      this.order.push(handle.playerId)
    }
  }

  // ---------- lifecycle ----------

  startCountdown(): void {
    this.startAt = Date.now() + COUNTDOWN_MS
    this.broadcast('match_countdown', {
      match_id: this.id,
      start_at: this.startAt,
      seed: this.seed,
      server_now: Date.now(),
    })
    this.beginTimer = setTimeout(() => this.begin(), Math.max(0, this.startAt - Date.now()))
  }

  private begin(): void {
    this.beginTimer = null
    if (this.status !== 'COUNTDOWN') return
    // Atomic re-check before PLAYING: all three players must still be connected.
    for (const mp of this.players.values()) {
      if (!mp.handle.isBot && !mp.handle.getWs()) {
        this.cancel()
        this.cb.onAborted()
        return
      }
    }
    this.status = 'PLAYING'
    const players = this.playerInfos()
    const initialQueue = new BagStream(this.seed).peek(7)
    this.broadcast('match_start', {
      match_id: this.id,
      players,
      seed: this.seed,
      initial_piece_queue: initialQueue,
      start_at: this.startAt,
      server_now: Date.now(),
      rules: { ...this.rules },
    })
    this.loopTimer = setInterval(() => this.loop(), 16)
    this.cb.onStarted()
  }

  cancel(): void {
    if (this.status === 'FINISHED') return
    this.status = 'CANCELLED'
    this.dispose()
  }

  dispose(): void {
    if (this.loopTimer) clearInterval(this.loopTimer)
    if (this.beginTimer) clearTimeout(this.beginTimer)
    this.loopTimer = null
    this.beginTimer = null
    for (const mp of this.players.values()) {
      if (mp.graceTimer) clearTimeout(mp.graceTimer)
      mp.graceTimer = null
    }
  }

  isAlive(playerId: string): boolean {
    return this.players.get(playerId)?.engine.alive ?? false
  }

  playerInfos(): MatchPlayerInfo[] {
    return this.order.map((id) => {
      const mp = this.players.get(id)!
      return { player_id: id, display_name: mp.handle.displayName, slot: mp.handle.slot, is_bot: mp.handle.isBot }
    })
  }

  // ---------- time ----------

  private realTick(now = Date.now()): number {
    return Math.floor((now - this.startAt) / TICK_MS)
  }

  /** The player's own timeline tick corresponding to "now" (frozen time excluded). */
  private effTick(mp: MatchPlayer, now = Date.now()): number {
    const rt = this.realTick(now)
    const frozen = mp.frozenAtRealTick !== null ? rt - mp.frozenAtRealTick : 0
    return rt - mp.tickLag - frozen
  }

  // ---------- input ----------

  handleInput(playerId: string, p: C2S['player_input']): void {
    if (this.status !== 'PLAYING') return
    const mp = this.players.get(playerId)
    if (!mp || !mp.engine.alive || mp.frozenAtRealTick !== null) return
    if (p.match_id !== this.id) return
    if (!mp.inputBucket.take()) return
    const validActions = ['MOVE_LEFT', 'MOVE_RIGHT', 'SOFT_DROP', 'HARD_DROP', 'ROTATE_CW', 'ROTATE_CCW', 'HOLD']
    if (!validActions.includes(p.action)) return
    if (p.action === 'HARD_DROP' && !this.rules.allow_hard_drop) {
      mp.invalidInputs++
      return
    }
    if (!Number.isInteger(p.sequence) || p.sequence <= mp.lastSeq) return // monotonic, dedupes
    if (!Number.isInteger(p.tick) || p.tick < 0) return
    if (p.tick < mp.lastClaimedTick) return // inputs may not go back in time
    const eff = this.effTick(mp)
    if (p.tick > eff + TICK_AHEAD_LIMIT) {
      mp.invalidInputs++
      return
    }
    if (p.tick < eff - TICK_TOLERANCE) {
      mp.invalidInputs++
      return
    }
    mp.lastSeq = p.sequence
    mp.lastClaimedTick = p.tick
    mp.pending.push({ seq: p.sequence, action: p.action, tick: p.tick })
  }

  // ---------- main loop ----------

  private loop(): void {
    if (this.status !== 'PLAYING') return
    const now = Date.now()
    for (const id of this.order) {
      const mp = this.players.get(id)!
      if (!mp.engine.alive || mp.frozenAtRealTick !== null) continue
      // The sim trails real time by a jitter buffer so in-flight inputs can be
      // applied at their exact claimed tick — identical to the client's sim.
      const target = this.effTick(mp, now) - SERVER_JITTER_TICKS
      if (target <= mp.engine.tick && mp.pending.length === 0) continue
      const events: EngineEvent[] = []
      while (mp.pending.length > 0 && mp.pending[0].tick <= target) {
        const input = mp.pending.shift()!
        const applyTick = Math.max(input.tick, mp.engine.tick) // late inputs clamp forward
        events.push(...mp.engine.applyAction(input.action, applyTick))
      }
      if (target > mp.engine.tick) events.push(...mp.engine.advanceTo(target))
      this.handleEvents(mp, events, now)
      if (this.status !== 'PLAYING') return
    }
    this.maybeSnapshot(now)
  }

  private handleEvents(mp: MatchPlayer, events: EngineEvent[], now: number): void {
    for (const ev of events) {
      if (ev.kind === 'lock') {
        if (ev.cancelled.length > 0) {
          let lines = 0
          const ids: string[] = []
          for (const c of ev.cancelled) {
            lines += c.lines
            ids.push(c.id)
            const rec = this.attacks.get(c.id)
            if (rec) {
              rec.remaining = Math.max(0, rec.remaining - c.lines)
              if (rec.remaining === 0) rec.status = 'CANCELLED'
            }
          }
          this.broadcast('garbage_cancelled', {
            player_id: mp.handle.playerId,
            cancelled_lines: lines,
            attack_ids: ids,
          })
        }
        if (ev.attackAfterCancel > 0) {
          this.createAttack(mp, ev.attackAfterCancel, now)
        }
      } else if (ev.kind === 'garbage_inserted') {
        const rec = this.attacks.get(ev.attackId)
        if (rec) {
          rec.status = 'APPLIED'
          rec.remaining = 0
        }
        this.broadcast('garbage_applied', {
          player_id: mp.handle.playerId,
          attack_id: ev.attackId,
          sender_player_id: ev.sender,
          line_count: ev.lines,
          holes: ev.holes,
          at_tick: ev.tick,
          pieces_placed: ev.piecesPlaced,
        })
      } else if (ev.kind === 'topout') {
        this.eliminate(mp, 'topout', mp.engine.lastGarbageSender, now)
      }
    }
  }

  private createAttack(sender: MatchPlayer, lines: number, now: number): void {
    const targets = this.order
      .map((id) => this.players.get(id)!)
      .filter((p) => p !== sender && p.engine.alive)
    if (targets.length === 0) return
    const target = targets[Math.floor(Math.random() * targets.length)]
    const holes = Array.from({ length: lines }, () => Math.floor(Math.random() * BOARD_W))
    const createdTick = this.effTick(target, now)
    const arrivalTick = createdTick + Math.round(GARBAGE_ARRIVAL_DELAY_MS / TICK_MS)
    const attack: AttackRecord = {
      id: uuid(),
      senderId: sender.handle.playerId,
      targetId: target.handle.playerId,
      lines,
      remaining: lines,
      holes,
      createdTick,
      arrivalTick,
      arrivalAt: now + GARBAGE_ARRIVAL_DELAY_MS,
      status: 'PENDING',
    }
    this.attacks.set(attack.id, attack)
    sender.garbageSent += lines
    target.engine.addIncoming({
      id: attack.id,
      sender: attack.senderId,
      lines,
      remaining: lines,
      holes,
      createdTick,
      arrivalTick,
    })
    this.broadcast('attack_created', this.attackPayload(attack))
  }

  private attackPayload(a: AttackRecord): AttackCreatedPayload {
    return {
      attack_id: a.id,
      sender_player_id: a.senderId,
      target_player_id: a.targetId,
      line_count: a.lines,
      holes: a.holes,
      created_tick: a.createdTick,
      arrival_tick: a.arrivalTick,
      arrival_at: a.arrivalAt,
    }
  }

  // ---------- elimination / finish ----------

  private aliveCount(): number {
    let n = 0
    for (const mp of this.players.values()) if (mp.engine.alive) n++
    return n
  }

  private eliminate(
    mp: MatchPlayer,
    reason: 'topout' | 'disconnect_timeout' | 'left',
    eliminatedBy: string | null,
    now: number,
  ): void {
    if (mp.placement !== null || this.status !== 'PLAYING') return
    // Count by placement, not engine.alive: on a topout the engine has already
    // flagged itself dead by the time this runs. First of 3 out places 3rd.
    let placementAtDeath = 0
    for (const p of this.players.values()) if (p.placement === null) placementAtDeath++
    mp.engine.alive = false
    mp.placement = placementAtDeath
    mp.eliminatedAt = now
    mp.eliminatedBy = eliminatedBy
    this.eliminationOrder.push(mp.handle.playerId)
    if (mp.graceTimer) {
      clearTimeout(mp.graceTimer)
      mp.graceTimer = null
    }
    this.broadcast('player_eliminated', {
      player_id: mp.handle.playerId,
      placement: placementAtDeath,
      eliminated_at: now,
      eliminated_by: eliminatedBy,
      reason,
    })
    // Pending attacks aimed at the dead player are cancelled, not redirected.
    const voided: string[] = []
    let voidedLines = 0
    for (const rec of this.attacks.values()) {
      if (rec.targetId === mp.handle.playerId && rec.status === 'PENDING') {
        rec.status = 'CANCELLED'
        voided.push(rec.id)
        voidedLines += rec.remaining
        rec.remaining = 0
      }
    }
    if (voided.length > 0) {
      this.broadcast('garbage_cancelled', {
        player_id: mp.handle.playerId,
        cancelled_lines: voidedLines,
        attack_ids: voided,
      })
    }
    this.broadcastSnapshot(mp)
    if (this.aliveCount() <= 1) this.finish(now)
  }

  private finish(now: number): void {
    if (this.status !== 'PLAYING') return
    this.status = 'FINISHED'
    this.finishedAt = now
    const alive = this.order.map((id) => this.players.get(id)!).filter((p) => p.engine.alive)
    let winnerId: string | null = null
    if (alive.length === 1) {
      winnerId = alive[0].handle.playerId
      alive[0].placement = 1
    } else if (this.eliminationOrder.length > 0) {
      // Everyone died in the same tick burst: the last eliminated wins.
      winnerId = this.eliminationOrder[this.eliminationOrder.length - 1]
      this.players.get(winnerId)!.placement = 1
    }
    const ranking = this.order
      .map((id) => ({ player_id: id, placement: this.players.get(id)!.placement ?? 1 }))
      .sort((a, b) => a.placement - b.placement)
    const statistics: Record<string, PlayerStats> = {}
    for (const id of this.order) statistics[id] = this.statsFor(this.players.get(id)!)
    this.broadcast('match_end', { winner_player_id: winnerId, ranking, statistics })
    this.dispose()
    this.cb.onEnded()
  }

  private statsFor(mp: MatchPlayer): PlayerStats {
    const e = mp.engine
    const survival = (mp.eliminatedAt ?? (this.finishedAt || Date.now())) - this.startAt
    const seconds = Math.max(0.001, survival / 1000)
    return {
      placement: mp.placement,
      survival_time_ms: Math.max(0, survival),
      score: e.score,
      total_lines_cleared: e.lines,
      singles: e.stats.singles,
      doubles: e.stats.doubles,
      triples: e.stats.triples,
      tetrises: e.stats.tetrises,
      t_spins: e.stats.t_spins,
      perfect_clears: e.stats.perfect_clears,
      highest_combo: Math.max(0, e.stats.highest_combo),
      garbage_sent: mp.garbageSent,
      garbage_received: e.stats.garbage_received,
      garbage_cancelled: e.stats.garbage_cancelled,
      pieces_placed: e.piecesPlaced,
      pieces_per_second: Math.round((e.piecesPlaced / seconds) * 100) / 100,
    }
  }

  // ---------- snapshots ----------

  private snapshotFor(mp: MatchPlayer): PlayerStatePayload {
    const e = mp.engine
    return {
      player_id: mp.handle.playerId,
      tick: e.tick,
      board: e.boardStrings(),
      active_piece: e.activeInfo(),
      hold_piece: e.hold,
      next_pieces: e.nextPieces(),
      score: e.score,
      lines: e.lines,
      combo: e.combo,
      back_to_back: e.b2b,
      alive: e.alive,
      connected: mp.frozenAtRealTick === null && (mp.handle.isBot || mp.handle.getWs() !== null),
      pieces_placed: e.piecesPlaced,
      hash: e.lastLockHash,
      last_seq: mp.lastSeq,
      incoming_total: e.incomingTotal(),
    }
  }

  private broadcastSnapshot(mp: MatchPlayer): void {
    this.broadcast('player_state', this.snapshotFor(mp))
  }

  private maybeSnapshot(now: number): void {
    const rt = this.realTick(now)
    if (rt - this.lastSnapshotTick < OPPONENT_SNAPSHOT_EVERY_TICKS) return
    this.lastSnapshotTick = rt
    for (const id of this.order) this.broadcastSnapshot(this.players.get(id)!)
  }

  // ---------- disconnect / reconnect ----------

  handleDisconnect(playerId: string): void {
    const mp = this.players.get(playerId)
    if (!mp || this.status !== 'PLAYING') return
    if (!mp.engine.alive) return // spectators can drop without consequence
    if (mp.frozenAtRealTick !== null) return
    mp.frozenAtRealTick = this.realTick()
    this.broadcastSnapshot(mp) // shows connected=false
    mp.graceTimer = setTimeout(() => {
      mp.graceTimer = null
      this.eliminate(mp, 'disconnect_timeout', null, Date.now())
    }, RECONNECT_GRACE_MS)
  }

  /** Returns the full-state payload the reconnecting client needs. */
  handleReconnect(playerId: string): StateCorrectionPayload | null {
    const mp = this.players.get(playerId)
    if (!mp) return null
    if (mp.graceTimer) {
      clearTimeout(mp.graceTimer)
      mp.graceTimer = null
    }
    if (mp.frozenAtRealTick !== null) {
      // Freeze ends: everything the player missed becomes timeline lag.
      mp.tickLag += this.realTick() - mp.frozenAtRealTick
      mp.frozenAtRealTick = null
    }
    this.broadcastSnapshot(mp)
    return this.correctionFor(mp)
  }

  handleResyncRequest(playerId: string): StateCorrectionPayload | null {
    const mp = this.players.get(playerId)
    if (!mp || !mp.resyncBucket.take()) return null
    return this.correctionFor(mp)
  }

  private correctionFor(mp: MatchPlayer): StateCorrectionPayload {
    return {
      match_id: this.id,
      seed: this.seed,
      start_at: this.startAt,
      server_now: Date.now(),
      rules: { ...this.rules },
      your_player_id: mp.handle.playerId,
      your_tick: mp.engine.tick,
      your_engine: mp.engine.serialize(),
      players: this.playerInfos(),
      snapshots: this.order.map((id) => this.snapshotFor(this.players.get(id)!)),
      attacks_in_flight: [...this.attacks.values()]
        .filter((a) => a.status === 'PENDING')
        .map((a) => this.attackPayload(a)),
      eliminated: this.order
        .map((id) => this.players.get(id)!)
        .filter((p) => p.placement !== null && p.placement > 1)
        .map((p) => ({ player_id: p.handle.playerId, placement: p.placement! })),
    }
  }

  handleLeave(playerId: string): void {
    const mp = this.players.get(playerId)
    if (!mp || this.status !== 'PLAYING') return
    if (mp.engine.alive) this.eliminate(mp, 'left', null, Date.now())
  }

  // ---------- misc ----------

  private botSinks = new Map<string, <T extends S2CType>(type: T, payload: S2C[T]) => void>()

  attachBotSink(playerId: string, sink: <T extends S2CType>(type: T, payload: S2C[T]) => void): void {
    this.botSinks.set(playerId, sink)
  }

  private broadcast<T extends S2CType>(type: T, payload: S2C[T]): void {
    for (const mp of this.players.values()) {
      send(mp.handle.getWs(), type, payload)
    }
    for (const sink of this.botSinks.values()) sink(type, payload)
  }
}
