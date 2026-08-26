import { Engine } from '../shared/engine'
import { BOARD_H, BOARD_W, LOCK_DELAY_MS, TICK_MS } from '../shared/constants'
import { PIECE_CELLS } from '../shared/pieces'
import type { BotTier, InputAction, PieceType, S2C, S2CType } from '../shared/types'
import type { ServerMatch } from './match'

export const BOT_NAMES = ['Rex', 'Iva', 'Zoe', 'Max', 'Kai', 'Lux']

export function botDisplayName(base: string, tier: BotTier): string {
  const tag = tier === 'easy' ? 'Easy' : tier === 'medium' ? 'Medium' : 'Hard'
  return `🤖 ${base} · ${tag}`
}

interface TierConfig {
  thinkMinMs: number // pause before starting to place each piece
  thinkMaxMs: number
  actionMs: number // delay between individual key presses
  topN: number // pick randomly among the N best placements (1 = always best)
  useHold: boolean
  weights: { clear: number; agg: number; holes: number; bump: number }
}

const TIERS: Record<BotTier, TierConfig> = {
  easy: {
    thinkMinMs: 1300,
    thinkMaxMs: 2100,
    actionMs: 95,
    topN: 6,
    useHold: false,
    weights: { clear: 4, agg: 0.5, holes: 1.1, bump: 0.3 },
  },
  medium: {
    thinkMinMs: 600,
    thinkMaxMs: 950,
    actionMs: 45,
    topN: 1,
    useHold: false,
    weights: { clear: 8, agg: 0.6, holes: 2.5, bump: 0.4 },
  },
  hard: {
    thinkMinMs: 200,
    thinkMaxMs: 340,
    actionMs: 18,
    topN: 1,
    useHold: true,
    weights: { clear: 10, agg: 0.55, holes: 3.2, bump: 0.35 },
  },
}

interface Placement {
  rotations: number
  x: number
  score: number
}

function evaluatePlacements(board: number[][], type: PieceType, w: TierConfig['weights']): Placement[] {
  const out: Placement[] = []
  for (let rot = 0; rot < 4; rot++) {
    const cells = PIECE_CELLS[type][rot]
    const minX = -Math.min(...cells.map(([cx]) => cx))
    const maxX = BOARD_W - 1 - Math.max(...cells.map(([cx]) => cx))
    for (let x = minX; x <= maxX; x++) {
      const fits = (y: number): boolean =>
        cells.every(([cx, cy]) => {
          const by = y + cy
          const bx = x + cx
          return by >= 0 && by < BOARD_H && bx >= 0 && bx < BOARD_W && board[by][bx] === 0
        })
      if (!fits(0)) continue
      let y = 0
      while (fits(y + 1)) y++
      const sim = board.map((r) => [...r])
      for (const [cx, cy] of cells) sim[y + cy][x + cx] = 9
      let cleared = 0
      for (let by = BOARD_H - 1; by >= 0; by--) {
        if (sim[by].every((c) => c !== 0)) {
          sim.splice(by, 1)
          sim.unshift(new Array<number>(BOARD_W).fill(0))
          cleared++
          by++
        }
      }
      const heights: number[] = []
      let holes = 0
      for (let bx = 0; bx < BOARD_W; bx++) {
        let top = -1
        for (let by = 0; by < BOARD_H; by++) {
          if (sim[by][bx] !== 0) {
            top = by
            break
          }
        }
        heights.push(top === -1 ? 0 : BOARD_H - top)
        if (top !== -1) {
          for (let by = top + 1; by < BOARD_H; by++) if (sim[by][bx] === 0) holes++
        }
      }
      const agg = heights.reduce((a, b) => a + b, 0)
      let bump = 0
      for (let i = 0; i < heights.length - 1; i++) bump += Math.abs(heights[i] - heights[i + 1])
      out.push({ rotations: rot, x, score: cleared * w.clear - agg * w.agg - holes * w.holes - bump * w.bump })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * A server-side bot player. It drives inputs through the exact same
 * `handleInput` path a real client uses (own prediction engine, real tick
 * stamps, monotonic sequences), so validation, garbage and elimination all
 * behave identically for bots and humans.
 */
export class ServerBot {
  private engine: Engine
  private cfg: TierConfig
  private seq = 0
  private stopped = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private match: ServerMatch,
    private playerId: string,
    tier: BotTier,
  ) {
    this.cfg = TIERS[tier]
    this.engine = new Engine(match.seed)
  }

  start(): void {
    this.schedule(this.cfg.thinkMaxMs + Math.random() * 400)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Receives every match broadcast (the bot's "socket"). */
  onMessage<T extends S2CType>(type: T, payload: S2C[T]): void {
    if (type === 'attack_created') {
      const p = payload as S2C['attack_created']
      if (p.target_player_id === this.playerId) {
        this.engine.addIncoming({
          id: p.attack_id,
          sender: p.sender_player_id,
          lines: p.line_count,
          remaining: p.line_count,
          holes: p.holes,
          createdTick: p.created_tick,
          arrivalTick: p.arrival_tick,
        })
      }
    }
  }

  private curTick(): number {
    const t = Math.floor((Date.now() - this.match.startAt) / TICK_MS)
    return Math.max(0, t, this.engine.tick)
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.step(), ms)
  }

  private act(action: InputAction): void {
    const tick = this.curTick()
    this.engine.applyAction(action, tick)
    this.seq++
    this.match.handleInput(this.playerId, {
      match_id: this.match.id,
      sequence: this.seq,
      action,
      client_time: Date.now(),
      tick,
    })
  }

  private step(): void {
    if (this.stopped) return
    if (this.match.status !== 'PLAYING') {
      this.schedule(300)
      return
    }
    this.engine.advanceTo(this.curTick())
    if (!this.engine.alive) {
      this.stop()
      return
    }
    if (!this.engine.active) {
      this.schedule(120)
      return
    }

    const current = this.engine.active.type
    let candidates = evaluatePlacements(this.engine.board, current, this.cfg.weights)
    let holdFirst = false
    if (this.cfg.useHold && this.engine.canHold) {
      const alt = this.engine.hold ?? this.engine.nextPieces(1)[0]
      if (alt && alt !== current) {
        const altCandidates = evaluatePlacements(this.engine.board, alt, this.cfg.weights)
        if (altCandidates.length > 0 && (candidates.length === 0 || altCandidates[0].score > candidates[0].score + 1.5)) {
          holdFirst = true
          candidates = altCandidates
        }
      }
    }
    if (candidates.length === 0) {
      // Nowhere to go: drop in place and hope.
      this.executePlan([], this.engine.active.x)
      return
    }
    const pool = candidates.slice(0, Math.max(1, Math.min(this.cfg.topN, candidates.length)))
    const plan = pool[Math.floor(Math.random() * pool.length)]

    const actions: InputAction[] = []
    if (holdFirst) actions.push('HOLD')
    for (let i = 0; i < plan.rotations; i++) actions.push('ROTATE_CW')
    this.executePlan(actions, plan.x)
  }

  /** Runs queued rotations, then steers to the target column, then drops. */
  private executePlan(pending: InputAction[], targetX: number, guard = 18): void {
    if (this.stopped) return
    if (this.match.status !== 'PLAYING' || !this.engine.alive) {
      this.stop()
      return
    }
    const next = (): void => {
      this.timer = setTimeout(() => this.executePlan(pending, targetX, guard - 1), this.cfg.actionMs)
    }
    if (pending.length > 0) {
      this.act(pending.shift()!)
      next()
      return
    }
    const active = this.engine.active
    if (!active) {
      // Piece locked mid-plan (gravity); think about the next one.
      this.schedule(this.cfg.thinkMinMs + Math.random() * (this.cfg.thinkMaxMs - this.cfg.thinkMinMs))
      return
    }
    if (active.x !== targetX && guard > 0) {
      this.act(active.x > targetX ? 'MOVE_LEFT' : 'MOVE_RIGHT')
      next()
      return
    }
    if (this.match.rules.allow_hard_drop) {
      this.act('HARD_DROP')
      this.schedule(this.cfg.thinkMinMs + Math.random() * (this.cfg.thinkMaxMs - this.cfg.thinkMinMs))
      return
    }
    // Hard drop disabled: ride soft drops to the floor, then let lock delay run.
    if (active.y < this.engine.ghostY()) {
      this.act('SOFT_DROP')
      this.timer = setTimeout(() => this.executePlan([], targetX, guard), Math.max(this.cfg.actionMs, 25))
      return
    }
    this.schedule(LOCK_DELAY_MS + 120 + this.cfg.thinkMinMs)
  }
}
