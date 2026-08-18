// Engine unit tests. Run with: npm run test:engine
import { Engine } from '../src/shared/engine'
import { BagStream } from '../src/shared/rng'
import { PIECE_CELLS } from '../src/shared/pieces'
import { BOARD_H, BOARD_W, GARBAGE_CELL, comboBonus } from '../src/shared/constants'
import type { InputAction, PieceType } from '../src/shared/types'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function findSeed(firstPiece: PieceType): number {
  for (let seed = 1; seed < 5000; seed++) {
    const bag = new BagStream(seed)
    if (bag.draw() === firstPiece) return seed
  }
  throw new Error('no seed found')
}

function fillRow(e: Engine, y: number, except: number[] = []): void {
  for (let x = 0; x < BOARD_W; x++) e.board[y][x] = except.includes(x) ? 0 : GARBAGE_CELL
}

// A block that never joins a full row, to keep perfect-clear bonuses out of
// tests that aren't about perfect clears. Row 19, col 8 stays clear of the
// spawn columns and the left-wall burn zone used below.
function addStray(e: Engine): void {
  e.board[19][8] = GARBAGE_CELL
}

// ---------- 1. bag determinism & validity ----------
{
  const a = new BagStream(1234)
  const b = new BagStream(1234)
  const seqA = Array.from({ length: 70 }, () => a.draw())
  const seqB = Array.from({ length: 70 }, () => b.draw())
  check('bag: same seed produces same sequence', seqA.join('') === seqB.join(''))
  let valid = true
  for (let i = 0; i < 70; i += 7) {
    const window = seqA.slice(i, i + 7).sort().join('')
    if (window !== 'IJLOSTZ') valid = false
  }
  check('bag: every 7-window is a full permutation', valid)
  const c = BagStream.atPosition(1234, 30)
  check('bag: atPosition resumes the stream', c.draw() === seqA[30])
}

// ---------- 2. SRS wall kick ----------
{
  const e = new Engine(findSeed('I'))
  check('kick: first piece is I', e.active!.type === 'I')
  e.applyAction('ROTATE_CW', 0)
  check('kick: I spawn rotates CW in place', e.active!.rot === 1 && e.active!.x === 3)
  for (let i = 0; i < 5; i++) e.applyAction('MOVE_RIGHT', 0)
  check('kick: vertical I stops at right wall (x=7)', e.active!.x === 7, `x=${e.active!.x}`)
  e.applyAction('ROTATE_CW', 0)
  check('kick: I 1->2 at wall kicks left', e.active!.rot === 2 && e.active!.x === 6, `rot=${e.active!.rot} x=${e.active!.x}`)
}

// ---------- 3. single clear -> attack 1 ----------
{
  const e = new Engine(findSeed('I'))
  addStray(e)
  fillRow(e, BOARD_H - 1, [3, 4, 5, 6]) // bottom row open exactly where the flat I lands
  const events = e.applyAction('HARD_DROP', 0)
  const lock = events.find((ev) => ev.kind === 'lock')
  check('clear: flat I completes bottom row', lock?.kind === 'lock' && lock.cleared === 1, JSON.stringify(lock))
  check('clear: single sends 1 attack', lock?.kind === 'lock' && lock.attackTotal === 1)
  check('clear: combo starts at 0 after first clear', lock?.kind === 'lock' && lock.combo === 0)
}

// ---------- 4. tetris + back-to-back ----------
{
  const e = new Engine(findSeed('I'))
  addStray(e)
  for (let y = BOARD_H - 4; y < BOARD_H; y++) fillRow(e, y, [9])
  e.applyAction('ROTATE_CW', 0)
  for (let i = 0; i < 5; i++) e.applyAction('MOVE_RIGHT', 0)
  const ev1 = e.applyAction('HARD_DROP', 0)
  const lock1 = ev1.find((ev) => ev.kind === 'lock')
  check('tetris: clears 4 lines', lock1?.kind === 'lock' && lock1.cleared === 4, JSON.stringify(lock1))
  check('tetris: base attack 4', lock1?.kind === 'lock' && lock1.attackTotal === 4)
  check('tetris: sets b2b', e.b2b === true)

  // Burn non-I pieces on the far left (no clears), then tetris again for b2b.
  for (let y = BOARD_H - 4; y < BOARD_H; y++) fillRow(e, y, [9])
  while (e.active !== null && e.active.type !== 'I') {
    for (let i = 0; i < 5; i++) e.applyAction('MOVE_LEFT', 0)
    e.applyAction('HARD_DROP', 0)
  }
  check('tetris: another I arrived without topping out', e.active !== null && e.active.type === 'I')
  e.applyAction('ROTATE_CW', 0)
  for (let i = 0; i < 5; i++) e.applyAction('MOVE_RIGHT', 0)
  const ev2 = e.applyAction('HARD_DROP', 0)
  const lock2 = ev2.find((ev) => ev.kind === 'lock')
  check(
    'tetris: b2b tetris sends 5 (4 base + 1 b2b)',
    lock2?.kind === 'lock' && lock2.cleared === 4 && lock2.attackTotal === 5,
    JSON.stringify(lock2),
  )
}

// ---------- 5. combo bonus table ----------
{
  check(
    'combo: bonus table matches spec',
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 11].map(comboBonus).join(',') === '0,0,1,1,2,2,3,3,4,4',
  )
  const e = new Engine(findSeed('I'))
  const expected: number[] = []
  const got: number[] = []
  for (let n = 0; n < 5; n++) {
    // Reset the well each time: stray block + a bottom row carved to exactly
    // the active piece's landing footprint, so every drop clears one line.
    e.board.forEach((row) => row.fill(0))
    addStray(e)
    const a = e.active!
    const gy = e.ghostY()
    const bottomCells = PIECE_CELLS[a.type][a.rot]
      .filter(([, cy]) => gy + cy === BOARD_H - 1)
      .map(([cx]) => a.x + cx)
    fillRow(e, BOARD_H - 1, bottomCells)
    const ev = e.applyAction('HARD_DROP', 0)
    const lock = ev.find((x) => x.kind === 'lock')
    if (lock?.kind === 'lock') {
      got.push(lock.attackTotal)
      expected.push(1 + comboBonus(n)) // single + combo bonus at combo n
    }
  }
  check('combo: consecutive singles follow the combo table', got.join(',') === expected.join(','), `got=${got} want=${expected}`)
}

// ---------- 6. T-spin double ----------
{
  const e = new Engine(findSeed('T'))
  const x0 = 0
  const y0 = BOARD_H - 3 // slot occupies the bottom two rows
  e.board.forEach((row) => row.fill(0))
  e.board[y0][x0] = GARBAGE_CELL // overhang corner
  fillRow(e, y0 + 1, [x0, x0 + 1, x0 + 2])
  fillRow(e, y0 + 2, [x0 + 1])
  e.active = { type: 'T', rot: 1, x: x0, y: y0, lowestY: y0 }
  e.applyAction('ROTATE_CW', 0)
  check(
    'tspin: rotation into slot succeeds',
    e.active !== null && e.active.rot === 2 && e.active.x === x0 && e.active.y === y0,
    JSON.stringify(e.activeInfo()),
  )
  const ev = e.applyAction('HARD_DROP', 0)
  const lock = ev.find((x) => x.kind === 'lock')
  check('tspin: TSD detected as full t-spin', lock?.kind === 'lock' && lock.tspin === 'full', JSON.stringify(lock))
  check('tspin: TSD clears 2 and sends 4', lock?.kind === 'lock' && lock.cleared === 2 && lock.attackTotal === 4)
}

// ---------- 7. perfect clear ----------
{
  const e = new Engine(findSeed('I'))
  fillRow(e, BOARD_H - 1, [3, 4, 5, 6])
  const ev = e.applyAction('HARD_DROP', 0)
  const lock = ev.find((x) => x.kind === 'lock')
  check(
    'perfect clear: single + PC sends 1 + 10',
    lock?.kind === 'lock' && lock.perfectClear && lock.attackTotal === 11,
    JSON.stringify(lock),
  )
}

// ---------- 8. garbage cancellation (spec example) ----------
{
  const e = new Engine(findSeed('O'))
  addStray(e)
  check('cancel: first piece is O', e.active!.type === 'O')
  e.addIncoming({ id: 'atk1', sender: 'X', lines: 4, remaining: 4, holes: [1, 2, 3, 4], createdTick: 0, arrivalTick: 100000 })
  fillRow(e, BOARD_H - 1, [4, 5])
  fillRow(e, BOARD_H - 2, [4, 5])
  const ev = e.applyAction('HARD_DROP', 10)
  const lock = ev.find((x) => x.kind === 'lock')
  check('cancel: O double clears 2', lock?.kind === 'lock' && lock.cleared === 2, JSON.stringify(lock))
  check(
    'cancel: incoming 4 + attack 2 -> 2 remaining, 0 outgoing',
    lock?.kind === 'lock' && lock.attackAfterCancel === 0 && e.incomingTotal() === 2,
    `after=${lock?.kind === 'lock' ? lock.attackAfterCancel : '?'} remaining=${e.incomingTotal()}`,
  )
}

// ---------- 9. garbage insertion ----------
{
  const e = new Engine(findSeed('O'))
  e.addIncoming({ id: 'g1', sender: 'X', lines: 2, remaining: 2, holes: [3, 7], createdTick: 0, arrivalTick: 0 })
  const ev = e.applyAction('HARD_DROP', 5) // non-clearing lock -> garbage enters
  const ins = ev.find((x) => x.kind === 'garbage_inserted')
  check('garbage: inserted at non-clearing lock', ins?.kind === 'garbage_inserted' && ins.lines === 2)
  const bottom = e.board[BOARD_H - 1]
  const above = e.board[BOARD_H - 2]
  check(
    'garbage: rows at bottom with server-chosen holes',
    bottom[7] === 0 && bottom.filter((c) => c === GARBAGE_CELL).length === 9 &&
      above[3] === 0 && above.filter((c) => c === GARBAGE_CELL).length === 9,
    `bottom=${bottom.join('')} above=${above.join('')}`,
  )
  check('garbage: existing stack shifted up', e.board[BOARD_H - 3][4] !== 0 && e.board[BOARD_H - 4][4] !== 0)
}

// ---------- 10. clearing lock delays garbage ----------
{
  const e = new Engine(findSeed('O'))
  addStray(e)
  e.addIncoming({ id: 'g2', sender: 'X', lines: 3, remaining: 3, holes: [0, 0, 0], createdTick: 0, arrivalTick: 0 })
  fillRow(e, BOARD_H - 1, [4, 5])
  fillRow(e, BOARD_H - 2, [4, 5])
  const ev = e.applyAction('HARD_DROP', 5)
  check('garbage: no insertion on a clearing lock', !ev.some((x) => x.kind === 'garbage_inserted'))
  check('garbage: partially cancelled to 1', e.incomingTotal() === 1, `remaining=${e.incomingTotal()}`)
  const ev2 = e.applyAction('HARD_DROP', 6)
  const ins = ev2.find((x) => x.kind === 'garbage_inserted')
  check('garbage: leftover enters on next lock', ins?.kind === 'garbage_inserted' && ins.lines === 1)
}

// ---------- 11. top out ----------
{
  const e = new Engine(777)
  let topped = false
  for (let i = 0; i < 60 && !topped; i++) {
    const ev = e.applyAction('HARD_DROP', i)
    if (ev.some((x) => x.kind === 'topout')) topped = true
  }
  check('topout: stacking center kills the player', topped && !e.alive)
}

// ---------- 12. serialize / deserialize behavioral equivalence ----------
{
  const script: [number, InputAction][] = []
  for (let i = 0; i < 200; i++) {
    const tick = i * 13
    const r = i % 7
    const action: InputAction =
      r === 0 ? 'MOVE_LEFT' : r === 1 ? 'ROTATE_CW' : r === 2 ? 'MOVE_RIGHT' : r === 3 ? 'SOFT_DROP' : r === 4 ? 'HOLD' : r === 5 ? 'ROTATE_CCW' : 'HARD_DROP'
    script.push([tick, action])
  }
  const mid = 100
  const a = new Engine(42)
  a.addIncoming({ id: 'r1', sender: 'X', lines: 3, remaining: 3, holes: [5, 5, 2], createdTick: 40, arrivalTick: 500 })
  for (const [tick, action] of script.slice(0, mid)) a.applyAction(action, tick)
  const restored = Engine.deserialize(a.serialize())
  for (const [tick, action] of script.slice(mid)) {
    a.applyAction(action, tick)
    restored.applyAction(action, tick)
  }
  a.advanceTo(4000)
  restored.advanceTo(4000)
  check(
    'serialize: restored engine tracks the original exactly',
    a.boardStrings().join() === restored.boardStrings().join() &&
      a.computeHash() === restored.computeHash() &&
      a.piecesPlaced === restored.piecesPlaced &&
      a.score === restored.score,
    `a=${a.piecesPlaced}/${a.computeHash()} r=${restored.piecesPlaced}/${restored.computeHash()}`,
  )
}

// ---------- 13. chunked advance determinism ----------
{
  const script: [number, InputAction][] = []
  const rng = (() => {
    let s = 99
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  })()
  let t = 0
  for (let i = 0; i < 300; i++) {
    t += Math.floor(rng() * 20)
    const acts: InputAction[] = ['MOVE_LEFT', 'MOVE_RIGHT', 'ROTATE_CW', 'ROTATE_CCW', 'SOFT_DROP', 'HARD_DROP', 'HOLD']
    script.push([t, acts[Math.floor(rng() * acts.length)]])
  }
  const end = t + 100

  const a = new Engine(2024)
  const b = new Engine(2024)
  const atk = { id: 'c1', sender: 'X', lines: 4, remaining: 4, holes: [1, 8, 4, 4], createdTick: 100, arrivalTick: 800 }
  a.addIncoming(atk)
  b.addIncoming(atk)

  for (const [tick, action] of script) a.applyAction(action, tick)
  a.advanceTo(end)

  let idx = 0
  for (let tick = 0; tick <= end; tick++) {
    b.advanceTo(tick)
    while (idx < script.length && script[idx][0] === tick) {
      b.applyAction(script[idx][1], tick)
      idx++
    }
  }
  check(
    'determinism: chunked vs per-tick advance identical',
    a.computeHash() === b.computeHash() && a.boardStrings().join() === b.boardStrings().join(),
    `a=${a.computeHash()} b=${b.computeHash()}`,
  )
}

// ---------- 14. retroactive attack announcement converges ----------
{
  const seed = findSeed('O')
  const mk = (): Engine => {
    const e = new Engine(seed)
    addStray(e)
    fillRow(e, BOARD_H - 1, [4, 5])
    fillRow(e, BOARD_H - 2, [4, 5])
    return e
  }
  const atk = { id: 'late1', sender: 'X', lines: 4, remaining: 4, holes: [2, 2, 6, 6], createdTick: 5, arrivalTick: 60 }
  const a = mk()
  a.addIncoming(atk) // knew about the attack before clearing
  a.applyAction('HARD_DROP', 10)
  const b = mk()
  b.applyAction('HARD_DROP', 10) // cleared first...
  b.addIncoming(atk) // ...announcement arrived late
  check(
    'retro: late announcement folds identically',
    a.incomingTotal() === b.incomingTotal() && a.incomingTotal() === 2,
    `a=${a.incomingTotal()} b=${b.incomingTotal()}`,
  )
  a.advanceTo(70)
  b.advanceTo(70)
  a.applyAction('HARD_DROP', 70)
  b.applyAction('HARD_DROP', 70)
  check('retro: subsequent insertion identical', a.boardStrings().join() === b.boardStrings().join() && a.computeHash() === b.computeHash())
}

console.log(failures === 0 ? '\nAll engine tests passed.' : `\n${failures} test(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
