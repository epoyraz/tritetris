import { BOARD_W, BUFFER_H, VISIBLE_H, speedLevelAtTick } from '../shared/constants'
import { PIECE_CELLS } from '../shared/pieces'
import type { PieceType, PlayerStatePayload } from '../shared/types'
import type { GameSession } from './session'

export const CELL_COLORS: Record<number, string> = {
  1: '#00d5ff', // I
  2: '#3861ff', // J
  3: '#ff9e1a', // L
  4: '#ffd60a', // O
  5: '#2ee06a', // S
  6: '#b45bff', // T
  7: '#ff3b57', // Z
  8: '#6d7482', // garbage
}

const BOARD_BG = '#0a0d14'
const GRID = 'rgba(255,255,255,0.045)'
const FRAME = '#232a3a'

function drawCell(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, dim = false): void {
  ctx.fillStyle = color
  ctx.globalAlpha = dim ? 0.45 : 1
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2)
  if (!dim && size >= 12) {
    ctx.globalAlpha = 0.28
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x + 1, y + 1, size - 2, Math.max(2, size * 0.18))
  }
  ctx.globalAlpha = 1
}

function drawBoardFrame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = BOARD_BG
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = FRAME
  ctx.lineWidth = 2
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2)
}

function drawGrid(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number): void {
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < BOARD_W; i++) {
    ctx.moveTo(x + i * cell + 0.5, y)
    ctx.lineTo(x + i * cell + 0.5, y + VISIBLE_H * cell)
  }
  for (let j = 1; j < VISIBLE_H; j++) {
    ctx.moveTo(x, y + j * cell + 0.5)
    ctx.lineTo(x + BOARD_W * cell, y + j * cell + 0.5)
  }
  ctx.stroke()
}

function cellAt(rows: number[][] | string[], y: number, x: number): number {
  const row = rows[y]
  return typeof row === 'string' ? row.charCodeAt(x) - 48 : row[x]
}

function drawMatrix(ctx: CanvasRenderingContext2D, rows: number[][] | string[], x: number, y: number, cell: number, dim = false): void {
  for (let by = BUFFER_H; by < BUFFER_H + VISIBLE_H; by++) {
    for (let bx = 0; bx < BOARD_W; bx++) {
      const v = cellAt(rows, by, bx)
      if (v !== 0) drawCell(ctx, x + bx * cell, y + (by - BUFFER_H) * cell, cell, CELL_COLORS[v] ?? '#888', dim)
    }
  }
}

function drawPieceCells(
  ctx: CanvasRenderingContext2D,
  type: PieceType,
  rot: number,
  px: number,
  py: number,
  originX: number,
  originY: number,
  cell: number,
  opts: { ghost?: boolean; dim?: boolean } = {},
): void {
  const color = CELL_COLORS[{ I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 }[type]]
  for (const [cx, cy] of PIECE_CELLS[type][rot]) {
    const by = py + cy
    const bx = px + cx
    if (by < BUFFER_H) continue // hidden buffer rows are not rendered
    const sx = originX + bx * cell
    const sy = originY + (by - BUFFER_H) * cell
    if (opts.ghost) {
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 2
      ctx.strokeRect(sx + 2, sy + 2, cell - 4, cell - 4)
      ctx.globalAlpha = 1
    } else {
      drawCell(ctx, sx, sy, cell, color, opts.dim)
    }
  }
}

function drawPreview(ctx: CanvasRenderingContext2D, type: PieceType | null, x: number, y: number, w: number, h: number, cell: number): void {
  ctx.fillStyle = '#10141f'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = FRAME
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  if (!type) return
  const cells = PIECE_CELLS[type][0]
  const minX = Math.min(...cells.map(([cx]) => cx))
  const maxX = Math.max(...cells.map(([cx]) => cx))
  const minY = Math.min(...cells.map(([, cy]) => cy))
  const maxY = Math.max(...cells.map(([, cy]) => cy))
  const pw = (maxX - minX + 1) * cell
  const ph = (maxY - minY + 1) * cell
  const ox = x + (w - pw) / 2 - minX * cell
  const oy = y + (h - ph) / 2 - minY * cell
  const color = CELL_COLORS[{ I: 1, J: 2, L: 3, O: 4, S: 5, T: 6, Z: 7 }[type]]
  for (const [cx, cy] of cells) drawCell(ctx, ox + cx * cell, oy + cy * cell, cell, color)
}

function overlay(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha = 0.62): void {
  ctx.fillStyle = `rgba(5,7,12,${alpha})`
  ctx.fillRect(x, y, w, h)
}

function centerText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, font: string, color: string): void {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

// ---------------- own board ----------------

export const OWN_W = 470
export const OWN_H = 566

export function drawOwn(ctx: CanvasRenderingContext2D, session: GameSession, myName: string): void {
  const cell = 26
  const bx = 122
  const by = 24
  const bw = BOARD_W * cell
  const bh = VISIBLE_H * cell
  ctx.clearRect(0, 0, OWN_W, OWN_H)
  const e = session.engine
  ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
  ctx.fillStyle = '#8a93a6'
  ctx.fillText('HOLD', 12, 18)
  ctx.fillText('NEXT', bx + bw + 14, 18)
  drawPreview(ctx, e?.hold ?? null, 12, 24, 84, 66, 16)
  if (e && !e.canHold) {
    overlay(ctx, 12, 24, 84, 66, 0.45)
  }

  drawBoardFrame(ctx, bx, by, bw, bh)
  drawGrid(ctx, bx, by, cell)

  if (e) {
    drawMatrix(ctx, e.board, bx, by, cell, !e.alive)
    if (e.active && e.alive) {
      const ghostY = e.ghostY()
      drawPieceCells(ctx, e.active.type, e.active.rot, e.active.x, ghostY, bx, by, cell, { ghost: true })
      drawPieceCells(ctx, e.active.type, e.active.rot, e.active.x, e.active.y, bx, by, cell)
    }
    // next queue
    const next = e.nextPieces()
    for (let i = 0; i < next.length; i++) {
      drawPreview(ctx, next[i], bx + bw + 14, 24 + i * 62, 74, 54, i === 0 ? 14 : 12)
    }
    // garbage meter
    const meterX = bx - 14
    ctx.fillStyle = '#10141f'
    ctx.fillRect(meterX, by, 10, bh)
    let segY = by + bh
    const tick = session.curTick()
    for (const seg of e.incomingSummary()) {
      const h = seg.remaining * cell
      segY -= h
      ctx.fillStyle = seg.arrivalTick <= tick ? '#ff3b57' : '#ffb020'
      ctx.fillRect(meterX + 1, Math.max(by, segY + 1), 8, Math.min(h - 2, segY + h - by))
      segY -= 3
    }
    // HUD
    ctx.fillStyle = '#e8ecf4'
    ctx.font = '700 15px "Segoe UI", system-ui, sans-serif'
    ctx.fillText(myName, 12, 116)
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = '#8a93a6'
    const hud: [string, string][] = [
      ['SCORE', String(e.score)],
      ['LINES', String(e.lines)],
      ['COMBO', e.combo > 0 ? `x${e.combo}` : '—'],
      ['B2B', e.b2b ? 'YES' : '—'],
      ['SPEED', `LV ${speedLevelAtTick(e.tick)}`],
      ['PIECES', String(e.piecesPlaced)],
    ]
    hud.forEach(([label, value], i) => {
      const y = 146 + i * 42
      ctx.fillStyle = '#8a93a6'
      ctx.fillText(label, 12, y)
      ctx.fillStyle = '#e8ecf4'
      ctx.font = '700 17px "Segoe UI", system-ui, sans-serif'
      ctx.fillText(value, 12, y + 20)
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif'
    })
  }

  // effects
  const now = performance.now()
  let floatIdx = 0
  for (const fx of session.effects) {
    if (fx.kind === 'pulse') {
      const age = now - fx.born
      if (age < 300) {
        ctx.strokeStyle = fx.color
        ctx.globalAlpha = 1 - age / 300
        ctx.lineWidth = 5
        ctx.strokeRect(bx - 2, by - 2, bw + 4, bh + 4)
        ctx.globalAlpha = 1
      }
    } else {
      const age = now - fx.born
      if (age >= 0 && age < 1100) {
        const t = age / 1100
        ctx.globalAlpha = 1 - t
        centerText(
          ctx,
          fx.text,
          bx + bw / 2,
          by + bh * 0.42 - t * 46 + floatIdx * 22,
          '800 20px "Segoe UI", system-ui, sans-serif',
          fx.color,
        )
        ctx.globalAlpha = 1
        floatIdx++
      }
    }
  }

  // countdown / status overlays over the board region
  const msLeft = session.countdownMsLeft()
  if (!session.started || msLeft > 0) {
    overlay(ctx, bx, by, bw, bh)
    const n = Math.ceil(msLeft / 1000)
    centerText(
      ctx,
      msLeft > 0 ? String(Math.max(1, n)) : 'READY',
      bx + bw / 2,
      by + bh / 2,
      '800 64px "Segoe UI", system-ui, sans-serif',
      '#00d5ff',
    )
  } else if (msLeft > -700) {
    centerText(ctx, 'GO!', bx + bw / 2, by + bh / 2, '800 64px "Segoe UI", system-ui, sans-serif', '#27e05c')
  }

  if (e && !e.alive) {
    overlay(ctx, bx, by, bw, bh)
    const placement = session.eliminated.get(session.myId)
    centerText(ctx, "YOU'RE OUT", bx + bw / 2, by + bh / 2 - 18, '800 34px "Segoe UI", system-ui, sans-serif', '#ff3b57')
    if (placement) {
      centerText(ctx, `placed #${placement} — spectating`, bx + bw / 2, by + bh / 2 + 20, '600 15px "Segoe UI", system-ui, sans-serif', '#aab3c5')
    }
  } else if (session.winnerId && session.winnerId === session.myId) {
    overlay(ctx, bx, by, bw, bh, 0.4)
    centerText(ctx, 'VICTORY!', bx + bw / 2, by + bh / 2, '800 40px "Segoe UI", system-ui, sans-serif', '#ffd60a')
  }
}

// ---------------- opponent boards ----------------

export const OPP_W = 190
export const OPP_H = 434

export function drawOpponent(ctx: CanvasRenderingContext2D, snap: PlayerStatePayload | null, name: string, session: GameSession): void {
  ctx.clearRect(0, 0, OPP_W, OPP_H)
  const cell = 14
  const bx = 32
  const by = 34
  const bw = BOARD_W * cell
  const bh = VISIBLE_H * cell
  centerText(ctx, name, OPP_W / 2, 16, '700 14px "Segoe UI", system-ui, sans-serif', '#e8ecf4')
  drawBoardFrame(ctx, bx, by, bw, bh)
  if (!snap) {
    centerText(ctx, 'waiting…', bx + bw / 2, by + bh / 2, '600 13px "Segoe UI", system-ui, sans-serif', '#5c6577')
    return
  }
  const dead = !snap.alive
  drawMatrix(ctx, snap.board, bx, by, cell, dead)
  if (snap.active_piece && snap.alive) {
    drawPieceCells(ctx, snap.active_piece.type, snap.active_piece.rot, snap.active_piece.x, snap.active_piece.y, bx, by, cell, {})
  }
  // incoming meter
  ctx.fillStyle = '#10141f'
  ctx.fillRect(bx - 10, by, 6, bh)
  if (snap.incoming_total > 0) {
    const h = Math.min(bh, snap.incoming_total * cell)
    ctx.fillStyle = '#ffb020'
    ctx.fillRect(bx - 9, by + bh - h, 4, h)
  }
  // HUD
  ctx.font = '600 11px "Segoe UI", system-ui, sans-serif'
  ctx.fillStyle = '#8a93a6'
  ctx.fillText(`SCORE ${snap.score}`, bx, by + bh + 18)
  ctx.fillText(`LINES ${snap.lines}`, bx, by + bh + 34)
  if (snap.incoming_total > 0) {
    ctx.fillStyle = '#ffb020'
    ctx.fillText(`INCOMING ${snap.incoming_total}`, bx + 78, by + bh + 18)
  }
  if (dead) {
    overlay(ctx, bx, by, bw, bh)
    const placement = session.eliminated.get(snap.player_id)
    centerText(ctx, 'KO', bx + bw / 2, by + bh / 2 - 8, '800 30px "Segoe UI", system-ui, sans-serif', '#ff3b57')
    if (placement) {
      centerText(ctx, `#${placement}`, bx + bw / 2, by + bh / 2 + 20, '700 15px "Segoe UI", system-ui, sans-serif', '#aab3c5')
    }
  } else if (!snap.connected) {
    overlay(ctx, bx, by, bw, bh, 0.5)
    centerText(ctx, 'Reconnecting…', bx + bw / 2, by + bh / 2, '600 13px "Segoe UI", system-ui, sans-serif', '#ffb020')
  } else if (session.winnerId === snap.player_id) {
    overlay(ctx, bx, by, bw, bh, 0.35)
    centerText(ctx, 'WINNER', bx + bw / 2, by + bh / 2, '800 22px "Segoe UI", system-ui, sans-serif', '#ffd60a')
  }
}
