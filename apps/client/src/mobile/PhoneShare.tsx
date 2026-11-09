import { useEffect, useState } from 'react'
import { isAndroid } from '@/lib/platform'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Radio, Send } from 'lucide-react'

import type { AppModel } from '@/App'
import { Switch } from '@/components/Switch'
import { SyncLogPanel } from '@/components/music/SyncLog'
import { InboxList, ReceivePrompt, ShareChooser } from '@/components/share/Share'
import { NearbyPrompt, NearbyReceiving, NearbyScreen, NearbySwitches, useNearbyFollow } from '@/components/share/Nearby'
import type { Nearby } from '@/lib/useNearby'
import { HeldList } from '@/components/share/Held'
import type { ShareItem } from '@/lib/share'
import { Sheet } from './Sheet'
import { SectionPager, SectionTabs, useSectionLink } from './SectionPager'
import { useBack } from './useBack'
import { android } from '@/lib/android'
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
      <Sheet open={sharing !== null} onClose={() => setSharing(null)} tall>
        {sharing && (
          <div>
            <ShareChooser
              sheet
              nearby={model.nearby}
              files={sharing}
              presence={presence}
              inbox={inbox}
              onDone={(said) => {
                setSharing(null)
                if (said) model.setNotice(said)
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
  const nearby = model.nearby
  useBack(open, () => {
    onClose()
    return true
  })
  const waiting = inbox.waiting.length
  const link = useSectionLink()
  const pages = [
    { key: 'in', label: waiting > 0 ? `Received · ${waiting}` : 'Received' },
    { key: 'out', label: 'Sent' },
  ]
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
          <SectionTabs items={pages} active={page} onChoose={(key) => setPage(key as 'in' | 'out')} link={link} />
          <div className="min-h-0 flex-1">
            <SectionPager items={pages} active={page} onChoose={(key) => setPage(key as 'in' | 'out')} link={link}>
              <div className="h-full overflow-y-auto pt-1">
                {page === 'in' && (
                  <button
                    onClick={() => nearby.setScreenOpen(true)}
                    className="mx-3 mb-1 mt-1 flex w-[calc(100%-24px)] items-center gap-3 rounded-2xl bg-[#141416] px-3.5 py-3 text-left active:bg-white/[0.06]"
                  >
                    <span
                      className={
                        nearby.ready
                          ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-400/15 text-sky-300'
                          : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-textDim'
                      }
                    >
                      <Radio size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] text-text">Nearby</span>
                      <span className="block text-[12px] text-textFaint">
                        {nearby.ready
                          ? `Ready to receive${nearby.me ? ` as ${nearby.me.name} · ${nearby.me.id}` : ''}${nearby.alwaysCode ? ', with a code' : ''}`
                          : 'Receive from people outside this home: off'}
                      </span>
                    </span>
                  </button>
                )}
                {page === 'out' && (
                  <button
                    onClick={() =>
                      void android.pickFiles('any').then((files) => {
                        if (files.length === 0) return
                        onClose()
                        model.setSharing(files.map((f) => ({ name: f.name, size: Math.max(0, f.size), path: '', source: f.uri })))
                      })
                    }
                    className="mx-3 mb-1 mt-1 flex w-[calc(100%-24px)] items-center gap-3 rounded-2xl bg-[#141416] px-3.5 py-3 text-left active:bg-white/[0.06]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-textDim">
                      <Send size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14.5px] text-text">Send from this phone</span>
                      <span className="block text-[12px] text-textFaint">Any file on this phone, to a device</span>
                    </span>
                  </button>
                )}
                <InboxList inbox={inbox} presence={presence} nearby={nearby} direction={page} onAnswer={onAnswer} />
              </div>
            </SectionPager>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Nearby on a phone, with or without a drive: the Nearby screen, sliding in
 * over the app, and the sheet that comes up when a device nearby offers
 * something.
 */
export function PhoneNearby({ nearby }: { nearby: Nearby }): React.JSX.Element {
  const [putAway, setPutAway] = useState<Set<string>>(() => new Set())
  const offer = nearby.incoming.find((i) => i.accepted || !putAway.has(i.ask)) ?? null
  const { following, stop } = useNearbyFollow(nearby)
  const open = nearby.screenOpen
  // Ready for devices nearby: kept running when left, as for the home's.
  useEffect(() => {
    if (!nearby.ready || !isAndroid()) return undefined
    void android.keepAlive('nearby', 'Basalt', 'Receiving from devices nearby')
    return () => void android.letGo('nearby')
  }, [nearby.ready])
  useBack(open, () => {
    nearby.setScreenOpen(false)
    return true
  })
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="fixed inset-0 z-[65] flex flex-col bg-ink"
            style={{ paddingTop: 'var(--inset-top, 0px)', paddingBottom: 'var(--inset-bottom, 0px)' }}
          >
            <header className="flex h-14 shrink-0 items-center gap-1 px-1.5">
              <button
                onClick={() => nearby.setScreenOpen(false)}
                aria-label="Back"
                className="flex h-11 w-11 items-center justify-center rounded-full text-text active:bg-white/[0.08]"
              >
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[20px] font-semibold tracking-tight text-text">Nearby</h1>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-4">
              <NearbyScreen
                nearby={nearby}
                phone
                pickFiles={async () => {
                  const files = await android.pickFiles('any')
                  return files.map((f) => ({ name: f.name, size: Math.max(0, f.size), path: '', source: f.uri }))
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Sheet
        open={offer !== null || following !== null}
        onClose={() => {
          if (offer && !offer.accepted) setPutAway((s) => new Set(s).add(offer.ask))
          else if (!offer) stop()
        }}
      >
        {offer ? (
          <div className="pb-[calc(var(--inset-bottom,0px)+18px)]">
            <NearbyPrompt nearby={nearby} offer={offer} />
          </div>
        ) : following ? (
          <div className="pb-[calc(var(--inset-bottom,0px)+18px)]">
            <NearbyReceiving item={following} nearby={nearby} onDone={stop} />
          </div>
        ) : null}
      </Sheet>
    </>
  )
}

/** More's Sharing card: whether the home asks first, and where files land. */
export function SharingCard({ model }: { model: AppModel }): React.JSX.Element {
  const { inbox, presence } = model
  const [alwaysReady, setAlwaysReady] = useAlwaysReady()
  const [heldOpen, setHeldOpen] = useState(false)
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#141416] py-1">
      <div className="px-4 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">Sharing</div>
      <NearbySwitches nearby={model.nearby} className="px-4" />
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
      <Switch
        label="Remove from the host once answered"
        description="When someone accepts or declines what you sent through the host. You can change it for one send."
        checked={inbox.removeOnAnswer}
        onChange={inbox.setRemoveOnAnswer}
        className="px-4"
      />
      <div className="px-4 py-2.5">
        <div className="text-[15px] text-text">Received files go to</div>
        <div className="font-mono text-[12px] text-textFaint">Download/Basalt</div>
      </div>
      <button onClick={() => setHeldOpen(true)} className="flex w-full items-center justify-between px-4 py-2.5 text-left active:bg-white/[0.05]">
        <span className="text-[15px] text-text">Shared through host</span>
        <ChevronRight size={16} className="text-textFaint" />
      </button>
      <div className="px-4 pb-1 pt-3 font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">Music together</div>
      <SyncLogPanel phone />
      <Sheet open={heldOpen} onClose={() => setHeldOpen(false)} title="Shared through host">
        <div className="pb-[calc(var(--inset-bottom,0px)+18px)]">
          <HeldList inbox={inbox} presence={presence} />
        </div>
      </Sheet>
    </div>
  )
}
