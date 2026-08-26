import { useState } from 'react'
import { REQUIRED_PLAYERS } from '../../shared/constants'
import { net } from '../net'
import { useApp } from '../store'

export function LobbyScreen(): JSX.Element {
  const app = useApp()
  const [copied, setCopied] = useState(false)
  const lobby = app.lobby
  const me = app.me
  if (!lobby || !me) return <div className="home"><p>Loading lobby…</p></div>

  const missing = REQUIRED_PLAYERS - lobby.players.length
  const self = lobby.players.find((p) => p.player_id === me.playerId)
  const readyEnabled = lobby.status === 'READY_CHECK' || lobby.status === 'FINISHED'
  const amHost = self?.host === true
  const rulesLocked = lobby.status === 'COUNTDOWN'

  const copyCode = (): void => {
    void navigator.clipboard?.writeText(lobby.join_code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="lobby">
      <h1 className="logo logo-small">
        TRI<span>TETRIS</span>
      </h1>

      <div className="code-banner">
        <span className="code-label">LOBBY CODE</span>
        <span className="code-value">{lobby.join_code}</span>
        <button className="btn btn-ghost" onClick={copyCode}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div className="slots">
        {([1, 2, 3] as const).map((slot) => {
          const p = lobby.players.find((x) => x.slot === slot)
          const iAmHost = lobby.players.some((x) => x.player_id === me.playerId && x.host)
          return (
            <div key={slot} className={`slot-card ${p ? (p.ready ? 'ready' : 'filled') : 'empty'}`}>
              <div className="slot-num">P{slot}</div>
              {p ? (
                <>
                  <div className="slot-name">
                    {p.display_name}
                    {p.host && <span className="host-tag" title="Host">★</span>}
                    {p.player_id === me.playerId && <span className="you-tag">you</span>}
                  </div>
                  <div className={`slot-status ${p.ready ? 'st-ready' : ''}`}>
                    {!p.connected ? 'Reconnecting…' : p.ready ? 'READY' : 'Connected'}
                  </div>
                  {p.connected && !p.is_bot && p.latency_ms > 0 && <div className="ping">{p.latency_ms} ms</div>}
                  {p.is_bot && iAmHost && lobby.status !== 'COUNTDOWN' && (
                    <button className="btn btn-ghost bot-remove" onClick={() => net.removeBot(p.player_id)}>
                      ✕ remove
                    </button>
                  )}
                </>
              ) : iAmHost && lobby.status === 'WAITING' ? (
                <div className="bot-add">
                  <div className="slot-waiting">Waiting for player…</div>
                  <div className="bot-add-label">or add a bot:</div>
                  <div className="bot-add-row">
                    <button className="btn btn-ghost" onClick={() => net.addBot('easy')}>🤖 Easy</button>
                    <button className="btn btn-ghost" onClick={() => net.addBot('medium')}>🤖 Medium</button>
                    <button className="btn btn-ghost" onClick={() => net.addBot('hard')}>🤖 Hard</button>
                  </div>
                </div>
              ) : (
                <div className="slot-waiting">Waiting for player…</div>
              )}
            </div>
          )
        })}
      </div>

      <div className="rules-panel">
        <span className="rules-label">MATCH RULES</span>
        <div className="rule-row">
          <span>Hard drop (Space)</span>
          <button
            className={`btn btn-ghost rule-toggle ${lobby.rules.allow_hard_drop ? 'rule-on' : 'rule-off'}`}
            disabled={!amHost || rulesLocked}
            title={amHost ? 'Toggle hard drop for the next match' : 'Only the host can change rules'}
            onClick={() => net.setRules({ allow_hard_drop: !lobby.rules.allow_hard_drop })}
          >
            {lobby.rules.allow_hard_drop ? 'ENABLED' : 'DISABLED'}
          </button>
        </div>
      </div>

      <p className="lobby-message">
        {missing > 0
          ? `Waiting for ${missing} more player${missing > 1 ? 's' : ''}…`
          : lobby.status === 'COUNTDOWN'
            ? 'Match starting…'
            : 'All players present — ready up!'}
      </p>

      <div className="lobby-actions">
        <button
          className={`btn ${self?.ready ? '' : 'btn-primary'}`}
          disabled={!readyEnabled}
          onClick={() => net.setReady(!self?.ready)}
        >
          {self?.ready ? 'Unready' : 'Ready'}
        </button>
        <button className="btn btn-danger" onClick={() => net.leaveLobby()}>
          Leave lobby
        </button>
      </div>
    </div>
  )
}
