import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

/**
 * A row's "…" menu, drawn over the whole window rather than inside its card:
 * the cards clip what sticks out of them, and a menu on a card's last row
 * was cut off below its first item. Under its button, or above it when the
 * window has no room below; never past the window's edges.
 */
export function PopMenu({
  anchor,
  open,
  onClose,
  width,
  inset,
  children,
}: {
  /** The button it belongs to. */
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  width: number
  /** Items with room around them (rounded ones), rather than edge to edge. */
  inset?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [place, setPlace] = useState<{ top: number; left: number; up: boolean } | null>(null)
  const [menu, setMenu] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPlace(null)
      return undefined
    }
    const put = (): void => {
      const at = anchor.getBoundingClientRect()
      const height = menu?.offsetHeight ?? 0
      const gap = 4
      const roomBelow = window.innerHeight - at.bottom - gap
      const up = height > 0 && roomBelow < height + 8 && at.top > roomBelow
      const top = up ? Math.max(8, at.top - gap - height) : at.bottom + gap
      const left = Math.min(Math.max(8, at.right - width), window.innerWidth - width - 8)
      setPlace({ top, left, up })
    }
    put()
    // Scrolling or resizing moves the button: the menu goes with it.
    window.addEventListener('resize', put)
    window.addEventListener('scroll', put, true)
    return () => {
      window.removeEventListener('resize', put)
      window.removeEventListener('scroll', put, true)
    }
  }, [open, anchor, menu, width])

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Catches the next click anywhere, so it closes the way every other menu does. */}
          <div className="fixed inset-0 z-40" onClick={onClose} />
          <motion.div
            ref={setMenu}
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: place?.up ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.12 }}
            style={{
              position: 'fixed',
              top: place?.top ?? -9999,
              left: place?.left ?? -9999,
              width,
              transformOrigin: place?.up ? 'bottom right' : 'top right',
              visibility: place ? 'visible' : 'hidden',
            }}
            className={`z-50 overflow-hidden rounded-md border border-lineBright bg-panel2 shadow-lift ${inset ? 'p-1' : 'py-1'}`}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}
