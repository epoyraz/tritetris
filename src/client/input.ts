import type { InputAction } from '../shared/types'
import { session } from './net'

// Handling: DAS (delayed auto shift) + ARR for left/right, fixed repeat for
// soft drop. Non-repeating: hard drop, rotates, hold.
const DAS_MS = 133
const ARR_MS = 33
const SOFT_MS = 33

interface HeldKey {
  pressedAt: number
  lastRepeat: number
  dasCharged: boolean
}

const held = new Map<string, HeldKey>()
let rafId: number | null = null

type Binding = { action: InputAction; repeat: 'das' | 'soft' | 'none' }

const BINDINGS: Record<string, Binding> = {
  ArrowLeft: { action: 'MOVE_LEFT', repeat: 'das' },
  ArrowRight: { action: 'MOVE_RIGHT', repeat: 'das' },
  ArrowDown: { action: 'SOFT_DROP', repeat: 'soft' },
  Space: { action: 'HARD_DROP', repeat: 'none' },
  ArrowUp: { action: 'ROTATE_CW', repeat: 'none' },
  KeyX: { action: 'ROTATE_CW', repeat: 'none' },
  KeyZ: { action: 'ROTATE_CCW', repeat: 'none' },
  ControlLeft: { action: 'ROTATE_CCW', repeat: 'none' },
  KeyC: { action: 'HOLD', repeat: 'none' },
  ShiftLeft: { action: 'HOLD', repeat: 'none' },
}

function onKeyDown(e: KeyboardEvent): void {
  const binding = BINDINGS[e.code]
  if (!binding) return
  e.preventDefault()
  if (e.repeat) return // we do our own repeat
  if (held.has(e.code)) return
  const now = performance.now()
  held.set(e.code, { pressedAt: now, lastRepeat: now, dasCharged: false })
  // Left/right are exclusive: pressing one cancels the other's auto-repeat.
  if (e.code === 'ArrowLeft') held.delete('ArrowRight')
  if (e.code === 'ArrowRight') held.delete('ArrowLeft')
  session.act(binding.action)
}

function onKeyUp(e: KeyboardEvent): void {
  if (BINDINGS[e.code]) {
    e.preventDefault()
    held.delete(e.code)
  }
}

function repeatLoop(): void {
  const now = performance.now()
  for (const [code, state] of held) {
    const binding = BINDINGS[code]
    if (!binding || binding.repeat === 'none') continue
    if (binding.repeat === 'das') {
      if (!state.dasCharged) {
        if (now - state.pressedAt >= DAS_MS) {
          state.dasCharged = true
          state.lastRepeat = now
          session.act(binding.action)
        }
      } else if (now - state.lastRepeat >= ARR_MS) {
        state.lastRepeat = now
        session.act(binding.action)
      }
    } else if (now - state.lastRepeat >= SOFT_MS) {
      state.lastRepeat = now
      session.act(binding.action)
    }
  }
  rafId = requestAnimationFrame(repeatLoop)
}

export function attachInput(): () => void {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  const blur = (): void => held.clear()
  window.addEventListener('blur', blur)
  rafId = requestAnimationFrame(repeatLoop)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', blur)
    if (rafId !== null) cancelAnimationFrame(rafId)
    held.clear()
  }
}
