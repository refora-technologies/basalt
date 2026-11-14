import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

import { api } from '@/lib/api'
import { useAlwaysReady } from '@/lib/alwaysReady'
import { closeTour, TOUR_VERSION, useTourOpen } from '@/lib/featureTour'
import type { Nearby } from '@/lib/useNearby'
import { isLinuxDesktop, isMobileShell, isTv } from '@/lib/platform'
import { useBack } from '@/mobile/useBack'
import { cn } from '@/lib/utils'
import { Switch } from './Switch'
import { TourArt, type ArtName } from './TourArt'

/**
 * What 1.6.4 brings, shown once after updating to it (see `featureTour`):
 * a few cards, each a moving picture and one line, for the many who look
 * rather than read. Approved as plans/mockups/1.6.4-whats-new.html.
 *
 * Two parts are off until someone turns them on, so their cards carry the
 * real switch: what is turned on here is on in Settings too.
 */

export interface TourCard {
  art: ArtName
  topic: string
  title: string
  /** Said first, in bold: what to press. */
  lead?: string
  line: string
  control?: 'nearby' | 'ready'
}

/** The cards for where this runs. A TV has its own one (see `TvCard`). */
export function cardsFor(where: 'phone' | 'computer', tray: boolean, linux: boolean): TourCard[] {
  const phone = where === 'phone'
  const cards: TourCard[] = [
    {
      art: 'share',
      topic: 'Sharing',
      title: 'Send files to your other devices',
      lead: 'Share',
      line: phone
        ? 'on any file or folder, and it’s on your other device.'
        : linux
          ? 'on any file or folder, or from your file manager, and it’s on your other device.'
          : 'on any file or folder, or Share with Basalt in File Explorer.',
    },
    {
      art: 'nearby',
      topic: 'Devices nearby',
      title: 'Share with anyone nearby',
      line: phone ? 'Phone to phone, no shared Wi-Fi needed.' : 'Device to device, no shared Wi-Fi needed.',
      control: 'nearby',
    },
  ]
  if (phone) {
    cards.push({
      art: 'background',
      topic: 'In the background',
      title: 'Ready even when it’s closed',
      line: 'Files reach you with Basalt swiped away.',
      control: 'ready',
    })
  } else if (tray) {
    cards.push({
      art: 'tray',
      topic: 'In the background',
      title: 'Close the window, stay ready',
      line: 'It waits in the tray and tells you when files come.',
    })
  }
  cards.push({ art: 'music', topic: 'Music together', title: 'One song, on every speaker', line: 'One song on all of them, in step.' })
  return cards
}

export function FeatureTour({ nearby }: { nearby: Nearby }): React.JSX.Element | null {
  const open = useTourOpen()
  if (!open) return null
  if (isTv()) return <TvCard />
  if (isMobileShell()) return <PhoneTour nearby={nearby} />
  return <ComputerTour nearby={nearby} />
}

/** A card's switch, in its box: the same setting as in Settings. */
function Control({ kind, nearby, phone }: { kind: TourCard['control']; nearby: Nearby; phone: boolean }): React.JSX.Element | null {
  const [ready, setReady] = useAlwaysReady()
  if (!kind) return null
  return (
    <div className="mt-5 rounded-2xl border border-white/[0.07] bg-[#151517] px-4 py-1.5">
      {kind === 'nearby' ? (
        <Switch
          label="Receive from devices nearby"
          description={phone ? 'So they can find this phone' : 'So they can find this computer'}
          checked={nearby.ready}
          onChange={nearby.setReady}
        />
      ) : (
        <Switch label="Always ready to receive" description="Uses a little battery" checked={ready} onChange={setReady} />
      )}
    </div>
  )
}

function Dots({ count, at }: { count: number; at: number }): React.JSX.Element {
  return (
    <div className="flex gap-1.5" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={cn('block h-1.5 rounded-full transition-all', i === at ? 'w-[18px] bg-text' : 'w-1.5 bg-white/20')} />
      ))}
    </div>
  )
}

function Words({ card, count, at, big }: { card: TourCard; count: number; at: number; big?: boolean }): React.JSX.Element {
  return (
    <>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">
        {at + 1} of {count} · {card.topic}
      </div>
      <h2 className={cn('mt-2.5 font-bold leading-[1.15] tracking-[-0.02em] text-text [text-wrap:pretty]', big ? 'text-[25px]' : 'text-[24px]')}>{card.title}</h2>
      <p className="mt-3 text-[14.5px] leading-[1.55] text-textDim [text-wrap:pretty]">
        {card.lead && <b className="font-semibold text-text">{card.lead} </b>}
        {card.line}
      </p>
    </>
  )
}

const ART_BOX = 'flex items-center justify-center overflow-hidden rounded-[22px] border border-white/[0.07] bg-[radial-gradient(120%_90%_at_50%_0%,#1E1E22_0%,#111113_70%)]'

/** On a phone: the whole screen, swiped or Next; Back or Skip closes it for good. */
function PhoneTour({ nearby }: { nearby: Nearby }): React.JSX.Element {
  const cards = cardsFor('phone', false, false)
  const [at, setAt] = useState(0)
  const [way, setWay] = useState(1)
  const from = useRef<number | null>(null)
  const last = at === cards.length - 1
  const go = (to: number): void => {
    if (to < 0) return
    if (to >= cards.length) {
      closeTour()
      return
    }
    setWay(to > at ? 1 : -1)
    setAt(to)
  }
  useBack(true, () => {
    closeTour()
    return true
  })
  const card = cards[at]!
  return createPortal(
    <div
      role="dialog"
      aria-modal
      aria-label={`What's new in Basalt ${TOUR_VERSION}`}
      className="fixed inset-0 z-[96] flex flex-col bg-[#0B0B0C]"
      style={{
        paddingTop: 'calc(var(--inset-top, env(safe-area-inset-top, 0px)) + 12px)',
        paddingBottom: 'calc(var(--inset-bottom, env(safe-area-inset-bottom, 0px)) + 20px)',
        paddingLeft: 'calc(var(--inset-left, env(safe-area-inset-left, 0px)) + 22px)',
        paddingRight: 'calc(var(--inset-right, env(safe-area-inset-right, 0px)) + 22px)',
      }}
      onPointerDown={(e) => (from.current = e.clientX)}
      onPointerUp={(e) => {
        if (from.current === null) return
        const moved = e.clientX - from.current
        from.current = null
        if (moved < -50) go(at + 1)
        else if (moved > 50) go(at - 1)
      }}
    >
      <div className="flex h-9 items-center justify-between text-[12.5px] text-textFaint">
        <span>Basalt {TOUR_VERSION}</span>
        {!last && (
          <button type="button" onClick={closeTour} className="-mr-2 px-2 py-1.5 text-[14px] font-semibold text-textFaint active:text-text">
            Skip
          </button>
        )}
      </div>
      <div className="relative mt-3 min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} custom={way} mode="popLayout">
          <motion.div
            key={at}
            custom={way}
            initial={{ opacity: 0, x: way * 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: way * -40 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="flex h-full flex-col gap-6 overflow-y-auto landscape:flex-row landscape:items-center"
          >
            <div className={cn(ART_BOX, 'h-[clamp(160px,34vh,280px)] shrink-0 landscape:h-full landscape:max-h-[300px] landscape:w-[46%]')}>
              <TourArt name={card.art} scale={1.15} />
            </div>
            <div className="min-w-0 landscape:flex-1">
              <Words card={card} count={cards.length} at={at} />
              <Control kind={card.control} nearby={nearby} phone />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="flex items-center pt-4">
        <Dots count={cards.length} at={at} />
        <button
          type="button"
          onClick={() => go(at + 1)}
          className="ml-auto rounded-full bg-text px-6 py-3 text-[14px] font-bold text-black transition-transform active:scale-[0.97]"
        >
          {last ? 'Done' : 'Next'}
        </button>
      </div>
    </div>,
    document.body,
  )
}

/** On a computer: a window over the app, the picture on the left. */
function ComputerTour({ nearby }: { nearby: Nearby }): React.JSX.Element {
  const [tray, setTray] = useState(!isLinuxDesktop())
  useEffect(() => {
    if (!isLinuxDesktop()) return
    void api
      .trayShown()
      .then(setTray)
      .catch(() => {})
  }, [])
  const cards = cardsFor('computer', tray, isLinuxDesktop())
  const [at, setAt] = useState(0)
  const last = at >= cards.length - 1
  const shown = Math.min(at, cards.length - 1)
  const card = cards[shown]!
  const next = (): void => (last ? closeTour() : setAt(shown + 1))
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeTour()
      else if (e.key === 'ArrowRight') setAt((n) => Math.min(n + 1, cards.length - 1))
      else if (e.key === 'ArrowLeft') setAt((n) => Math.max(n - 1, 0))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [cards.length])
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[96] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
    >
      <motion.div
        role="dialog"
        aria-modal
        aria-label={`What's new in Basalt ${TOUR_VERSION}`}
        initial={{ opacity: 0, scale: 0.97, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
        className="flex h-[470px] w-[780px] max-w-[calc(100vw-48px)] overflow-hidden rounded-[22px] border border-white/[0.16] bg-[#121214] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]"
      >
        <div className={cn(ART_BOX, 'w-[310px] shrink-0 rounded-none border-0 border-r border-white/[0.07]')}>
          <TourArt key={card.art} name={card.art} scale={1.12} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col px-[30px] pb-[26px] pt-[30px]">
          <Words card={card} count={cards.length} at={shown} big />
          <Control kind={card.control} nearby={nearby} phone={false} />
          <div className="mt-auto flex items-center gap-3.5">
            <Dots count={cards.length} at={shown} />
            {!last && (
              <button type="button" onClick={closeTour} className="ml-auto px-1 text-[14px] font-semibold text-textFaint hover:text-text">
                Skip
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={next}
              className={cn('rounded-full bg-text px-[22px] py-3 text-[14px] font-bold text-black hover:bg-white', last && 'ml-auto')}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}

/** On a TV: one card, music together (a TV neither sends nor receives files). OK closes it. */
function TvCard(): React.JSX.Element {
  useBack(true, () => {
    closeTour()
    return true
  })
  return createPortal(
    <div
      role="dialog"
      aria-modal
      aria-label={`What's new in Basalt ${TOUR_VERSION}`}
      className="fixed inset-0 z-[96] flex items-center justify-center gap-[50px] bg-[#0B0B0C] px-[70px]"
    >
      <div className={cn(ART_BOX, 'h-[250px] w-[330px] shrink-0')}>
        <TourArt name="music" />
      </div>
      <div className="max-w-[420px]">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">New in Basalt {TOUR_VERSION}</div>
        <h2 className="mt-2.5 text-[30px] font-bold leading-[1.15] tracking-[-0.02em] text-text">Music together</h2>
        <p className="mt-3 text-[17px] leading-[1.55] text-textDim [text-wrap:pretty]">One song here and on your phones, in step.</p>
        <button
          type="button"
          autoFocus
          onClick={closeTour}
          className="mt-7 rounded-full bg-text px-7 py-3.5 text-[16px] font-bold text-black outline-none ring-white ring-offset-4 ring-offset-[#0B0B0C] focus:ring-[3px]"
        >
          OK
        </button>
      </div>
    </div>,
    document.body,
  )
}
