import { useRef } from 'react'

/**
 * A press that is either a tap or, held, a long press — never both, and
 * neither if the finger moved to scroll.
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
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

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
  }
}
