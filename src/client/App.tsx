import { useApp } from './store'
import { HomeScreen } from './screens/HomeScreen'
import { LobbyScreen } from './screens/LobbyScreen'
import { GameScreen } from './screens/GameScreen'
import { ResultsScreen } from './screens/ResultsScreen'

export function App(): JSX.Element {
  const app = useApp()
  return (
    <div className="app">
      {app.phase === 'HOME' && <HomeScreen />}
      {app.phase === 'LOBBY' && <LobbyScreen />}
      {app.phase === 'GAME' && <GameScreen />}
      {app.phase === 'RESULTS' && <ResultsScreen />}

      {app.connection === 'reconnecting' && app.phase !== 'HOME' && (
        <div className="banner">Reconnecting…</div>
      )}
      {app.connection === 'down' && <div className="banner banner-error">Server unreachable — retrying…</div>}

      <div className="toasts">
        {app.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
