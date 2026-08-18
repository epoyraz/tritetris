import { useEffect, useRef } from 'react'
import { attachInput } from '../input'
import { net, session } from '../net'
import { OPP_H, OPP_W, OWN_H, OWN_W, drawOpponent, drawOwn } from '../render'
import { getState, useApp } from '../store'

function setupCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

export function GameScreen(): JSX.Element {
  const app = useApp()
  const ownRef = useRef<HTMLCanvasElement>(null)
  const leftRef = useRef<HTMLCanvasElement>(null)
  const rightRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const detachInput = attachInput()
    const ownCtx = setupCanvas(ownRef.current!, OWN_W, OWN_H)
    const leftCtx = setupCanvas(leftRef.current!, OPP_W, OPP_H)
    const rightCtx = setupCanvas(rightRef.current!, OPP_W, OPP_H)
    let raf = 0
    let alive = true

    const opponentIds = (): { id: string; name: string }[] => {
      // During the countdown session.players is empty; fall back to the lobby.
      const fromMatch = session.players.filter((p) => p.player_id !== session.myId)
      if (fromMatch.length > 0) return fromMatch.map((p) => ({ id: p.player_id, name: p.display_name }))
      const lobbyPlayers = netLobbyPlayers()
      return lobbyPlayers.map((p) => ({ id: p.id, name: p.name }))
    }

    const loop = (): void => {
      if (!alive) return
      // Keep the sim current even when rAF was throttled (hidden tab, etc.).
      session.frame()
      drawOwn(ownCtx, session, myDisplayName())
      const opps = opponentIds()
      drawOpponent(leftCtx, opps[0] ? (session.opponents.get(opps[0].id) ?? null) : null, opps[0]?.name ?? '…', session)
      drawOpponent(rightCtx, opps[1] ? (session.opponents.get(opps[1].id) ?? null) : null, opps[1]?.name ?? '…', session)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    // Background safety: advance the sim while the tab is hidden so the local
    // prediction doesn't fall far behind the authoritative server.
    const bgTimer = window.setInterval(() => session.frame(), 250)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.clearInterval(bgTimer)
      detachInput()
    }
  }, [])

  return (
    <div className="game">
      <canvas ref={leftRef} className="opp-canvas" />
      <canvas ref={ownRef} className="own-canvas" />
      <canvas ref={rightRef} className="opp-canvas" />
      <button className="btn btn-ghost leave-match" onClick={() => net.leaveLobby()}>
        Leave match
      </button>
    </div>
  )
}

function myDisplayName(): string {
  const own = session.players.find((p) => p.player_id === session.myId)
  return own?.display_name ?? 'YOU'
}

// Reads the store outside React's render cycle (called from the rAF loop).
function netLobbyPlayers(): { id: string; name: string }[] {
  const state = getState()
  const me = state.me
  return (state.lobby?.players ?? [])
    .filter((p) => p.player_id !== me?.playerId)
    .map((p) => ({ id: p.player_id, name: p.display_name }))
}
