import { PIECE_TYPES } from './pieces'
import type { PieceType } from './types'

// Deterministic PRNG (mulberry32). Client and server both derive the piece
// stream from the match seed, so all players see the same 7-bag sequence.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class BagStream {
  private rng: () => number
  private bag: PieceType[] = []
  drawnCount = 0

  constructor(seed: number) {
    this.rng = mulberry32(seed)
  }

  private refill(): void {
    const bag = [...PIECE_TYPES]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j], bag[i]]
    }
    this.bag.push(...bag)
  }

  draw(): PieceType {
    if (this.bag.length === 0) this.refill()
    this.drawnCount++
    return this.bag.shift()!
  }

  peek(n: number): PieceType[] {
    while (this.bag.length < n) this.refill()
    return this.bag.slice(0, n)
  }

  // Rebuild a stream that has already drawn `count` pieces (for resync).
  static atPosition(seed: number, count: number): BagStream {
    const s = new BagStream(seed)
    for (let i = 0; i < count; i++) s.draw()
    return s
  }
}
