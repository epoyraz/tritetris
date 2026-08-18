import { useSyncExternalStore } from 'react'
import type { LobbyStatePayload, S2C } from '../shared/types'

export type Phase = 'HOME' | 'LOBBY' | 'GAME' | 'RESULTS'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'attack'
}

export interface AppState {
  phase: Phase
  connection: 'connecting' | 'open' | 'reconnecting' | 'down'
  me: { playerId: string; token: string; lobbyId: string; joinCode: string; name: string } | null
  lobby: LobbyStatePayload | null
  results: S2C['match_end'] | null
  rematchVotes: string[]
  toasts: Toast[]
}

let state: AppState = {
  phase: 'HOME',
  connection: 'connecting',
  me: null,
  lobby: null,
  results: null,
  rematchVotes: [],
  toasts: [],
}

const listeners = new Set<() => void>()
let toastId = 0

export function getState(): AppState {
  return state
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState)
}

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t: Toast = { id: ++toastId, text, kind }
  setState({ toasts: [...state.toasts, t].slice(-5) })
  setTimeout(() => {
    setState({ toasts: getState().toasts.filter((x) => x.id !== t.id) })
  }, 4000)
}

export function resetToHome(): void {
  setState({ phase: 'HOME', me: null, lobby: null, results: null, rematchVotes: [] })
}
