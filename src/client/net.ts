import { PING_INTERVAL_MS } from '../shared/constants'
import { makeEnvelope, type C2S, type C2SType, type Envelope, type S2C } from '../shared/types'
import { GameSession } from './session'
import { getState, resetToHome, setState, toast } from './store'

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

interface StoredSession {
  token: string
  lobbyId: string
  name: string
}

function loadStored(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem('tritetris_session')
    return raw ? (JSON.parse(raw) as StoredSession) : null
  } catch {
    return null
  }
}

function saveStored(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem('tritetris_session', JSON.stringify(s))
    else sessionStorage.removeItem('tritetris_session')
  } catch {
    /* ignore */
  }
}

class Net {
  private ws: WebSocket | null = null
  private clockOffset = 0
  private bestRtt = Infinity
  private pingTimer: number | null = null
  private reconnectTimer: number | null = null
  private reconnectDeadline = 0
  private pendingReconnect = false
  rttMs = 0

  readonly session = new GameSession(
    (p) => this.send('player_input', p),
    (matchId) => this.send('resync_request', { match_id: matchId }),
    () => this.serverNow(),
  )

  serverNow(): number {
    return Date.now() + this.clockOffset
  }

  connect(): void {
    setState({ connection: getState().me ? 'reconnecting' : 'connecting' })
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => {
      setState({ connection: 'open' })
      this.startPinging()
      // Resume a live session: mid-conversation socket drop or full page reload.
      const me = getState().me
      const stored = loadStored()
      if (me?.token) {
        this.pendingReconnect = true
        this.send('reconnect', { session_token: me.token, lobby_id: me.lobbyId })
      } else if (stored) {
        this.pendingReconnect = true
        this.send('reconnect', { session_token: stored.token, lobby_id: stored.lobbyId })
      }
    }
    ws.onmessage = (event) => {
      let env: Envelope
      try {
        env = JSON.parse(String(event.data)) as Envelope
      } catch {
        return
      }
      this.route(env)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPinging()
      const st = getState()
      const inMatch = st.phase === 'GAME' && st.me
      if (inMatch) {
        setState({ connection: 'reconnecting' })
        if (this.reconnectDeadline === 0) this.reconnectDeadline = Date.now() + 12000
        if (Date.now() < this.reconnectDeadline) {
          this.reconnectTimer = window.setTimeout(() => this.connect(), 1200)
        } else {
          this.giveUp('Connection lost.')
        }
      } else if (st.me || st.phase !== 'HOME') {
        this.giveUp('Disconnected from server.')
      } else {
        // Idle on the home screen: quietly retry.
        setState({ connection: 'down' })
        this.reconnectTimer = window.setTimeout(() => this.connect(), 2000)
      }
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private giveUp(message: string): void {
    this.reconnectDeadline = 0
    saveStored(null)
    resetToHome()
    setState({ connection: 'down' })
    toast(message, 'error')
    this.reconnectTimer = window.setTimeout(() => this.connect(), 2000)
  }

  private startPinging(): void {
    this.stopPinging()
    let burst = 0
    const ping = (): void => this.send('ping', { client_time: Date.now() })
    ping()
    const burstTimer = window.setInterval(() => {
      ping()
      if (++burst >= 4) window.clearInterval(burstTimer)
    }, 250)
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS)
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  send<T extends C2SType>(type: T, payload: C2S[T]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(makeEnvelope(type, payload)))
  }

  // ---------- inbound routing ----------

  private route(env: Envelope): void {
    const p = env.payload as never
    switch (env.type) {
      case 'pong':
        this.handlePong(p)
        break
      case 'lobby_created':
      case 'lobby_joined':
        this.handleJoined(p)
        break
      case 'lobby_state':
        this.handleLobbyState(p)
        break
      case 'player_joined': {
        const pj = p as S2C['player_joined']
        if (pj.player.player_id !== getState().me?.playerId) toast(`${pj.player.display_name} joined`)
        break
      }
      case 'player_left': {
        const pl = p as S2C['player_left']
        const name = getState().lobby?.players.find((x) => x.player_id === pl.player_id)?.display_name
        if (name && pl.player_id !== getState().me?.playerId) toast(`${name} left (${pl.reason})`)
        break
      }
      case 'player_ready_changed':
        break // lobby_state follows
      case 'match_countdown':
        this.handleCountdown(p)
        break
      case 'match_start': {
        const ms = p as S2C['match_start']
        if (this.session.matchId !== ms.match_id) {
          const me = getState().me
          this.session.resetForMatch(ms.match_id, ms.seed, ms.start_at, me?.playerId ?? '')
        }
        this.session.start(ms.players)
        setState({ phase: 'GAME' })
        break
      }
      case 'player_state':
        this.session.handleSnapshot(p)
        break
      case 'attack_created':
        this.session.handleAttackCreated(p)
        break
      case 'garbage_cancelled':
        break // own meter recomputes from the engine fold; opponents via snapshots
      case 'garbage_applied':
        break // prediction already inserted it; snapshots confirm
      case 'player_eliminated': {
        const pe = p as S2C['player_eliminated']
        this.session.handleEliminated(pe)
        const me = getState().me
        if (pe.player_id === me?.playerId) toast(`You're out — placed #${pe.placement}`, 'error')
        else toast(`${this.session.nameOf(pe.player_id)} is out (#${pe.placement})`, 'attack')
        break
      }
      case 'match_end': {
        const end = p as S2C['match_end']
        this.session.winnerId = end.winner_player_id
        setState({ results: end, rematchVotes: [], phase: 'RESULTS' })
        break
      }
      case 'rematch_status': {
        const rs = p as S2C['rematch_status']
        setState({ rematchVotes: rs.votes })
        break
      }
      case 'state_correction': {
        const sc = p as S2C['state_correction']
        this.session.applyCorrection(sc)
        this.reconnectDeadline = 0
        setState({ phase: 'GAME' })
        toast('Match state restored', 'info')
        break
      }
      case 'error':
        this.handleError(p)
        break
    }
  }

  private handlePong(p: S2C['pong']): void {
    const now = Date.now()
    const rtt = now - p.client_time
    this.rttMs = rtt
    const sample = p.server_time - (p.client_time + rtt / 2)
    if (rtt <= this.bestRtt + 25) {
      this.bestRtt = Math.min(this.bestRtt, rtt)
      this.clockOffset = this.clockOffset === 0 ? sample : this.clockOffset * 0.7 + sample * 0.3
    }
  }

  private handleJoined(p: S2C['lobby_created'] | S2C['lobby_joined']): void {
    const name = getState().lobby?.players.find((x) => x.player_id === p.player_id)?.display_name ?? ''
    setState({
      me: {
        playerId: p.player_id,
        token: p.session_token,
        lobbyId: p.lobby_id,
        joinCode: p.join_code,
        name,
      },
    })
    saveStored({ token: p.session_token, lobbyId: p.lobby_id, name })
    this.pendingReconnect = false
    if (getState().phase === 'HOME') setState({ phase: 'LOBBY' })
  }

  private handleLobbyState(p: S2C['lobby_state']): void {
    setState({ lobby: p, rematchVotes: p.rematch_votes })
    const st = getState()
    if (st.phase === 'GAME' && (p.status === 'WAITING' || p.status === 'READY_CHECK')) {
      // Countdown was cancelled before the match began.
      if (!this.session.started) setState({ phase: 'LOBBY' })
    }
  }

  private handleCountdown(p: S2C['match_countdown']): void {
    const me = getState().me
    this.session.resetForMatch(p.match_id, p.seed, p.start_at, me?.playerId ?? '')
    setState({ phase: 'GAME', results: null })
  }

  private handleError(p: S2C['error']): void {
    if (p.code === 'COUNTDOWN_CANCELLED') {
      toast(p.message, 'error')
      return
    }
    if (p.code === 'RECONNECT_FAILED') {
      if (this.pendingReconnect && !getState().me) {
        // Stale session from a previous page load; stay quietly on HOME.
        this.pendingReconnect = false
        saveStored(null)
        return
      }
      this.giveUp('Could not rejoin the match.')
      return
    }
    toast(p.message || p.code, 'error')
  }

  // ---------- user actions ----------

  createLobby(name: string): void {
    localStorage.setItem('tritetris_name', name)
    this.send('create_lobby', { display_name: name })
  }

  joinLobby(code: string, name: string): void {
    localStorage.setItem('tritetris_name', name)
    this.send('join_lobby', { join_code: code, display_name: name })
  }

  setReady(ready: boolean): void {
    this.send('set_ready', { ready })
  }

  leaveLobby(): void {
    this.send('leave_lobby', {})
    saveStored(null)
    resetToHome()
  }

  voteRematch(): void {
    const matchId = getState().results ? this.session.matchId : ''
    if (matchId) this.send('request_rematch', { match_id: matchId })
  }

  addBot(tier: 'easy' | 'medium' | 'hard'): void {
    this.send('add_bot', { tier })
  }

  removeBot(playerId: string): void {
    this.send('remove_bot', { player_id: playerId })
  }
}

export const net = new Net()
export const session = net.session

// Debug/automation handle (used by tests and dev tooling).
declare global {
  interface Window {
    __TT?: { net: Net; session: GameSession }
  }
}
if (typeof window !== 'undefined') {
  window.__TT = { net, session }
}
