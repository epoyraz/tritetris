import type { PieceType } from './types'

export const PIECE_TYPES: PieceType[] = ['I', 'J', 'L', 'O', 'S', 'T', 'Z']

// Board cell value per piece (0 = empty, 8 = garbage)
export const PIECE_CELL: Record<PieceType, number> = {
  I: 1,
  J: 2,
  L: 3,
  O: 4,
  S: 5,
  T: 6,
  Z: 7,
}

// Spawn-orientation cells inside the piece's bounding box, y-down.
// I and O use a 4x4 box, the rest 3x3. O sits centered in a 4x4 box so the
// shared rotation formula leaves it unchanged.
const BASE_CELLS: Record<PieceType, { size: number; cells: [number, number][] }> = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 4, cells: [[1, 1], [2, 1], [1, 2], [2, 2]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
}

// PIECE_CELLS[type][rot] -> array of [x, y] cells relative to the box origin.
export const PIECE_CELLS: Record<PieceType, [number, number][][]> = {} as never

for (const type of PIECE_TYPES) {
  const { size, cells } = BASE_CELLS[type]
  const rots: [number, number][][] = [cells.map((c) => [...c] as [number, number])]
  for (let r = 1; r < 4; r++) {
    rots.push(rots[r - 1].map(([x, y]) => [size - 1 - y, x] as [number, number]))
  }
  // Normalize ordering so equality checks are stable.
  for (const rot of rots) rot.sort((a, b) => a[1] - b[1] || a[0] - b[0])
  PIECE_CELLS[type] = rots
}

export const SPAWN_X = 3
export function spawnY(type: PieceType): number {
  // Lowest occupied cell lands on row 3, the bottom row of the hidden buffer.
  return type === 'O' ? 1 : 2
}

// SRS wall kick data, guideline convention (y positive = up). Convert with
// boardDy = -tableDy when applying to a y-down board.
type KickTable = Record<string, [number, number][]>

const JLSTZ_KICKS: KickTable = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
}

const I_KICKS: KickTable = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
}

export function kicksFor(type: PieceType, from: number, to: number): [number, number][] {
  if (type === 'O') return [[0, 0]]
  const table = type === 'I' ? I_KICKS : JLSTZ_KICKS
  return table[`${from}>${to}`]
}
