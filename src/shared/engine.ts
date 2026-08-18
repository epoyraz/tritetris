import {
  ATTACK_BY_LINES,
  B2B_BONUS,
  BOARD_H,
  BOARD_W,
  GARBAGE_CELL,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  NEXT_PREVIEW,
  PERFECT_CLEAR_ATTACK,
  SCORE_BY_LINES,
  SCORE_COMBO,
  SCORE_HARD_DROP,
  SCORE_PERFECT_CLEAR,
  SCORE_SOFT_DROP,
  SCORE_TSPIN,
  SCORE_TSPIN_MINI,
  TICK_MS,
  TSPIN_ATTACK,
  TSPIN_MINI_ATTACK,
  comboBonus,
  gravityMsAtTick,
} from './constants'
import { PIECE_CELL, PIECE_CELLS, SPAWN_X, kicksFor, spawnY } from './pieces'
import { BagStream } from './rng'
import type {
  ActivePieceInfo,
  InputAction,
  PieceType,
  SerializedEngine,
  SerializedIncomingAttack,
} from './types'

export type TspinKind = 'none' | 'mini' | 'full'

export interface IncomingAttack {
  id: string
  sender: string
  lines: number
  holes: number[]
  createdTick: number
  arrivalTick: number
  inserted: boolean
  insertTick: number
  insertedLines: number
}

interface ClearEvent {
  tick: number
  seq: number // piecesPlaced at that lock, tie-break within a tick
  power: number
}

export interface LockEvent {
  kind: 'lock'
  tick: number
  piecesPlaced: number
  cleared: number
  tspin: TspinKind
  perfectClear: boolean
  combo: number
  b2bBonus: number
  attackTotal: number
  attackAfterCancel: number
  cancelled: { id: string; lines: number; sender: string }[]
  boardHash: number
}

export interface GarbageInsertedEvent {
  kind: 'garbage_inserted'
  tick: number
  attackId: string
  sender: string
  lines: number
  holes: number[]
  piecesPlaced: number
}

export interface TopoutEvent {
  kind: 'topout'
  tick: number
}

export type EngineEvent = LockEvent | GarbageInsertedEvent | TopoutEvent

interface ActivePiece {
  type: PieceType
  rot: number
  x: number
  y: number
  lowestY: number
}

function fnv1a(hash: number, value: number): number {
  hash ^= value
  return Math.imul(hash, 16777619) >>> 0
}

/**
 * Deterministic single-player Tetris simulation.
 *
 * The same engine runs on the client (immediate prediction) and on the server
 * (authoritative validation). Given the same seed, the same inputs at the same
 * ticks and the same announced garbage attacks, both instances stay
 * bit-identical — verified via board hashes at every piece lock.
 */
export class Engine {
  readonly seed: number
  board: number[][] // [y][x], y=0 is the top of the hidden buffer
  active: ActivePiece | null = null
  hold: PieceType | null = null
  canHold = true
  private bag: BagStream
  tick = 0
  private gravAccMs = 0
  private lockMs = 0
  private lockResets = 0
  private grounded = false
  private lastMoveWasRotate = false
  private lastRotateKickIndex = 0
  combo = -1
  b2b = false
  score = 0
  lines = 0
  piecesPlaced = 0
  alive = true
  incoming: IncomingAttack[] = []
  private clears: ClearEvent[] = []
  lastLockHash: number
  lastGarbageSender: string | null = null
  stats = {
    singles: 0,
    doubles: 0,
    triples: 0,
    tetrises: 0,
    t_spins: 0,
    perfect_clears: 0,
    highest_combo: 0,
    garbage_received: 0,
    garbage_cancelled: 0,
  }

  constructor(seed: number, spawnFirst = true) {
    this.seed = seed
    this.bag = new BagStream(seed)
    this.board = Array.from({ length: BOARD_H }, () => new Array<number>(BOARD_W).fill(0))
    this.lastLockHash = this.computeHash()
    if (spawnFirst) this.spawnNext([])
  }

  // ---------- geometry ----------

  private fits(type: PieceType, rot: number, x: number, y: number): boolean {
    for (const [cx, cy] of PIECE_CELLS[type][rot]) {
      const bx = x + cx
      const by = y + cy
      if (bx < 0 || bx >= BOARD_W || by < 0 || by >= BOARD_H) return false
      if (this.board[by][bx] !== 0) return false
    }
    return true
  }

  private isGrounded(): boolean {
    const a = this.active
    if (!a) return false
    return !this.fits(a.type, a.rot, a.x, a.y + 1)
  }

  ghostY(): number {
    const a = this.active
    if (!a) return 0
    let y = a.y
    while (this.fits(a.type, a.rot, a.x, y + 1)) y++
    return y
  }

  // ---------- garbage fold ----------

  /**
   * Recompute how much of each pending attack has been cancelled by this
   * player's line clears. Pure function of (attacks, clears), so client and
   * server converge even when an attack announcement arrives after the clear
   * that should cancel it: a clear at tick T cancels attacks created at or
   * before T, in creation order.
   */
  private foldRemaining(): Map<string, number> {
    const attacks = [...this.incoming].sort(
      (a, b) => a.createdTick - b.createdTick || a.arrivalTick - b.arrivalTick || (a.id < b.id ? -1 : 1),
    )
    const consumed = new Map<string, number>()
    for (const a of attacks) consumed.set(a.id, 0)
    const clears = [...this.clears].sort((a, b) => a.tick - b.tick || a.seq - b.seq)
    for (const c of clears) {
      let pool = c.power
      if (pool <= 0) continue
      for (const a of attacks) {
        if (a.createdTick > c.tick) continue
        if (a.inserted && c.tick >= a.insertTick) continue
        const cap = a.inserted ? a.lines - a.insertedLines : a.lines
        const avail = cap - consumed.get(a.id)!
        if (avail <= 0) continue
        const spend = Math.min(pool, avail)
        consumed.set(a.id, consumed.get(a.id)! + spend)
        pool -= spend
        if (pool <= 0) break
      }
    }
    const remaining = new Map<string, number>()
    for (const a of attacks) {
      const base = a.inserted ? 0 : a.lines - consumed.get(a.id)!
      remaining.set(a.id, Math.max(0, base))
    }
    return remaining
  }

  addIncoming(atk: SerializedIncomingAttack): void {
    if (this.incoming.some((a) => a.id === atk.id)) return // idempotent
    this.incoming.push({
      id: atk.id,
      sender: atk.sender,
      lines: atk.lines,
      holes: [...atk.holes],
      createdTick: atk.createdTick,
      arrivalTick: atk.arrivalTick,
      inserted: false,
      insertTick: 0,
      insertedLines: 0,
    })
  }

  /** Pending (announced, not yet inserted, not cancelled) garbage lines. */
  incomingTotal(): number {
    const remaining = this.foldRemaining()
    let total = 0
    for (const a of this.incoming) if (!a.inserted) total += remaining.get(a.id) ?? 0
    return total
  }

  incomingSummary(): { id: string; sender: string; remaining: number; arrivalTick: number }[] {
    const remaining = this.foldRemaining()
    return this.incoming
      .filter((a) => !a.inserted && (remaining.get(a.id) ?? 0) > 0)
      .sort((a, b) => a.arrivalTick - b.arrivalTick)
      .map((a) => ({ id: a.id, sender: a.sender, remaining: remaining.get(a.id)!, arrivalTick: a.arrivalTick }))
  }

  private pruneHistory(): void {
    const horizon = this.tick - 60 * 30 // 30 seconds
    this.clears = this.clears.filter((c) => c.tick > horizon)
    this.incoming = this.incoming.filter((a) => !a.inserted || a.insertTick > horizon)
  }

  // ---------- simulation ----------

  /** Advance the simulation up to and including `targetTick`. */
  advanceTo(targetTick: number): EngineEvent[] {
    const events: EngineEvent[] = []
    if (!this.alive) {
      this.tick = Math.max(this.tick, targetTick)
      return events
    }
    while (this.tick < targetTick && this.alive) {
      this.tick++
      this.stepTick(events)
    }
    return events
  }

  private stepTick(events: EngineEvent[]): void {
    if (!this.active) return
    this.gravAccMs += TICK_MS
    let gravity = gravityMsAtTick(this.tick)
    while (this.gravAccMs >= gravity && this.active) {
      this.gravAccMs -= gravity
      if (this.fits(this.active.type, this.active.rot, this.active.x, this.active.y + 1)) {
        this.active.y++
        this.lastMoveWasRotate = false
        this.onPieceLowered()
      } else {
        break
      }
      gravity = gravityMsAtTick(this.tick)
    }
    if (!this.active) return
    this.grounded = this.isGrounded()
    if (this.grounded) {
      // Don't bank gravity while resting — sliding off a ledge should drop
      // the piece one cell, not teleport it by the accumulated backlog.
      this.gravAccMs = Math.min(this.gravAccMs, gravity)
      this.lockMs += TICK_MS
      if (this.lockMs >= LOCK_DELAY_MS) {
        this.lockPiece(events)
      }
    }
  }

  private onPieceLowered(): void {
    const a = this.active!
    if (a.y > a.lowestY) {
      a.lowestY = a.y
      this.lockMs = 0
      this.lockResets = 0
    }
  }

  private moveReset(): void {
    if (this.isGrounded() && this.lockResets < MAX_LOCK_RESETS) {
      this.lockMs = 0
      this.lockResets++
    }
  }

  /** Advance to `tick`, then apply one input action. */
  applyAction(action: InputAction, tick: number): EngineEvent[] {
    const events = this.advanceTo(tick)
    if (!this.alive || !this.active) return events
    const a = this.active
    switch (action) {
      case 'MOVE_LEFT':
      case 'MOVE_RIGHT': {
        const dx = action === 'MOVE_LEFT' ? -1 : 1
        if (this.fits(a.type, a.rot, a.x + dx, a.y)) {
          a.x += dx
          this.lastMoveWasRotate = false
          this.moveReset()
        }
        break
      }
      case 'SOFT_DROP': {
        if (this.fits(a.type, a.rot, a.x, a.y + 1)) {
          a.y++
          this.score += SCORE_SOFT_DROP
          this.lastMoveWasRotate = false
          this.onPieceLowered()
        }
        break
      }
      case 'HARD_DROP': {
        let dropped = 0
        while (this.fits(a.type, a.rot, a.x, a.y + 1)) {
          a.y++
          dropped++
        }
        this.score += dropped * SCORE_HARD_DROP
        if (dropped > 0) this.lastMoveWasRotate = false
        this.lockPiece(events)
        break
      }
      case 'ROTATE_CW':
      case 'ROTATE_CCW': {
        const to = (a.rot + (action === 'ROTATE_CW' ? 1 : 3)) % 4
        const kicks = kicksFor(a.type, a.rot, to)
        for (let i = 0; i < kicks.length; i++) {
          const [kx, ky] = kicks[i]
          const nx = a.x + kx
          const ny = a.y - ky // kick tables are y-up, board is y-down
          if (this.fits(a.type, to, nx, ny)) {
            a.rot = to
            a.x = nx
            a.y = ny
            this.lastMoveWasRotate = true
            this.lastRotateKickIndex = i
            this.moveReset()
            this.onPieceLowered()
            break
          }
        }
        break
      }
      case 'HOLD': {
        if (!this.canHold) break
        const cur = a.type
        const next = this.hold ?? this.bag.draw()
        this.hold = cur
        this.canHold = false
        this.spawnPiece(next, events)
        break
      }
    }
    this.grounded = this.isGrounded()
    return events
  }

  // ---------- locking ----------

  private detectTspin(): TspinKind {
    const a = this.active!
    if (a.type !== 'T' || !this.lastMoveWasRotate) return 'none'
    const occupied = (x: number, y: number): boolean =>
      x < 0 || x >= BOARD_W || y < 0 || y >= BOARD_H || this.board[y][x] !== 0
    const corners: [number, number][] = [
      [a.x, a.y],
      [a.x + 2, a.y],
      [a.x, a.y + 2],
      [a.x + 2, a.y + 2],
    ]
    const filled = corners.map(([x, y]) => occupied(x, y))
    const count = filled.filter(Boolean).length
    if (count < 3) return 'none'
    // Front corners by rotation: 0 = up, 1 = right, 2 = down, 3 = left.
    const frontIdx: Record<number, [number, number]> = {
      0: [0, 1],
      1: [1, 3],
      2: [2, 3],
      3: [0, 2],
    }
    const [f1, f2] = frontIdx[a.rot]
    const full = (filled[f1] && filled[f2]) || this.lastRotateKickIndex === 4
    return full ? 'full' : 'mini'
  }

  private lockPiece(events: EngineEvent[]): void {
    const a = this.active!
    const tspin = this.detectTspin()

    for (const [cx, cy] of PIECE_CELLS[a.type][a.rot]) {
      this.board[a.y + cy][a.x + cx] = PIECE_CELL[a.type]
    }
    this.active = null
    this.piecesPlaced++

    // Clear lines
    let cleared = 0
    for (let y = BOARD_H - 1; y >= 0; y--) {
      if (this.board[y].every((c) => c !== 0)) {
        this.board.splice(y, 1)
        this.board.unshift(new Array<number>(BOARD_W).fill(0))
        cleared++
        y++ // re-check the row that shifted into this index
      }
    }

    const perfectClear = cleared > 0 && this.board.every((row) => row.every((c) => c === 0))

    // Combo / back-to-back
    let b2bBonus = 0
    if (cleared > 0) {
      this.combo++
      const eligible = cleared === 4 || tspin !== 'none'
      if (this.b2b && eligible) b2bBonus = B2B_BONUS
      this.b2b = eligible
      this.lines += cleared
      this.stats.highest_combo = Math.max(this.stats.highest_combo, this.combo)
      if (tspin === 'none') {
        if (cleared === 1) this.stats.singles++
        else if (cleared === 2) this.stats.doubles++
        else if (cleared === 3) this.stats.triples++
        else this.stats.tetrises++
      }
    } else {
      this.combo = -1
    }
    if (tspin !== 'none' && cleared > 0) this.stats.t_spins++
    if (perfectClear) this.stats.perfect_clears++

    // Attack per spec order: base -> t-spin -> b2b -> combo -> perfect clear
    let attackTotal = 0
    if (cleared > 0) {
      if (tspin === 'full') attackTotal = TSPIN_ATTACK[Math.min(cleared, 3)]
      else if (tspin === 'mini') attackTotal = TSPIN_MINI_ATTACK
      else attackTotal = ATTACK_BY_LINES[Math.min(cleared, 4)]
      attackTotal += b2bBonus
      attackTotal += comboBonus(this.combo)
      if (perfectClear) attackTotal += PERFECT_CLEAR_ATTACK
    }

    // Score (display only)
    if (cleared > 0 || tspin !== 'none') {
      let s: number
      if (tspin === 'full') s = SCORE_TSPIN[Math.min(cleared, 3)]
      else if (tspin === 'mini') s = SCORE_TSPIN_MINI[Math.min(cleared, 3)]
      else s = SCORE_BY_LINES[Math.min(cleared, 4)]
      if (b2bBonus > 0) s = Math.round(s * 1.5)
      if (this.combo > 0) s += this.combo * SCORE_COMBO
      if (perfectClear) s += SCORE_PERFECT_CLEAR
      this.score += s
    }

    // Cancel pending garbage with this attack
    let attackAfterCancel = attackTotal
    const cancelled: { id: string; lines: number; sender: string }[] = []
    if (attackTotal > 0) {
      const before = this.foldRemaining()
      this.clears.push({ tick: this.tick, seq: this.piecesPlaced, power: attackTotal })
      const after = this.foldRemaining()
      let spent = 0
      for (const atk of this.incoming) {
        if (atk.inserted) continue
        const diff = (before.get(atk.id) ?? 0) - (after.get(atk.id) ?? 0)
        if (diff > 0) {
          cancelled.push({ id: atk.id, lines: diff, sender: atk.sender })
          spent += diff
        }
      }
      attackAfterCancel = attackTotal - spent
      this.stats.garbage_cancelled += spent
    }

    // Garbage enters on a non-clearing lock once its arrival delay has passed.
    if (cleared === 0) {
      const remaining = this.foldRemaining()
      const due = this.incoming
        .filter((atk) => !atk.inserted && atk.arrivalTick <= this.tick && (remaining.get(atk.id) ?? 0) > 0)
        .sort((x, y) => x.arrivalTick - y.arrivalTick || x.createdTick - y.createdTick || (x.id < y.id ? -1 : 1))
      for (const atk of due) {
        const n = remaining.get(atk.id)!
        const holes = atk.holes.slice(0, n)
        this.insertGarbage(holes)
        atk.inserted = true
        atk.insertTick = this.tick
        atk.insertedLines = n
        this.stats.garbage_received += n
        this.lastGarbageSender = atk.sender
        events.push({
          kind: 'garbage_inserted',
          tick: this.tick,
          attackId: atk.id,
          sender: atk.sender,
          lines: n,
          holes,
          piecesPlaced: this.piecesPlaced,
        })
      }
    }

    const boardHash = this.computeHash()
    this.lastLockHash = boardHash

    events.push({
      kind: 'lock',
      tick: this.tick,
      piecesPlaced: this.piecesPlaced,
      cleared,
      tspin,
      perfectClear,
      combo: this.combo,
      b2bBonus,
      attackTotal,
      attackAfterCancel,
      cancelled,
      boardHash,
    })

    this.pruneHistory()
    this.canHold = true
    this.spawnNext(events)
  }

  private insertGarbage(holes: number[]): void {
    for (const hole of holes) {
      this.board.shift()
      const row = new Array<number>(BOARD_W).fill(GARBAGE_CELL)
      row[Math.max(0, Math.min(BOARD_W - 1, hole))] = 0
      this.board.push(row)
    }
  }

  private spawnNext(events: EngineEvent[]): void {
    this.spawnPiece(this.bag.draw(), events)
  }

  private spawnPiece(type: PieceType, events: EngineEvent[]): void {
    const piece: ActivePiece = { type, rot: 0, x: SPAWN_X, y: spawnY(type), lowestY: spawnY(type) }
    this.gravAccMs = 0
    this.lockMs = 0
    this.lockResets = 0
    this.lastMoveWasRotate = false
    this.lastRotateKickIndex = 0
    if (!this.fits(type, 0, piece.x, piece.y)) {
      // Block out: a newly spawned piece cannot legally enter the board.
      this.active = null
      this.alive = false
      events.push({ kind: 'topout', tick: this.tick })
      return
    }
    this.active = piece
    this.grounded = this.isGrounded()
  }

  // ---------- queries / serialization ----------

  computeHash(): number {
    let h = 2166136261
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) h = fnv1a(h, this.board[y][x])
    }
    h = fnv1a(h, this.piecesPlaced)
    return h >>> 0
  }

  nextPieces(n = NEXT_PREVIEW): PieceType[] {
    return this.bag.peek(n)
  }

  boardStrings(): string[] {
    return this.board.map((row) => row.join(''))
  }

  activeInfo(): ActivePieceInfo | null {
    const a = this.active
    return a ? { type: a.type, rot: a.rot, x: a.x, y: a.y } : null
  }

  serialize(): SerializedEngine {
    const remaining = this.foldRemaining()
    return {
      seed: this.seed,
      board: this.boardStrings(),
      active: this.active ? { ...this.activeInfo()!, lowestY: this.active.lowestY } : null,
      hold: this.hold,
      canHold: this.canHold,
      drawn: this.bag.drawnCount,
      tick: this.tick,
      gravAccMs: this.gravAccMs,
      lockMs: this.lockMs,
      lockResets: this.lockResets,
      grounded: this.grounded,
      lastMoveWasRotate: this.lastMoveWasRotate,
      lastRotateKickIndex: this.lastRotateKickIndex,
      combo: this.combo,
      b2b: this.b2b,
      score: this.score,
      lines: this.lines,
      piecesPlaced: this.piecesPlaced,
      alive: this.alive,
      // Only uninserted attacks with folded remaining > 0 matter for future
      // simulation; cancellation history is collapsed into `remaining`.
      incoming: this.incoming
        .filter((a) => !a.inserted && (remaining.get(a.id) ?? 0) > 0)
        .map((a) => ({
          id: a.id,
          sender: a.sender,
          lines: a.lines,
          remaining: remaining.get(a.id)!,
          holes: [...a.holes],
          createdTick: a.createdTick,
          arrivalTick: a.arrivalTick,
        })),
      lastLockHash: this.lastLockHash,
      stats: { ...this.stats },
    }
  }

  static deserialize(s: SerializedEngine): Engine {
    const e = new Engine(s.seed, false)
    e.board = s.board.map((row) => row.split('').map((c) => parseInt(c, 10)))
    e.active = s.active
      ? { type: s.active.type, rot: s.active.rot, x: s.active.x, y: s.active.y, lowestY: s.active.lowestY }
      : null
    e.hold = s.hold
    e.canHold = s.canHold
    e.bag = BagStream.atPosition(s.seed, s.drawn)
    e.tick = s.tick
    e.gravAccMs = s.gravAccMs
    e.lockMs = s.lockMs
    e.lockResets = s.lockResets
    e.grounded = s.grounded
    e.lastMoveWasRotate = s.lastMoveWasRotate
    e.lastRotateKickIndex = s.lastRotateKickIndex
    e.combo = s.combo
    e.b2b = s.b2b
    e.score = s.score
    e.lines = s.lines
    e.piecesPlaced = s.piecesPlaced
    e.alive = s.alive
    // Prior cancellation history was collapsed into `remaining` at serialize
    // time: the attack re-enters the fold with lines = remaining and an empty
    // clear log. Full hole lists are kept so partial insertions still slice
    // the same server-generated columns.
    e.incoming = s.incoming
      .filter((a) => a.remaining > 0)
      .map((a) => ({
        id: a.id,
        sender: a.sender,
        lines: a.remaining,
        holes: [...a.holes],
        createdTick: a.createdTick,
        arrivalTick: a.arrivalTick,
        inserted: false,
        insertTick: 0,
        insertedLines: 0,
      }))
    e.clears = []
    e.lastLockHash = s.lastLockHash
    e.stats = { ...s.stats }
    return e
  }
}
