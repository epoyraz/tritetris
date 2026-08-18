import { randomBytes, randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { Envelope, S2C, S2CType } from '../shared/types'

export function uuid(): string {
  return randomUUID()
}

export function sessionToken(): string {
  return randomBytes(24).toString('base64url')
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/1/I confusion

export function joinCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return code
}

export function send<T extends S2CType>(ws: WebSocket | null | undefined, type: T, payload: S2C[T]): void {
  if (!ws || ws.readyState !== ws.OPEN) return
  const env: Envelope<T, S2C[T]> = {
    type,
    message_id: randomUUID(),
    timestamp: Date.now(),
    payload,
  }
  ws.send(JSON.stringify(env))
}

export function sendError(ws: WebSocket | null | undefined, code: string, message: string): void {
  send(ws, 'error', { code, message })
}

/** Simple token bucket rate limiter. */
export class TokenBucket {
  private tokens: number
  private last: number

  constructor(
    private ratePerSec: number,
    private burst: number,
  ) {
    this.tokens = burst
    this.last = Date.now()
  }

  take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec)
    this.last = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }
}
