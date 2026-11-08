import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Hash, Send, X } from 'lucide-react'

import type { Inbox } from '@/lib/useInbox'
import { SectionTabs, useSectionLink } from '@/mobile/SectionPager'
import type { Presence } from '@/lib/usePresence'
import type { ShareFile, ShareItem } from '@/lib/share'
import { InboxList, ReceivePrompt, ShareChooser } from './Share'
import { ReceiveWithCode } from './Nearby'

/** The Share window, over the files. */
export function ShareDialog({
  files,
  presence,
  inbox,
  onClose,
  onSaid,
}: {
  files: ShareFile[] | null
  presence: Presence
  inbox: Inbox
  onClose: () => void
  /** What happened, for a line at the bottom of the window. */
  onSaid: (said: string) => void
}): React.JSX.Element {
  useEffect(() => {
    if (!files) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [files, onClose])
  return createPortal(
    <AnimatePresence>
      {files && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose()
          }}
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
        >
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="relative flex max-h-[80vh] w-[440px] flex-col rounded-2xl border border-white/10 bg-panel2 pb-4 pt-4 shadow-lift"
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-textFaint hover:bg-white/[0.06] hover:text-text"
            >
              <X size={16} />
            </button>
            <ShareChooser
              files={files}
              presence={presence}
              inbox={inbox}
              onDone={(said) => {
                onSaid(said)
                onClose()
              }}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/**
 * An offer for this person arriving: a card in the corner until answered.
 * Put away, it waits in the Inbox.
 */
export function OfferCard({ presence, inbox }: { presence: Presence; inbox: Inbox }): React.JSX.Element {
  const [putAway, setPutAway] = useState<Set<string>>(() => new Set())
  const item = inbox.waiting.find((i) => !putAway.has(i.id)) ?? null
  return (
    <AnimatePresence>
      {item && (
        <motion.div
          key={item.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-20 right-5 z-[80] w-[380px] rounded-2xl border border-white/10 bg-panel2 p-4 shadow-lift"
        >
          <button
            onClick={() => setPutAway((s) => new Set(s).add(item.id))}
            aria-label="Later"
            title="Later: it waits in the Inbox"
            className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full text-textFaint hover:bg-white/[0.06] hover:text-text"
          >
            <X size={14} />
          </button>
          <ReceivePrompt item={item} presence={presence} inbox={inbox} compact onDone={() => {}} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** The Inbox page: Received and Sent, each with what waits first. */
export function InboxPage({
  presence,
  inbox,
  onSendLocal,
}: {
  presence: Presence
  inbox: Inbox
  /** Picks files on this computer and opens the Share window for them. */
  onSendLocal: () => void
}): React.JSX.Element {
  const [page, setPage] = useState<'in' | 'out'>('in')
  const [answering, setAnswering] = useState<ShareItem | null>(null)
  const [byCode, setByCode] = useState(false)
  const waiting = inbox.waiting.length
  const link = useSectionLink()
  const pages = [
    { key: 'in', label: waiting > 0 ? `Received · ${waiting}` : 'Received' },
    { key: 'out', label: 'Sent' },
  ]
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-[720px]">
        <div className="flex items-center gap-4">
          <h1 className="text-[20px] font-semibold text-text">Inbox</h1>
          <div className="ml-auto w-[260px]">
            <SectionTabs items={pages} active={page} onChoose={(key) => setPage(key as 'in' | 'out')} link={link} />
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page}
            initial={{ opacity: 0, x: page === 'out' ? 28 : -28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: page === 'out' ? -28 : 28 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {page === 'in' &&
              (byCode ? (
                <div className="mt-4 rounded-2xl border border-white/[0.07] bg-white/[0.03] py-4">
                  <div className="px-5 pb-1 text-[14px] font-semibold text-text">Receive with a code</div>
                  <ReceiveWithCode inbox={inbox} onClose={() => setByCode(false)} />
                </div>
              ) : (
                <button
                  onClick={() => setByCode(true)}
                  className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-left hover:bg-white/[0.05]"
                >
                  <Hash size={17} className="shrink-0 text-textDim" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] text-text">Receive with a code</span>
                    <span className="block text-[12px] text-textFaint">From someone who isn’t in this home, on the same Wi-Fi</span>
                  </span>
                </button>
              ))}
            {page === 'out' && (
              <button
                onClick={onSendLocal}
                className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-left hover:bg-white/[0.05]"
              >
                <Send size={17} className="shrink-0 text-textDim" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-text">Send from this computer</span>
                  <span className="block text-[12px] text-textFaint">Any file on this computer, straight to another device</span>
                </span>
              </button>
            )}
            <p className="mt-3 text-[12.5px] text-textFaint">
              {page === 'in'
                ? 'Files shared with this computer. They go to the folder chosen in Settings, Sharing.'
                : 'Files you shared from this computer, and what became of them.'}
            </p>
            <div className="-mx-5 mt-4">
              <InboxList inbox={inbox} presence={presence} direction={page} onAnswer={setAnswering} />
            </div>
          </motion.div>
        </AnimatePresence>
        {answering && (
          <div className="mt-2 rounded-2xl border border-white/10 bg-panel2 p-4">
            <ReceivePrompt item={answering} presence={presence} inbox={inbox} compact onDone={() => setAnswering(null)} />
          </div>
        )}
      </div>
    </div>
  )
}

/** A line saying what just happened with a share, for a few seconds. */
export function ShareSaid({ said, onGone }: { said: string | null; onGone: () => void }): React.JSX.Element {
  useEffect(() => {
    if (!said) return undefined
    const timer = setTimeout(onGone, 4_000)
    return () => clearTimeout(timer)
  }, [said, onGone])
  return (
    <AnimatePresence>
      {said && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          onClick={onGone}
          className="fixed bottom-16 left-1/2 z-[70] max-w-[440px] -translate-x-1/2 cursor-pointer rounded-full border border-white/10 bg-panel2 px-4 py-2 text-[12.5px] text-text shadow-lift"
        >
          {said}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
