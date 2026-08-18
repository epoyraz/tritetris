import { useState } from 'react'
import { net } from '../net'
import { useApp } from '../store'

export function HomeScreen(): JSX.Element {
  const app = useApp()
  const [name, setName] = useState(() => localStorage.getItem('tritetris_name') ?? '')
  const [code, setCode] = useState('')
  const canAct = app.connection === 'open' && name.trim().length > 0

  return (
    <div className="home">
      <h1 className="logo">
        TRI<span>TETRIS</span>
      </h1>
      <p className="tagline">Three boards. One survivor. Clear lines, bury your rivals in garbage.</p>

      <div className="card">
        <label className="field">
          <span>Display name</span>
          <input
            value={name}
            maxLength={16}
            placeholder="Enter your name"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>

        <button className="btn btn-primary" disabled={!canAct} onClick={() => net.createLobby(name.trim())}>
          Create lobby
        </button>

        <div className="divider">or join with a code</div>

        <div className="join-row">
          <input
            className="code-input"
            value={code}
            maxLength={6}
            placeholder="ABC123"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canAct && code.length === 6) net.joinLobby(code, name.trim())
            }}
          />
          <button
            className="btn"
            disabled={!canAct || code.length !== 6}
            onClick={() => net.joinLobby(code, name.trim())}
          >
            Join
          </button>
        </div>
      </div>

      <div className="controls-help">
        <h3>Controls</h3>
        <div className="keys">
          <div><kbd>←</kbd><kbd>→</kbd> move</div>
          <div><kbd>↓</kbd> soft drop</div>
          <div><kbd>Space</kbd> hard drop</div>
          <div><kbd>↑</kbd>/<kbd>X</kbd> rotate CW</div>
          <div><kbd>Z</kbd>/<kbd>Ctrl</kbd> rotate CCW</div>
          <div><kbd>C</kbd>/<kbd>Shift</kbd> hold</div>
        </div>
      </div>
    </div>
  )
}
