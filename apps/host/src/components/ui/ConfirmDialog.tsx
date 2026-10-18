import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

export interface ConfirmRequest {
  title: string
  message: string
  /** What the button that goes ahead says: "Turn off", not "OK". */
  confirmLabel: string
  /** Going ahead makes something less safe, and the button says so. */
  danger?: boolean
}

/**
 * A question to answer before something is done, the way Manage host on a
 * phone asks it. Cancel is the default: Escape, a click outside and Enter on
 * the first focused button all leave things as they were.
 */
export function ConfirmDialog({
  request,
  onAnswer,
}: {
  request: ConfirmRequest | null
  onAnswer: (yes: boolean) => void
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
          onMouseDown={() => onAnswer(false)}
        >
          <motion.div
            role="alertdialog"
            aria-modal
            aria-labelledby="confirm-title"
            initial={{ opacity: 0, scale: 0.97, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onAnswer(false)
            }}
            className="w-[min(400px,calc(100vw-32px))] rounded-lg border border-white/10 bg-panel2 p-5 shadow-lift"
          >
            <h2 id="confirm-title" className="text-[14px] font-semibold text-text">
              {request.title}
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-textDim">{request.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => onAnswer(false)}
                className="rounded-md px-3.5 py-1.5 text-[12px] text-textDim outline-none transition-colors hover:bg-white/[0.05] hover:text-text focus-visible:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                onClick={() => onAnswer(true)}
                className={
                  request.danger
                    ? 'rounded-md bg-danger px-3.5 py-1.5 text-[12px] font-medium text-ink outline-none transition-opacity hover:opacity-90'
                    : 'rounded-md bg-basalt px-3.5 py-1.5 text-[12px] font-medium text-ink outline-none transition-opacity hover:opacity-90'
                }
              >
                {request.confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
