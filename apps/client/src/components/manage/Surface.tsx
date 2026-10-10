import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Sheet } from '@/mobile/Sheet'
import { useLayout } from './parts'

/**
 * Something opened from "Manage host": a device, a profile, the drive list.
 *
 * On a phone it rises from the bottom, where a thumb is, and goes when it is
 * dragged down or backed out of. On a computer it is a panel in the middle of
 * the window, closed by Escape or a click outside, as its other dialogs are.
 */
export function Surface({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  const layout = useLayout()
  if (layout === 'phone') {
    return (
      <Sheet open={open} onClose={onClose} title={title} tall>
        {children}
      </Sheet>
    )
  }
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
            tabIndex={-1}
            ref={focusPanel}
            className="flex max-h-[82vh] w-[440px] flex-col overflow-hidden rounded-lg border border-white/10 bg-panel2 shadow-lift outline-none"
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">{title}</div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-textFaint transition-colors hover:bg-white/[0.06] hover:text-text"
              >
                <X size={14} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * Focused when it opens, so Escape works at once; unless a field inside took
 * the focus first, as the profile name does.
 */
function focusPanel(panel: HTMLDivElement | null): void {
  if (panel && !panel.contains(document.activeElement)) panel.focus()
}
