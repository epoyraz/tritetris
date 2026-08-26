import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  CONNECTION_TIMEOUT_MS,
  MAX_LOBBY_MSGS_PER_SECOND,
  PING_INTERVAL_MS,
} from '../shared/constants'
import type { C2S, Envelope } from '../shared/types'
import { LobbyManager, type ClientConn } from './lobby'
import { serveStatic } from './static'
import { TokenBucket, send, sendError } from './util'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(__dirname, '..', '..', 'dist')

interface ConnState extends ClientConn {
  lobbyBucket: TokenBucket
  pingSentAt: number
}

export interface RunningServer {
  port: number
  httpServer: Server
  close(): Promise<void>
}

export function startServer(port: number): Promise<RunningServer> {
  const manager = new LobbyManager()

  const httpServer = createServer((req, res) => {
    // /healthz is swallowed by Google Frontend on run.app domains, so the
    // health endpoint answers on /api/health as well.
    if (req.url === '/healthz' || req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lobbies: manager.lobbies.size }))
      return
    }
    serveStatic(DIST_DIR, req, res)
  })

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  const conns = new Set<ConnState>()

  wss.on('connection', (ws: WebSocket) => {
    const conn: ConnState = {
      ws,
      lobbyId: null,
      playerId: null,
      lastSeen: Date.now(),
      latencyMs: 0,
      lobbyBucket: new TokenBucket(MAX_LOBBY_MSGS_PER_SECOND, 15),
      pingSentAt: 0,
    }
    conns.add(conn)

    ws.on('message', (data) => {
      conn.lastSeen = Date.now()
      let env: Envelope
      try {
        env = JSON.parse(String(data)) as Envelope
      } catch {
        sendError(ws, 'BAD_MESSAGE', 'Messages must be JSON envelopes.')
        return
      }
      if (typeof env !== 'object' || env === null || typeof env.type !== 'string') {
        sendError(ws, 'BAD_MESSAGE', 'Malformed envelope.')
        return
      }
      const payload = (env.payload ?? {}) as Record<string, unknown>
      route(conn, env.type, payload)
    })

    ws.on('pong', () => {
      conn.lastSeen = Date.now()
      if (conn.pingSentAt > 0) {
        conn.latencyMs = Math.round(Date.now() - conn.pingSentAt)
        conn.pingSentAt = 0
      }
    })

    ws.on('close', () => {
      conns.delete(conn)
      manager.handleSocketClose(conn)
    })

    ws.on('error', () => {
      /* close handler does the cleanup */
    })
  })

  function route(conn: ConnState, type: string, p: Record<string, unknown>): void {
    switch (type) {
      case 'ping':
        send(conn.ws, 'pong', {
          client_time: typeof p.client_time === 'number' ? p.client_time : 0,
          server_time: Date.now(),
        })
        return
      case 'player_input': {
        const lobby = manager.lobbyOf(conn)
        if (!lobby?.match || !conn.playerId) return
        lobby.match.handleInput(conn.playerId, p as unknown as C2S['player_input'])
        return
      }
    }

    // Everything below is lobby-flow traffic, rate limited per the spec.
    if (!conn.lobbyBucket.take()) {
      sendError(conn.ws, 'RATE_LIMITED', 'Too many lobby messages.')
      return
    }

    const lobby = manager.lobbyOf(conn)
    const player = lobby?.getPlayer(conn.playerId)

    switch (type) {
      case 'create_lobby':
        manager.createLobby(conn, p.display_name)
        break
      case 'join_lobby':
        manager.joinLobby(conn, p.join_code, p.display_name)
        break
      case 'reconnect':
        manager.reconnect(conn, p.session_token, p.lobby_id)
        break
      case 'leave_lobby':
        if (lobby && player) lobby.handleLeave(player)
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      case 'set_ready':
        if (lobby && player) lobby.setReady(player, p.ready === true)
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      case 'request_rematch':
        if (lobby && player) lobby.voteRematch(player, String(p.match_id ?? ''))
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      case 'add_bot': {
        const tier = p.tier === 'easy' || p.tier === 'medium' || p.tier === 'hard' ? p.tier : 'medium'
        if (lobby && player) lobby.addBot(player, tier)
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      }
      case 'remove_bot':
        if (lobby && player) lobby.removeBot(player, String(p.player_id ?? ''))
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      case 'set_rules':
        if (lobby && player) lobby.setRules(player, (p.rules ?? {}) as Record<string, boolean>)
        else sendError(conn.ws, 'NOT_IN_LOBBY', 'You are not in a lobby.')
        break
      case 'resync_request': {
        if (lobby?.match && conn.playerId) {
          const correction = lobby.match.handleResyncRequest(conn.playerId)
          if (correction) send(conn.ws, 'state_correction', correction)
        }
        break
      }
      default:
        sendError(conn.ws, 'UNKNOWN_TYPE', `Unknown message type: ${type}`)
    }
  }

  // Liveness: ws-level pings measure latency; stale sockets get terminated.
  const pingTimer = setInterval(() => {
    const now = Date.now()
    for (const conn of conns) {
      if (now - conn.lastSeen > CONNECTION_TIMEOUT_MS) {
        conn.ws.terminate()
        continue
      }
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.pingSentAt = now
        conn.ws.ping()
      }
    }
  }, PING_INTERVAL_MS)

  return new Promise((resolvePromise) => {
    httpServer.listen(port, () => {
      const address = httpServer.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolvePromise({
        port: actualPort,
        httpServer,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pingTimer)
            for (const conn of conns) conn.ws.terminate()
            wss.close()
            httpServer.close(() => done())
          }),
      })
    })
  })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (isMain || process.env.TRITETRIS_SERVE === '1' || process.argv[1]?.endsWith('index.ts')) {
  const port = Number(process.env.PORT ?? 8177)
  startServer(port).then((s) => {
    console.log(`TriTetris server listening on http://localhost:${s.port} (WebSocket: /ws)`)
  })
}
