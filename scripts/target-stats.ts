// Diagnostic: runs a real match (1 greedy client + 2 hard bots) and tallies
// who attacked whom, to inspect the garbage-targeting distribution.
// Run with: npx tsx scripts/target-stats.ts
import WebSocket from 'ws'
import { startServer } from '../src/server/index'
import { Engine } from '../src/shared/engine'
import { PIECE_CELLS } from '../src/shared/pieces'
import { BOARD_H, BOARD_W, TICK_MS } from '../src/shared/constants'
import { makeEnvelope, type Envelope, type InputAction, type S2C } from '../src/shared/types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 1) The selection code in isolation (exact same expression as the server):
{
  const counts = [0, 0]
  for (let i = 0; i < 100000; i++) counts[Math.floor(Math.random() * 2)]++
  console.log(`isolated pick, 100k draws: target A ${counts[0]}, target B ${counts[1]}\n`)
}

// 2) A real match:
function choosePlacement(engine: Engine): { rotations: number; x: number } {
  const type = engine.active!.type
  const base = engine.board
  let best = { rotations: 0, x: 3, score: -Infinity }
  for (let rot = 0; rot < 4; rot++) {
    const cells = PIECE_CELLS[type][rot]
    const minX = -Math.min(...cells.map(([cx]) => cx))
    const maxX = BOARD_W - 1 - Math.max(...cells.map(([cx]) => cx))
    for (let x = minX; x <= maxX; x++) {
      const fits = (y: number): boolean =>
        cells.every(([cx, cy]) => {
          const by = y + cy
          const bx = x + cx
          return by >= 0 && by < BOARD_H && bx >= 0 && bx < BOARD_W && base[by][bx] === 0
        })
      if (!fits(0)) continue
      let y = 0
      while (fits(y + 1)) y++
      const board = base.map((r) => [...r])
      for (const [cx, cy] of cells) board[y + cy][x + cx] = 9
      let cleared = 0
      for (let by = BOARD_H - 1; by >= 0; by--) {
        if (board[by].every((c) => c !== 0)) {
          board.splice(by, 1)
          board.unshift(new Array(BOARD_W).fill(0))
          cleared++
          by++
        }
      }
      const heights: number[] = []
      let holes = 0
      for (let bx = 0; bx < BOARD_W; bx++) {
        let top = -1
        for (let by = 0; by < BOARD_H; by++) if (board[by][bx] !== 0) { top = by; break }
        heights.push(top === -1 ? 0 : BOARD_H - top)
        if (top !== -1) for (let by = top + 1; by < BOARD_H; by++) if (board[by][bx] === 0) holes++
      }
      const agg = heights.reduce((a, b) => a + b, 0)
      let bump = 0
      for (let i = 0; i < heights.length - 1; i++) bump += Math.abs(heights[i] - heights[i + 1])
      const score = cleared * 8 - agg * 0.6 - holes * 2.5 - bump * 0.4
      if (score > best.score) best = { rotations: rot, x, score }
    }
  }
  return best
}

async function main(): Promise<void> {
  const server = await startServer(0)
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
  const log: Envelope[] = []
  const handlers: ((e: Envelope) => void)[] = []
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
  ws.on('message', (d) => {
    const env = JSON.parse(String(d)) as Envelope
    log.push(env)
    for (const h of [...handlers]) h(env)
  })
  const send = (type: string, payload: unknown): void => { ws.send(JSON.stringify(makeEnvelope(type, payload))) }
  const waitFor = <T,>(type: string, pred: (p: T) => boolean = () => true, timeout = 10000): Promise<T> => {
    const hit = log.find((e) => e.type === type && pred(e.payload as T))
    if (hit) return Promise.resolve(hit.payload as T)
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${type}`)), timeout)
      handlers.push((e) => { if (e.type === type && pred(e.payload as T)) { clearTimeout(t); res(e.payload as T) } })
    })
  }

  send('create_lobby', { display_name: 'Human' })
  const created = await waitFor<S2C['lobby_created']>('lobby_created')
  send('add_bot', { tier: 'hard' })
  await sleep(200)
  send('add_bot', { tier: 'hard' })
  const lobby = await waitFor<S2C['lobby_state']>('lobby_state', (p) => p.players.length === 3)
  const names = new Map(lobby.players.map((p) => [p.player_id, p.display_name.replace('🤖 ', '').replace(' · Hard', '(bot)')]))
  names.set(created.player_id, 'Human')
  send('set_ready', { ready: true })
  const start = await waitFor<S2C['match_start']>('match_start', () => true, 8000)

  // Greedy human client with a proper prediction engine.
  const engine = new Engine(start.seed)
  let seq = 0
  const tick = (): number => Math.max(0, Math.floor((Date.now() - start.start_at) / TICK_MS), engine.tick)
  const act = (a: InputAction): void => {
    engine.applyAction(a, tick())
    send('player_input', { match_id: start.match_id, sequence: ++seq, action: a, client_time: Date.now(), tick: tick() })
  }
  handlers.push((e) => {
    if (e.type === 'attack_created') {
      const p = e.payload as S2C['attack_created']
      if (p.target_player_id === created.player_id) {
        engine.addIncoming({ id: p.attack_id, sender: p.sender_player_id, lines: p.line_count, remaining: p.line_count, holes: p.holes, createdTick: p.created_tick, arrivalTick: p.arrival_tick })
      }
    }
  })

  const matrix = new Map<string, Map<string, number>>()
  const sent = new Map<string, number>()
  const received = new Map<string, number>()
  let attacks = 0
  handlers.push((e) => {
    if (e.type !== 'attack_created') return
    const p = e.payload as S2C['attack_created']
    attacks++
    const s = names.get(p.sender_player_id)!
    const t = names.get(p.target_player_id)!
    if (!matrix.has(s)) matrix.set(s, new Map())
    matrix.get(s)!.set(t, (matrix.get(s)!.get(t) ?? 0) + 1)
    sent.set(s, (sent.get(s) ?? 0) + p.line_count)
    received.set(t, (received.get(t) ?? 0) + p.line_count)
  })

  const deadline = Date.now() + 120000
  while (Date.now() < deadline && attacks < 50 && engine.alive) {
    engine.advanceTo(tick())
    if (engine.active) {
      const plan = choosePlacement(engine)
      for (let i = 0; i < plan.rotations; i++) { act('ROTATE_CW'); await sleep(14) }
      let guard = 12
      while (engine.active && engine.active.x !== plan.x && guard-- > 0) {
        act(engine.active.x > plan.x ? 'MOVE_LEFT' : 'MOVE_RIGHT')
        await sleep(12)
      }
      act('HARD_DROP')
    }
    await sleep(60)
  }

  console.log(`match ran, ${attacks} attack events observed:\n`)
  console.log('sender          -> targets (attack events)')
  for (const [s, row] of matrix) {
    console.log(`  ${s.padEnd(12)} -> ${[...row.entries()].map(([t, n]) => `${t}: ${n}`).join(', ')}`)
  }
  console.log('\nlines sent:     ', [...sent.entries()].map(([n, v]) => `${n}: ${v}`).join(', '))
  console.log('lines received: ', [...received.entries()].map(([n, v]) => `${n}: ${v}`).join(', '))
  send('leave_lobby', {})
  await sleep(300)
  ws.close()
  await server.close()
  await sleep(300)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
