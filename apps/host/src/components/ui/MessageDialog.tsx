import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

export interface MessageRequest {
  title: string
  message: string
}

/**
 * Something the window has to say about what was just asked of it, and why.
 *
 * For an answer that cannot wait to be noticed in a line of small print: a
 * button pressed, and nothing happening, reads as the button being broken.
 */
export function MessageDialog({
  request,
  onClose,
}: {
  request: MessageRequest | null
  onClose: () => void
}): React.JSX.Element {
  return createPortal(
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={onClose}
        >
          <motion.div
            role="alertdialog"
            aria-modal
            aria-labelledby="message-title"
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
            }}
            className="w-[min(400px,calc(100vw-32px))] rounded-lg border border-white/10 bg-panel2 p-5 shadow-lift"
          >
            <h2 id="message-title" className="text-[14px] font-semibold text-text">
              {request.title}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-textDim">{request.message}</p>
            <div className="mt-5 flex justify-end">
              <button
                autoFocus
                onClick={onClose}
                className="rounded-md bg-basalt px-3.5 py-1.5 text-[12px] font-medium text-ink outline-none transition-opacity hover:opacity-90"
              >
                Okay
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
