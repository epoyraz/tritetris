import type { WebSocket } from 'ws'
import { REQUIRED_PLAYERS } from '../shared/constants'
import type { BotTier, LobbyPlayerInfo, LobbyStatePayload, LobbyStatus, S2C, S2CType } from '../shared/types'
import { BOT_NAMES, ServerBot, botDisplayName } from './bot'
import { ServerMatch, type MatchPlayerHandle } from './match'
import { joinCode, send, sendError, sessionToken, uuid } from './util'

export interface ClientConn {
  ws: WebSocket
  lobbyId: string | null
  playerId: string | null
  lastSeen: number
  latencyMs: number
}

export interface LobbyPlayer {
  id: string
  name: string
  token: string
  slot: 1 | 2 | 3
  host: boolean
  ready: boolean
  joinedAt: number
  conn: ClientConn | null
  isBot: boolean
  botTier: BotTier | null
}

const NAME_RE = /^[^\x00-\x1f\x7f]{1,16}$/

export function validName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  return NAME_RE.test(name) ? name : null
}

export class Lobby {
  readonly id = uuid()
  readonly joinCode = joinCode()
  readonly createdAt = Date.now()
  status: LobbyStatus = 'WAITING'
  players: LobbyPlayer[] = []
  match: ServerMatch | null = null
  rematchVotes = new Set<string>()
  private activeBots: ServerBot[] = []

  constructor(private manager: LobbyManager) {}

  humans(): LobbyPlayer[] {
    return this.players.filter((p) => !p.isBot)
  }

  // ---------- membership ----------

  freeSlot(): 1 | 2 | 3 | null {
    for (const s of [1, 2, 3] as const) {
      if (!this.players.some((p) => p.slot === s)) return s
    }
    return null
  }

  addPlayer(conn: ClientConn, name: string): LobbyPlayer {
    const slot = this.freeSlot()!
    const player: LobbyPlayer = {
      id: uuid(),
      name,
      token: sessionToken(),
      slot,
      host: this.humans().length === 0,
      ready: false,
      joinedAt: Date.now(),
      conn,
      isBot: false,
      botTier: null,
    }
    this.players.push(player)
    this.players.sort((a, b) => a.slot - b.slot)
    conn.lobbyId = this.id
    conn.playerId = player.id
    this.manager.tokens.set(player.token, { lobbyId: this.id, playerId: player.id })
    return player
  }

  removePlayer(player: LobbyPlayer, reason: string): void {
    this.players = this.players.filter((p) => p !== player)
    this.manager.tokens.delete(player.token)
    if (player.conn) {
      player.conn.lobbyId = null
      player.conn.playerId = null
      player.conn = null
    }
    this.rematchVotes.delete(player.id)
    if (player.host && this.humans().length > 0) {
      // Promote the longest-connected remaining human.
      const next = this.humans().sort((a, b) => a.joinedAt - b.joinedAt)[0]
      next.host = true
    }
    this.broadcast('player_left', { player_id: player.id, reason })
  }

  // ---------- bots ----------

  addBot(requester: LobbyPlayer, tier: BotTier): void {
    if (!requester.host) {
      sendError(requester.conn?.ws, 'NOT_HOST', 'Only the host can add bots.')
      return
    }
    if (this.status !== 'WAITING') {
      sendError(requester.conn?.ws, 'LOBBY_FULL', 'Bots can only be added while waiting for players.')
      return
    }
    const slot = this.freeSlot()
    if (!slot) {
      sendError(requester.conn?.ws, 'LOBBY_FULL', 'Lobby already contains 3 players.')
      return
    }
    const used = new Set(this.players.map((p) => p.name))
    const base = BOT_NAMES.find((n) => ![...used].some((u) => u.includes(n))) ?? 'Bot'
    const bot: LobbyPlayer = {
      id: uuid(),
      name: botDisplayName(base, tier),
      token: sessionToken(),
      slot,
      host: false,
      ready: true, // bots are always ready
      joinedAt: Date.now(),
      conn: null,
      isBot: true,
      botTier: tier,
    }
    this.players.push(bot)
    this.players.sort((a, b) => a.slot - b.slot)
    this.broadcast('player_joined', { player: this.playerInfos().find((p) => p.player_id === bot.id)! })
    this.recomputeStatus()
    this.broadcastState()
    this.tryStartCountdown() // humans may already all be ready
  }

  removeBot(requester: LobbyPlayer, playerId: string): void {
    if (!requester.host) {
      sendError(requester.conn?.ws, 'NOT_HOST', 'Only the host can remove bots.')
      return
    }
    if (this.status === 'COUNTDOWN' || this.status === 'PLAYING') {
      sendError(requester.conn?.ws, 'MATCH_ALREADY_STARTED', 'Cannot remove bots mid-match.')
      return
    }
    const bot = this.players.find((p) => p.id === playerId && p.isBot)
    if (!bot) {
      sendError(requester.conn?.ws, 'NOT_FOUND', 'No such bot.')
      return
    }
    this.removePlayer(bot, 'removed')
    this.recomputeStatus()
    this.broadcastState()
  }

  getPlayer(id: string | null): LobbyPlayer | undefined {
    return this.players.find((p) => p.id === id)
  }

  connectedCount(): number {
    return this.players.filter((p) => p.conn !== null).length
  }

  // ---------- state / broadcast ----------

  recomputeStatus(): void {
    // Only transitions between non-match states; COUNTDOWN/PLAYING/FINISHED
    // are managed by the match lifecycle.
    if (this.status === 'COUNTDOWN' || this.status === 'PLAYING') return
    if (this.status === 'FINISHED' && this.players.length === REQUIRED_PLAYERS) return
    this.status = this.players.length === REQUIRED_PLAYERS ? 'READY_CHECK' : 'WAITING'
    if (this.status === 'WAITING') {
      for (const p of this.players) p.ready = p.isBot
      this.rematchVotes.clear()
    }
  }

  playerInfos(): LobbyPlayerInfo[] {
    return this.players.map((p) => ({
      player_id: p.id,
      display_name: p.name,
      slot: p.slot,
      connected: p.isBot || p.conn !== null,
      ready: p.ready,
      host: p.host,
      latency_ms: p.conn?.latencyMs ?? 0,
      alive: this.match && this.status === 'PLAYING' ? this.match.isAlive(p.id) : true,
      is_bot: p.isBot,
      bot_tier: p.botTier,
    }))
  }

  statePayload(): LobbyStatePayload {
    return {
      lobby_id: this.id,
      join_code: this.joinCode,
      status: this.status,
      players: this.playerInfos(),
      required_players: REQUIRED_PLAYERS,
      rematch_votes: [...this.rematchVotes],
    }
  }

  broadcast<T extends S2CType>(type: T, payload: S2C[T]): void {
    for (const p of this.players) send(p.conn?.ws, type, payload)
  }

  broadcastState(): void {
    this.broadcast('lobby_state', this.statePayload())
  }

  // ---------- ready / countdown ----------

  setReady(player: LobbyPlayer, ready: boolean): void {
    if (this.status !== 'READY_CHECK' && this.status !== 'FINISHED') {
      sendError(player.conn?.ws, 'lobby_not_ready', 'Ready is only available when the lobby has 3 connected players.')
      return
    }
    if (this.players.length !== REQUIRED_PLAYERS) {
      sendError(player.conn?.ws, 'lobby_not_ready', 'Waiting for more players.')
      return
    }
    player.ready = ready
    this.broadcast('player_ready_changed', { player_id: player.id, ready })
    this.broadcastState()
    this.tryStartCountdown()
  }

  tryStartCountdown(): void {
    if (this.status !== 'READY_CHECK') return
    if (this.players.length !== REQUIRED_PLAYERS) return
    if (!this.players.every((p) => (p.isBot || p.conn !== null) && p.ready)) return
    if (this.humans().length === 0) return
    this.beginCountdown()
  }

  private beginCountdown(): void {
    // Atomic transition: READY_CHECK -> COUNTDOWN happens exactly once even if
    // three set_ready messages land in the same tick (single-threaded server +
    // status guard above makes duplicate starts impossible).
    this.status = 'COUNTDOWN'
    const handles: MatchPlayerHandle[] = this.players.map((p) => ({
      playerId: p.id,
      displayName: p.name,
      slot: p.slot,
      isBot: p.isBot,
      getWs: () => p.conn?.ws ?? null,
    }))
    const match = new ServerMatch(handles, {
      onAborted: () => this.cancelCountdown('A player disconnected during the countdown.'),
      onStarted: () => {
        this.status = 'PLAYING'
        this.broadcastState()
        for (const bot of this.activeBots) bot.start()
      },
      onEnded: () => this.onMatchEnded(),
    })
    this.match = match
    this.activeBots = this.players
      .filter((p) => p.isBot)
      .map((p) => {
        const bot = new ServerBot(match, p.id, p.botTier ?? 'medium')
        match.attachBotSink(p.id, (type, payload) => bot.onMessage(type, payload))
        return bot
      })
    this.broadcastState()
    this.match.startCountdown()
  }

  private stopBots(): void {
    for (const bot of this.activeBots) bot.stop()
    this.activeBots = []
  }

  stopAllBots(): void {
    this.stopBots()
  }

  cancelCountdown(reason: string): void {
    if (this.status !== 'COUNTDOWN') return
    this.stopBots()
    this.match?.cancel()
    this.match = null
    this.status = 'WAITING'
    for (const p of this.players) p.ready = p.isBot
    this.recomputeStatus()
    this.broadcast('error', { code: 'COUNTDOWN_CANCELLED', message: reason })
    this.broadcastState()
  }

  private onMatchEnded(): void {
    this.status = 'FINISHED'
    this.stopBots()
    this.rematchVotes.clear()
    for (const p of this.players) {
      p.ready = p.isBot
      if (p.isBot) this.rematchVotes.add(p.id) // bots always accept a rematch
    }
    // Humans who dropped during the match lose their slot now.
    for (const p of [...this.players]) {
      if (!p.isBot && p.conn === null) this.removePlayer(p, 'disconnected')
    }
    this.recomputeStatus()
    this.broadcastState()
    this.broadcast('rematch_status', { votes: [...this.rematchVotes], needed: REQUIRED_PLAYERS })
    this.manager.deleteIfEmpty(this)
  }

  // ---------- rematch ----------

  voteRematch(player: LobbyPlayer, matchId: string): void {
    if (this.status !== 'FINISHED' || !this.match || this.match.id !== matchId) {
      sendError(player.conn?.ws, 'rematch_unavailable', 'No finished match to rematch.')
      return
    }
    if (this.players.length !== REQUIRED_PLAYERS) {
      sendError(player.conn?.ws, 'rematch_unavailable', 'Rematch needs all three players.')
      return
    }
    this.rematchVotes.add(player.id)
    this.broadcast('rematch_status', { votes: [...this.rematchVotes], needed: REQUIRED_PLAYERS })
    if (
      this.rematchVotes.size === REQUIRED_PLAYERS &&
      this.players.every((p) => (p.isBot || p.conn !== null) && this.rematchVotes.has(p.id))
    ) {
      this.rematchVotes.clear()
      this.match = null
      this.beginCountdown()
    }
  }

  // ---------- connection events ----------

  handleDisconnect(player: LobbyPlayer): void {
    if (player.conn) {
      player.conn.lobbyId = null
      player.conn.playerId = null
      player.conn = null
    }
    player.ready = false
    if (this.status === 'COUNTDOWN') {
      this.cancelCountdown('A player disconnected during the countdown.')
      this.removePlayer(player, 'disconnected')
      this.recomputeStatus()
      this.broadcastState()
    } else if (this.status === 'PLAYING') {
      // Keep the slot: reconnection grace is handled by the match.
      this.match?.handleDisconnect(player.id)
      this.broadcastState()
    } else {
      this.removePlayer(player, 'disconnected')
      this.recomputeStatus()
      this.broadcastState()
    }
    this.manager.deleteIfEmpty(this)
  }

  handleLeave(player: LobbyPlayer): void {
    if (this.status === 'COUNTDOWN') {
      this.cancelCountdown('A player left during the countdown.')
    } else if (this.status === 'PLAYING') {
      this.match?.handleLeave(player.id)
    }
    this.removePlayer(player, 'left')
    this.recomputeStatus()
    this.broadcastState()
    this.manager.deleteIfEmpty(this)
  }
}

export class LobbyManager {
  lobbies = new Map<string, Lobby>()
  byCode = new Map<string, Lobby>()
  tokens = new Map<string, { lobbyId: string; playerId: string }>()

  createLobby(conn: ClientConn, rawName: unknown): void {
    if (conn.lobbyId) {
      sendError(conn.ws, 'ALREADY_JOINED', 'You are already in a lobby.')
      return
    }
    const name = validName(rawName)
    if (!name) {
      sendError(conn.ws, 'INVALID_NAME', 'Names must be 1-16 printable characters.')
      return
    }
    const lobby = new Lobby(this)
    this.lobbies.set(lobby.id, lobby)
    this.byCode.set(lobby.joinCode, lobby)
    const player = lobby.addPlayer(conn, name)
    send(conn.ws, 'lobby_created', {
      lobby_id: lobby.id,
      join_code: lobby.joinCode,
      player_id: player.id,
      session_token: player.token,
    })
    lobby.recomputeStatus()
    lobby.broadcastState()
  }

  joinLobby(conn: ClientConn, rawCode: unknown, rawName: unknown): void {
    if (conn.lobbyId) {
      sendError(conn.ws, 'ALREADY_JOINED', 'You are already in a lobby.')
      return
    }
    const name = validName(rawName)
    if (!name) {
      sendError(conn.ws, 'INVALID_NAME', 'Names must be 1-16 printable characters.')
      return
    }
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : ''
    const lobby = this.byCode.get(code)
    if (!lobby) {
      sendError(conn.ws, 'LOBBY_NOT_FOUND', 'No lobby exists for this join code.')
      return
    }
    if (lobby.status === 'PLAYING' || lobby.status === 'COUNTDOWN') {
      sendError(conn.ws, 'MATCH_ALREADY_STARTED', 'The match has already begun.')
      return
    }
    if (lobby.players.length >= REQUIRED_PLAYERS) {
      sendError(conn.ws, 'LOBBY_FULL', 'Lobby already contains 3 players.')
      return
    }
    // Joining a finished lobby restarts the ready flow for everyone.
    if (lobby.status === 'FINISHED') {
      lobby.status = 'WAITING'
      lobby.rematchVotes.clear()
      lobby.match = null
      for (const p of lobby.players) p.ready = p.isBot
    }
    const player = lobby.addPlayer(conn, name)
    send(conn.ws, 'lobby_joined', {
      lobby_id: lobby.id,
      join_code: lobby.joinCode,
      player_id: player.id,
      session_token: player.token,
    })
    lobby.broadcast('player_joined', { player: lobby.playerInfos().find((p) => p.player_id === player.id)! })
    lobby.recomputeStatus()
    lobby.broadcastState()
  }

  reconnect(conn: ClientConn, token: unknown, lobbyId: unknown): void {
    const entry = typeof token === 'string' ? this.tokens.get(token) : undefined
    const lobby = entry ? this.lobbies.get(entry.lobbyId) : undefined
    const player = lobby?.getPlayer(entry?.playerId ?? null)
    if (!entry || !lobby || !player || (typeof lobbyId === 'string' && lobbyId !== lobby.id)) {
      sendError(conn.ws, 'RECONNECT_FAILED', 'Session expired or lobby is gone.')
      return
    }
    if (player.conn && player.conn !== conn) {
      // Replace a stale socket (e.g. half-open connection after a network blip).
      try {
        player.conn.ws.close(4000, 'replaced by reconnect')
      } catch {
        /* ignore */
      }
      player.conn.lobbyId = null
      player.conn.playerId = null
    }
    player.conn = conn
    conn.lobbyId = lobby.id
    conn.playerId = player.id
    send(conn.ws, 'lobby_joined', {
      lobby_id: lobby.id,
      join_code: lobby.joinCode,
      player_id: player.id,
      session_token: player.token,
    })
    lobby.broadcastState()
    if (lobby.status === 'PLAYING' && lobby.match) {
      const correction = lobby.match.handleReconnect(player.id)
      if (correction) send(conn.ws, 'state_correction', correction)
    }
  }

  handleSocketClose(conn: ClientConn): void {
    const lobby = conn.lobbyId ? this.lobbies.get(conn.lobbyId) : undefined
    const player = lobby?.getPlayer(conn.playerId)
    if (lobby && player && player.conn === conn) {
      lobby.handleDisconnect(player)
    }
  }

  deleteIfEmpty(lobby: Lobby): void {
    // A lobby with no humans left (bots don't count) is dead.
    const anyone = lobby.humans().length > 0
    if (!anyone) {
      lobby.stopAllBots()
      lobby.match?.dispose()
      this.lobbies.delete(lobby.id)
      this.byCode.delete(lobby.joinCode)
      for (const [tok, entry] of this.tokens) {
        if (entry.lobbyId === lobby.id) this.tokens.delete(tok)
      }
    }
  }

  lobbyOf(conn: ClientConn): Lobby | undefined {
    return conn.lobbyId ? this.lobbies.get(conn.lobbyId) : undefined
  }
}
