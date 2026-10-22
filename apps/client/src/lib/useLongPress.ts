import { useRef } from 'react'

/**
 * OK, held for a long press, goes on repeating until it is let go. What the
 * long press opened takes the focus at once (see lib/remote.ts), and the
 * repeats pressed its first item: holding OK on a folder opened the folder,
 * by the "Open" of its menu. The rest of that press is swallowed here.
 */
let swallowing = false
let listening = false

function swallowRestOfPress(): void {
  swallowing = true
  if (listening || typeof window === 'undefined') return
  listening = true
  const swallow = (e: KeyboardEvent): void => {
    if (!swallowing || e.key !== 'Enter') return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.type === 'keyup') swallowing = false
  }
  window.addEventListener('keydown', swallow, { capture: true })
  window.addEventListener('keyup', swallow, { capture: true })
}

/**
 * A press that is either a tap or, held, a long press — never both, and
 * neither if the finger moved to scroll.
 *
 * By key too, for a television's remote: OK is the tap, and OK held (as
 * long as a finger would be) or the menu key is the long press. So the
 * thing can be reached by the remote at all, it takes the focus.
 */
export function useLongPress(
  onLong: () => void,
  onTap: () => void,
): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onKeyUp: (e: React.KeyboardEvent) => void
  tabIndex: number
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  /** OK is down, and has not yet been let go. */
  const held = useRef(false)

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(() => {
        fired.current = true
        timer.current = null
        onLong()
      }, 450)
    },
    onPointerMove: (e) => {
      const s = start.current
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) {
        clear()
        start.current = null
      }
    },
    onPointerUp: () => {
      const wasTap = timer.current !== null && !fired.current && start.current !== null
      clear()
      start.current = null
      if (wasTap) onTap()
    },
    onPointerCancel: () => {
      clear()
      start.current = null
    },
    // A long press also fires the browser's context menu; this is ours.
    onContextMenu: (e) => e.preventDefault(),
    onKeyDown: (e) => {
      // A button inside (a row's menu) presses itself.
      if (e.target !== e.currentTarget) return
      if (e.key === 'ContextMenu') {
        e.preventDefault()
        onLong()
        return
      }
      if (e.key !== 'Enter') return
      // Not the button's own click as well: the tap comes as OK is let go.
      e.preventDefault()
      if (!held.current) {
        // OK held as long as a finger would be is the long press. By time,
        // as a finger's is: a TV's WebView sends the remote's repeats as
        // fresh presses, not marked as repeats.
        held.current = true
        fired.current = false
        clear()
        timer.current = setTimeout(() => {
          timer.current = null
          if (held.current && !fired.current) {
            fired.current = true
            held.current = false
            swallowRestOfPress()
            onLong()
          }
        }, 450)
      } else if (!fired.current) {
        // A second press before the first was let go: the remote repeating.
        clear()
        fired.current = true
        held.current = false
        swallowRestOfPress()
        onLong()
      }
    },
    onKeyUp: (e) => {
      if (e.target !== e.currentTarget || e.key !== 'Enter' || !held.current) return
      held.current = false
      clear()
      if (!fired.current) onTap()
    },
    tabIndex: 0,
  }
}
