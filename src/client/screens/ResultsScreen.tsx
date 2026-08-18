import { REQUIRED_PLAYERS } from '../../shared/constants'
import type { PlayerStats } from '../../shared/types'
import { net, session } from '../net'
import { useApp } from '../store'

const MEDALS = ['🥇', '🥈', '🥉']

const STAT_ROWS: { key: keyof PlayerStats; label: string; fmt?: (v: number) => string }[] = [
  { key: 'score', label: 'Score' },
  { key: 'total_lines_cleared', label: 'Lines' },
  { key: 'pieces_placed', label: 'Pieces' },
  { key: 'pieces_per_second', label: 'PPS' },
  { key: 'singles', label: 'Singles' },
  { key: 'doubles', label: 'Doubles' },
  { key: 'triples', label: 'Triples' },
  { key: 'tetrises', label: 'Tetrises' },
  { key: 't_spins', label: 'T-Spins' },
  { key: 'perfect_clears', label: 'Perfect clears' },
  { key: 'highest_combo', label: 'Best combo' },
  { key: 'garbage_sent', label: 'Garbage sent' },
  { key: 'garbage_received', label: 'Garbage received' },
  { key: 'garbage_cancelled', label: 'Garbage blocked' },
  { key: 'survival_time_ms', label: 'Survived', fmt: (v) => `${(v / 1000).toFixed(1)}s` },
]

export function ResultsScreen(): JSX.Element {
  const app = useApp()
  const results = app.results
  if (!results) return <div className="home"><p>Loading results…</p></div>

  const winnerName = results.winner_player_id ? session.nameOf(results.winner_player_id) : '—'
  const iWon = results.winner_player_id === app.me?.playerId
  const canRematch =
    app.lobby?.status === 'FINISHED' && (app.lobby?.players.length ?? 0) === REQUIRED_PLAYERS
  const iVoted = app.rematchVotes.includes(app.me?.playerId ?? '')
  const ranked = [...results.ranking].sort((a, b) => a.placement - b.placement)

  return (
    <div className="results">
      <h1 className="logo logo-small">
        TRI<span>TETRIS</span>
      </h1>
      <h2 className={`winner-line ${iWon ? 'is-me' : ''}`}>
        {iWon ? '🏆 VICTORY!' : `🏆 ${winnerName} wins!`}
      </h2>

      <div className="podium">
        {ranked.map((r) => (
          <div key={r.player_id} className={`podium-card place-${r.placement}`}>
            <div className="medal">{MEDALS[r.placement - 1] ?? r.placement}</div>
            <div className="podium-name">
              {session.nameOf(r.player_id)}
              {r.player_id === app.me?.playerId && <span className="you-tag">you</span>}
            </div>
            <div className="podium-place">#{r.placement}</div>
          </div>
        ))}
      </div>

      <table className="stats-table">
        <thead>
          <tr>
            <th />
            {ranked.map((r) => (
              <th key={r.player_id}>{session.nameOf(r.player_id)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STAT_ROWS.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              {ranked.map((r) => {
                const stats = results.statistics[r.player_id]
                const value = stats ? (stats[row.key] as number) : 0
                return <td key={r.player_id}>{row.fmt ? row.fmt(value ?? 0) : String(value ?? 0)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="lobby-actions">
        <button className="btn btn-primary" disabled={!canRematch || iVoted} onClick={() => net.voteRematch()}>
          {iVoted ? 'Waiting…' : 'Rematch'} ({app.rematchVotes.length}/{REQUIRED_PLAYERS})
        </button>
        <button className="btn btn-danger" onClick={() => net.leaveLobby()}>
          Leave
        </button>
      </div>
      {!canRematch && <p className="hint">Rematch needs all three players connected in the lobby.</p>}
    </div>
  )
}
