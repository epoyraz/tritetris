// End-to-end protocol test: spins up the real server and drives three
// headless WebSocket clients (with local prediction engines and simple bots)
// through the full match flow. Run with: npm run test:e2e
import WebSocket from 'ws'
import { startServer } from '../src/server/index'
import { Engine, type EngineEvent } from '../src/shared/engine'
import { BagStream } from '../src/shared/rng'
import { PIECE_CELLS, SPAWN_X } from '../src/shared/pieces'
import { BOARD_H, BOARD_W, TICK_MS } from '../src/shared/constants'
import { makeEnvelope, type Envelope, type InputAction, type S2C, type S2CType } from '../src/shared/types'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`PASS  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Handler = (env: Envelope) => void

class TC {
  ws!: WebSocket
  log: Envelope[] = []
  private handlers: Handler[] = []
  playerId = ''
  token = ''
  lobbyId = ''
  joinCode = ''
  // match state
  engine: Engine | null = null
  seq = 0
  startAt = 0
  matchId = ''
  baseTick = 0
  baseTime = 0
  lockHashes = new Map<number, number>()
  hashMismatches: string[] = []
  botTimer: ReturnType<typeof setInterval> | null = null
  botBusy = false
  mode: 'greedy' | 'suicide' = 'greedy'
  private handlersInstalled = false

  constructor(public name: string) {}

  static async connect(url: string, name: string): Promise<TC> {
    const tc = new TC(name)
    tc.ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      tc.ws.once('open', () => resolve())
      tc.ws.once('error', reject)
    })
    tc.ws.on('message', (data) => {
      const env = JSON.parse(String(data)) as Envelope
      tc.log.push(env)
      for (const h of [...tc.handlers]) h(env)
    })
    return tc
  }

  send(type: string, payload: unknown): void {
    this.ws.send(JSON.stringify(makeEnvelope(type, payload)))
  }

  on(handler: Handler): void {
    this.handlers.push(handler)
  }

  waitFor<T extends S2CType>(
    type: T,
    pred: (p: S2C[T]) => boolean = () => true,
    timeoutMs = 10000,
    fromIndex = 0,
  ): Promise<S2C[T]> {
    const existing = this.log.slice(fromIndex).find((e) => e.type === type && pred(e.payload as S2C[T]))
    if (existing) return Promise.resolve(existing.payload as S2C[T])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers = this.handlers.filter((h) => h !== handler)
        reject(new Error(`[${this.name}] timeout waiting for ${type}`))
      }, timeoutMs)
      const handler: Handler = (env) => {
        if (env.type === type && pred(env.payload as S2C[T])) {
          clearTimeout(timer)
          this.handlers = this.handlers.filter((h) => h !== handler)
          resolve(env.payload as S2C[T])
        }
      }
      this.on(handler)
    })
  }

  mark(): number {
    return this.log.length
  }

  // ---------- match plumbing ----------

  curTick(): number {
    const t = this.baseTick + Math.floor((Date.now() - this.baseTime) / TICK_MS)
    return Math.max(0, t, this.engine ? this.engine.tick : 0)
  }

  beginMatch(matchId: string, seed: number, startAt: number): void {
    this.matchId = matchId
    this.startAt = startAt
    this.baseTick = 0
    this.baseTime = startAt
    this.seq = 0
    this.engine = new Engine(seed)
    this.lockHashes.clear()
    this.hashMismatches = []
  }

  drive(events: EngineEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'lock') this.lockHashes.set(ev.piecesPlaced, ev.boardHash)
    }
  }

  act(action: InputAction): void {
    if (!this.engine || !this.engine.alive) return
    const tick = this.curTick()
    this.drive(this.engine.applyAction(action, tick))
    this.seq++
    this.send('player_input', {
      match_id: this.matchId,
      sequence: this.seq,
      action,
      client_time: Date.now(),
      tick,
    })
  }

  installMatchHandlers(): void {
    if (this.handlersInstalled) return
    this.handlersInstalled = true
    this.on((env) => {
      if (!this.engine) return
      if (env.type === 'attack_created') {
        const p = env.payload as S2C['attack_created']
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
      } else if (env.type === 'player_state') {
        const p = env.payload as S2C['player_state']
        if (p.player_id === this.playerId && p.pieces_placed > 0) {
          const local = this.lockHashes.get(p.pieces_placed)
          if (local !== undefined && local !== p.hash) {
            this.hashMismatches.push(`pieces=${p.pieces_placed} local=${local} server=${p.hash}`)
          }
        }
      }
    })
  }

  startBot(): void {
    this.stopBot()
    this.botTimer = setInterval(() => {
      void this.botStep()
    }, 40)
  }

  stopBot(): void {
    if (this.botTimer) clearInterval(this.botTimer)
    this.botTimer = null
  }

  private async botStep(): Promise<void> {
    if (this.botBusy || !this.engine || !this.engine.alive || this.ws.readyState !== WebSocket.OPEN) return
    this.botBusy = true
    try {
      this.drive(this.engine.advanceTo(this.curTick()))
      if (!this.engine.active) return
      if (this.mode === 'suicide') {
        this.act('HARD_DROP')
        await sleep(110)
        return
      }
      const plan = choosePlacement(this.engine)
      for (let i = 0; i < plan.rotations && this.engine.alive; i++) {
        this.act('ROTATE_CW')
        await sleep(15)
      }
      let guard = 12
      while (this.engine.alive && this.engine.active && this.engine.active.x !== plan.x && guard-- > 0) {
        this.act(this.engine.active.x > plan.x ? 'MOVE_LEFT' : 'MOVE_RIGHT')
        await sleep(12)
      }
      if (this.engine.alive) this.act('HARD_DROP')
      await sleep(50)
    } finally {
      this.botBusy = false
    }
  }

  close(): void {
    this.stopBot()
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

// Greedy placement heuristic: enough to clear lines organically.
function choosePlacement(engine: Engine): { rotations: number; x: number } {
  const type = engine.active!.type
  const base = engine.board
  let best = { rotations: 0, x: SPAWN_X, score: -Infinity }
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
        for (let by = 0; by < BOARD_H; by++) {
          if (board[by][bx] !== 0) {
            top = by
            break
          }
        }
        heights.push(top === -1 ? 0 : BOARD_H - top)
        if (top !== -1) {
          for (let by = top + 1; by < BOARD_H; by++) if (board[by][bx] === 0) holes++
        }
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
  const url = `ws://localhost:${server.port}/ws`
  console.log(`e2e: server on port ${server.port}`)

  // ---------- lobby flow ----------
  const c1 = await TC.connect(url, 'Alice')
  c1.send('create_lobby', { display_name: 'Alice' })
  const created = await c1.waitFor('lobby_created')
  c1.playerId = created.player_id
  c1.token = created.session_token
  c1.lobbyId = created.lobby_id
  c1.joinCode = created.join_code
  check('lobby: created with 6-char join code', /^[A-Z2-9]{6}$/.test(created.join_code), created.join_code)
  check('lobby: creator got a session token', created.session_token.length > 20)

  const c2 = await TC.connect(url, 'Bob')
  c2.send('join_lobby', { join_code: 'ZZZZZZ', display_name: 'Bob' })
  const notFound = await c2.waitFor('error', (p) => p.code === 'LOBBY_NOT_FOUND')
  check('lobby: bad code rejected with LOBBY_NOT_FOUND', !!notFound)

  const badName = await TC.connect(url, 'x')
  badName.send('join_lobby', { join_code: created.join_code, display_name: '   ' })
  check('lobby: blank name rejected', !!(await badName.waitFor('error', (p) => p.code === 'INVALID_NAME')))
  badName.close()

  c2.send('join_lobby', { join_code: created.join_code, display_name: 'Bob' })
  const joined2 = await c2.waitFor('lobby_joined')
  c2.playerId = joined2.player_id
  c2.token = joined2.session_token
  c2.lobbyId = joined2.lobby_id
  check('lobby: second player joined', joined2.lobby_id === created.lobby_id)
  check('lobby: others see player_joined', !!(await c1.waitFor('player_joined', (p) => p.player.display_name === 'Bob')))

  c2.send('join_lobby', { join_code: created.join_code, display_name: 'Bob' })
  check('lobby: double join rejected', !!(await c2.waitFor('error', (p) => p.code === 'ALREADY_JOINED')))

  const waiting = await c1.waitFor('lobby_state', (p) => p.players.length === 2)
  check('lobby: status WAITING with 2 players', waiting.status === 'WAITING')

  const c3 = await TC.connect(url, 'Cara')
  c3.send('join_lobby', { join_code: created.join_code, display_name: 'Cara' })
  const joined3 = await c3.waitFor('lobby_joined')
  c3.playerId = joined3.player_id
  c3.token = joined3.session_token
  c3.lobbyId = joined3.lobby_id
  const full = await c1.waitFor('lobby_state', (p) => p.players.length === 3)
  check('lobby: 3rd player fills lobby -> READY_CHECK', full.status === 'READY_CHECK')
  check(
    'lobby: slots 1,2,3 all occupied',
    full.players.map((p) => p.slot).sort().join(',') === '1,2,3',
  )

  const c4 = await TC.connect(url, 'Dave')
  c4.send('join_lobby', { join_code: created.join_code, display_name: 'Dave' })
  check('lobby: 4th player rejected LOBBY_FULL', !!(await c4.waitFor('error', (p) => p.code === 'LOBBY_FULL')))
  c4.close()

  // ---------- ready + countdown cancel ----------
  c1.send('set_ready', { ready: true })
  await c1.waitFor('player_ready_changed', (p) => p.player_id === c1.playerId && p.ready)
  c2.send('set_ready', { ready: true })
  await c1.waitFor('player_ready_changed', (p) => p.player_id === c2.playerId && p.ready)
  await sleep(400)
  check('countdown: not started with only 2 ready', !c1.log.some((e) => e.type === 'match_countdown'))

  c3.send('set_ready', { ready: true })
  const cd1 = await c1.waitFor('match_countdown')
  const cd1c2 = await c2.waitFor('match_countdown')
  check('countdown: starts when all 3 ready', cd1.match_id === cd1c2.match_id && cd1.seed === cd1c2.seed)

  // A player disconnecting during the countdown cancels it for everyone.
  c2.ws.terminate()
  const cancelled = await c1.waitFor('error', (p) => p.code === 'COUNTDOWN_CANCELLED')
  check('countdown: disconnect cancels it', !!cancelled)
  const backToWaiting = await c1.waitFor('lobby_state', (p) => p.status === 'WAITING' && p.players.length === 2)
  check(
    'countdown: cancel resets all ready states',
    backToWaiting.players.every((p) => !p.ready),
  )

  const c2b = await TC.connect(url, 'Bob')
  c2b.send('join_lobby', { join_code: created.join_code, display_name: 'Bob' })
  const joined2b = await c2b.waitFor('lobby_joined')
  c2b.playerId = joined2b.player_id
  c2b.token = joined2b.session_token
  c2b.lobbyId = joined2b.lobby_id
  await c1.waitFor('lobby_state', (p) => p.players.length === 3 && p.status === 'READY_CHECK')

  const clients = [c1, c2b, c3]
  for (const c of clients) c.send('set_ready', { ready: true })
  const cd2 = await c1.waitFor('match_countdown', (p) => p.match_id !== cd1.match_id)
  check('countdown: fresh match after re-ready', cd2.start_at > Date.now() - 1000)

  // Premature input during countdown must be ignored by the server.
  c1.send('player_input', {
    match_id: cd2.match_id,
    sequence: 999,
    action: 'HARD_DROP',
    client_time: Date.now(),
    tick: 0,
  })

  // ---------- match start ----------
  const starts = await Promise.all(clients.map((c) => c.waitFor('match_start', (p) => p.match_id === cd2.match_id, 6000)))
  check('start: all three clients received match_start', starts.length === 3)
  check('start: identical seeds', new Set(starts.map((s) => s.seed)).size === 1)
  check('start: identical piece queues', new Set(starts.map((s) => s.initial_piece_queue.join(''))).size === 1)
  check(
    'start: queue matches seeded 7-bag',
    starts[0].initial_piece_queue.join('') === new BagStream(starts[0].seed).peek(7).join(''),
    starts[0].initial_piece_queue.join(''),
  )
  check('start: 3 players listed', starts[0].players.length === 3)

  for (const [i, c] of clients.entries()) {
    c.beginMatch(starts[i].match_id, starts[i].seed, starts[i].start_at)
    c.installMatchHandlers()
  }

  await sleep(700)
  const idleState = await c1.waitFor('player_state', (p) => p.player_id === c1.playerId && p.tick > 0)
  check('start: premature countdown input was ignored', idleState.pieces_placed === 0, `pieces=${idleState.pieces_placed}`)

  // ---------- gameplay: c3 suicides, c1/c2b play greedy ----------
  c3.mode = 'suicide'
  for (const c of clients) c.startBot()

  const elim3 = await c1.waitFor('player_eliminated', (p) => p.player_id === c3.playerId, 30000)
  check('elimination: suicide bot topped out, placement 3', elim3.placement === 3, `placement=${elim3.placement}`)
  check('elimination: reason is topout', elim3.reason === 'topout')
  c3.stopBot()

  // Wait until at least one attack has been created (greedy bots clear lines).
  const attack = await c1.waitFor('attack_created', () => true, 45000)
  check('attack: created with 1+ lines', attack.line_count >= 1)
  check('attack: sender is not the target', attack.sender_player_id !== attack.target_player_id)
  check(
    'attack: holes generated per line',
    attack.holes.length === attack.line_count && attack.holes.every((h) => h >= 0 && h < BOARD_W),
  )
  check('attack: arrival delay ~700ms', attack.arrival_tick - attack.created_tick >= 40)

  // Give garbage a chance to land, then check any garbage_applied consistency.
  const garbageApplied = await Promise.race([
    c1.waitFor('garbage_applied', () => true, 20000),
    sleep(20000).then(() => null),
  ])
  check('garbage: applied to a board after arrival', garbageApplied !== null)

  // ---------- finish the match ----------
  c2b.mode = 'suicide'
  const elim2 = await c1.waitFor('player_eliminated', (p) => p.player_id === c2b.playerId, 30000)
  check('elimination: second player out, placement 2', elim2.placement === 2)
  c2b.stopBot()

  const end = await c1.waitFor('match_end', () => true, 10000)
  c1.stopBot()
  check('end: winner is the survivor', end.winner_player_id === c1.playerId)
  check(
    'end: ranking is 1,2,3',
    end.ranking.map((r) => r.placement).join(',') === '1,2,3' &&
      end.ranking[0].player_id === c1.playerId &&
      end.ranking[1].player_id === c2b.playerId &&
      end.ranking[2].player_id === c3.playerId,
    JSON.stringify(end.ranking),
  )
  const st = end.statistics
  check('end: statistics for all three players', [c1, c2b, c3].every((c) => st[c.playerId] !== undefined))
  check('end: pieces were placed', st[c1.playerId].pieces_placed > 0)
  check('end: attacker recorded garbage_sent', Object.values(st).some((s) => s.garbage_sent > 0))

  check('sync: c1 client/server hashes matched at every lock', c1.hashMismatches.length === 0, c1.hashMismatches.slice(0, 3).join(' | '))
  check('sync: c2b hashes matched', c2b.hashMismatches.length === 0, c2b.hashMismatches.slice(0, 3).join(' | '))
  check('sync: c3 hashes matched', c3.hashMismatches.length === 0, c3.hashMismatches.slice(0, 3).join(' | '))

  const finished = await c1.waitFor('lobby_state', (p) => p.status === 'FINISHED')
  check('end: lobby is FINISHED', !!finished)

  // ---------- rematch ----------
  const markC1 = c1.mark()
  c1.send('request_rematch', { match_id: c1.matchId })
  const votes1 = await c1.waitFor('rematch_status', () => true, 5000, markC1)
  check('rematch: first vote counted', votes1.votes.length === 1 && votes1.needed === 3)
  c2b.send('request_rematch', { match_id: c1.matchId })
  await c1.waitFor('rematch_status', (p) => p.votes.length === 2, 5000, markC1)
  c3.send('request_rematch', { match_id: c1.matchId })
  const cd3 = await c1.waitFor('match_countdown', () => true, 5000, markC1)
  check('rematch: three votes start a new countdown', !!cd3)
  check('rematch: new seed generated', cd3.seed !== cd2.seed)

  const starts2 = await Promise.all(clients.map((c) => c.waitFor('match_start', (p) => p.match_id === cd3.match_id, 6000)))
  for (const [i, c] of clients.entries()) c.beginMatch(starts2[i].match_id, starts2[i].seed, starts2[i].start_at)
  for (const c of clients) c.installMatchHandlers()
  for (const c of clients) {
    c.mode = 'greedy'
    c.startBot()
  }
  await sleep(1500)

  // ---------- reconnect during match ----------
  c2b.stopBot()
  c2b.ws.terminate()
  const frozen = await c1.waitFor(
    'player_state',
    (p) => p.player_id === c2b.playerId && p.connected === false,
    8000,
  )
  check('reconnect: opponents see the player as disconnected', !!frozen)

  const c2r = await TC.connect(url, 'Bob')
  c2r.playerId = c2b.playerId
  c2r.token = c2b.token
  c2r.send('reconnect', { session_token: c2b.token, lobby_id: c2b.lobbyId })
  await c2r.waitFor('lobby_joined', (p) => p.player_id === c2b.playerId, 5000)
  const corr = await c2r.waitFor('state_correction', () => true, 5000)
  check('reconnect: state_correction for the right player', corr.your_player_id === c2b.playerId)
  check('reconnect: includes all three snapshots', corr.snapshots.length === 3)
  const restored = Engine.deserialize(corr.your_engine)
  check(
    'reconnect: serialized engine restores cleanly',
    restored.boardStrings().join() === corr.your_engine.board.join() && restored.lastLockHash === corr.your_engine.lastLockHash,
  )
  // Resume play on the lagged timeline the server granted us.
  c2r.matchId = corr.match_id
  c2r.engine = restored
  c2r.baseTick = corr.your_tick
  c2r.baseTime = corr.server_now
  c2r.seq = 1000000 // fresh socket, but sequence must stay monotonic per player
  c2r.installMatchHandlers()
  const beforePieces = corr.your_engine.piecesPlaced
  c2r.act('HARD_DROP')
  const after = await c2r.waitFor(
    'player_state',
    (p) => p.player_id === c2b.playerId && p.pieces_placed > beforePieces,
    8000,
  )
  check('reconnect: post-reconnect input accepted on lagged timeline', after.pieces_placed > beforePieces)

  // ---------- teardown ----------
  for (const c of clients) c.stopBot()
  const markC3 = c3.mark()
  c1.send('leave_lobby', {})
  const elimLeft = await c3.waitFor('player_eliminated', (p) => p.player_id === c1.playerId, 5000, markC3)
  check('leave: leaving mid-match eliminates the player', elimLeft.reason === 'left')
  c2r.send('leave_lobby', {})
  const end2 = await c3.waitFor('match_end', () => true, 5000, markC3)
  check('leave: last survivor wins after others leave', end2.winner_player_id === c3.playerId)
  c3.send('leave_lobby', {})
  await sleep(300)

  const health = await fetch(`http://localhost:${server.port}/healthz`).then((r) => r.json() as Promise<{ lobbies: number }>)
  check('cleanup: empty lobby deleted', health.lobbies === 0, `lobbies=${health.lobbies}`)

  for (const c of [c1, c2, c2b, c2r, c3]) c.close()

  // ---------- bots: 1 human + hard + easy ----------
  const h1 = await TC.connect(url, 'Hana')
  h1.send('create_lobby', { display_name: 'Hana' })
  const bl = await h1.waitFor('lobby_created')
  h1.playerId = bl.player_id
  h1.send('add_bot', { tier: 'hard' })
  await h1.waitFor('lobby_state', (p) => p.players.filter((x) => x.is_bot).length === 1)
  h1.send('add_bot', { tier: 'easy' })
  const botLobby = await h1.waitFor('lobby_state', (p) => p.players.length === 3)
  check('bots: two bots fill the lobby -> READY_CHECK', botLobby.status === 'READY_CHECK')
  check('bots: bots are always ready', botLobby.players.filter((x) => x.is_bot).every((x) => x.ready && x.connected))
  const hardBot = botLobby.players.find((x) => x.bot_tier === 'hard')!
  const easyBot = botLobby.players.find((x) => x.bot_tier === 'easy')!
  check('bots: tier recorded in lobby state', !!hardBot && !!easyBot && hardBot.display_name.includes('Hard'))
  h1.send('add_bot', { tier: 'easy' })
  check('bots: fourth bot rejected', !!(await h1.waitFor('error', (p) => p.code === 'LOBBY_FULL')))

  const botMark = h1.mark()
  h1.send('set_ready', { ready: true })
  await h1.waitFor('match_countdown', () => true, 5000, botMark)
  const botStart = await h1.waitFor('match_start', () => true, 6000, botMark)
  check('bots: match starts with one human ready', botStart.players.length === 3)
  check('bots: match players carry is_bot flags', botStart.players.filter((x) => x.is_bot).length === 2)
  h1.beginMatch(botStart.match_id, botStart.seed, botStart.start_at)
  h1.installMatchHandlers()

  const botPlays = await h1.waitFor('player_state', (p) => p.player_id === hardBot.player_id && p.pieces_placed >= 3, 25000)
  check('bots: hard bot places pieces', botPlays.pieces_placed >= 3)
  const botAttack = await Promise.race([
    h1.waitFor('attack_created', (p) => p.sender_player_id === hardBot.player_id, 60000),
    sleep(60000).then(() => null),
  ])
  check('bots: hard bot clears lines and attacks', botAttack !== null)

  h1.send('leave_lobby', {})
  await sleep(400)
  const health2 = await fetch(`http://localhost:${server.port}/healthz`).then((r) => r.json() as Promise<{ lobbies: number }>)
  check('bots: lobby with only bots left is deleted', health2.lobbies === 0, `lobbies=${health2.lobbies}`)
  h1.close()

  await server.close()
  // Give ws sockets a beat to fully unwind; avoids a libuv teardown assert on Windows.
  await sleep(500)
}

const watchdog = setTimeout(() => {
  console.error('FAIL  e2e watchdog timeout (120s)')
  process.exit(1)
}, 120000)

main()
  .then(() => {
    clearTimeout(watchdog)
    console.log(failures === 0 ? '\nAll e2e tests passed.' : `\n${failures} e2e test(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    clearTimeout(watchdog)
    console.error('FAIL  e2e crashed:', err)
    process.exit(1)
  })
