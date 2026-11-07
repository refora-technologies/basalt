import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft } from 'lucide-react'

import type { AppModel } from '@/App'
import { Switch } from '@/components/Switch'
import { InboxList, ReceivePrompt, ShareChooser } from '@/components/share/Share'
import type { ShareItem } from '@/lib/share'
import { cn } from '@/lib/utils'
import { Sheet } from './Sheet'
import { useBack } from './useBack'
import { useAlwaysReady } from '@/lib/alwaysReady'

/**
 * Sharing on a phone: the Share sheet for the files chosen, the sheet that
 * comes up when a share arrives, and the Inbox screen.
 */
export function PhoneShare({
  model,
  inboxOpen,
  onCloseInbox,
}: {
  model: AppModel
  inboxOpen: boolean
  onCloseInbox: () => void
}): React.JSX.Element {
  const { presence, inbox, sharing, setSharing } = model
  // Offers put aside with the back gesture: they wait in the Inbox.
  const [putAway, setPutAway] = useState<Set<string>>(() => new Set())
  const [answering, setAnswering] = useState<ShareItem | null>(null)
  const arrived = answering ?? inbox.waiting.find((i) => !putAway.has(i.id)) ?? null

  return (
    <>
      <Sheet open={sharing !== null} onClose={() => setSharing(null)}>
        {sharing && (
          <div className="pb-[calc(var(--inset-bottom,0px)+18px)]">
            <ShareChooser
              files={sharing}
              presence={presence}
              inbox={inbox}
              onDone={(said) => {
                setSharing(null)
                model.setNotice(said)
              }}
            />
          </div>
        )}
      </Sheet>

      <Sheet
        open={arrived !== null && sharing === null}
        onClose={() => {
          if (arrived) setPutAway((s) => new Set(s).add(arrived.id))
          setAnswering(null)
        }}
      >
        {arrived && (
          <div className="pb-[calc(var(--inset-bottom,0px)+18px)]">
            <ReceivePrompt
              item={arrived}
              presence={presence}
              inbox={inbox}
              onDone={() => {
                setPutAway((s) => new Set(s).add(arrived.id))
                setAnswering(null)
              }}
            />
          </div>
        )}
      </Sheet>

      <InboxScreen model={model} open={inboxOpen} onClose={onCloseInbox} onAnswer={setAnswering} />
    </>
  )
}

/** The Inbox: Received and Sent, a page each, the Library's own control on top. */
function InboxScreen({
  model,
  open,
  onClose,
  onAnswer,
}: {
  model: AppModel
  open: boolean
  onClose: () => void
  onAnswer: (item: ShareItem) => void
}): React.JSX.Element {
  const { presence, inbox } = model
  const [page, setPage] = useState<'in' | 'out'>('in')
  useBack(open, () => {
    onClose()
    return true
  })
  const waiting = inbox.waiting.length
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          className="fixed inset-0 z-[60] flex flex-col bg-ink"
          style={{ paddingTop: 'var(--inset-top, 0px)', paddingBottom: 'var(--inset-bottom, 0px)' }}
        >
          <header className="flex h-14 shrink-0 items-center gap-1 px-1.5">
            <button
              onClick={onClose}
              aria-label="Back"
              className="flex h-11 w-11 items-center justify-center rounded-full text-text active:bg-white/[0.08]"
            >
              <ChevronLeft size={24} />
            </button>
            <h1 className="text-[20px] font-semibold tracking-tight text-text">Inbox</h1>
          </header>
          <div className="shrink-0 px-4 pb-2.5 pt-1">
            <div className="flex rounded-full border border-white/[0.07] bg-white/[0.04] p-1">
              {(['in', 'out'] as const).map((which) => (
                <button
                  key={which}
                  onClick={() => setPage(which)}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-[13.5px]',
                    page === which ? 'bg-white font-semibold text-black shadow-[0_2px_10px_rgba(0,0,0,0.35)]' : 'text-textDim',
                  )}
                >
                  {which === 'in' ? 'Received' : 'Sent'}
                  {which === 'in' && waiting > 0 && (
                    <span
                      className={cn(
                        'min-w-[17px] rounded-full px-1 font-mono text-[10px] font-bold leading-[17px]',
                        page === 'in' ? 'bg-black text-white' : 'bg-white text-black',
                      )}
                    >
                      {waiting}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <InboxList inbox={inbox} presence={presence} direction={page} onAnswer={onAnswer} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** More's Sharing card: whether the home asks first, and where files land. */
export function SharingCard({ model }: { model: AppModel }): React.JSX.Element {
  const { inbox } = model
  const [alwaysReady, setAlwaysReady] = useAlwaysReady()
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#141416] py-1">
      <div className="px-4 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">Sharing</div>
      <Switch
        label="Always ready to receive"
        description="Basalt stays ready when you leave it, and tells you when something comes. Android shows a quiet notification while it’s ready."
        checked={alwaysReady}
        onChange={setAlwaysReady}
        className="px-4"
      />
      <Switch
        label="Accept files from this home without asking"
        description="From the other profiles on this host. Your own devices never ask."
        checked={inbox.acceptFromHome}
        onChange={inbox.setAcceptFromHome}
        className="px-4"
      />
      <div className="px-4 py-2.5">
        <div className="text-[15px] text-text">Received files go to</div>
        <div className="font-mono text-[12px] text-textFaint">Download/Basalt</div>
      </div>
    </div>
  )
}
