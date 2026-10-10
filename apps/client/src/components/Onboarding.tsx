import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Download, Globe, Keyboard, Send } from 'lucide-react'
import { OnboardingScene } from './OnboardingScene'
import { api, type DiscoveredHost } from '@/lib/api'
import { android } from '@/lib/android'
import { HOST_DOWNLOAD, WEBSITE, openExternal } from '@/lib/links'
import { isMobileShell } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useBack } from '@/mobile/useBack'

const KEY = 'basalt.onboarded'

/** Whether this device has been through the introduction. */
export function onboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    // Not remembered: the introduction shows again next time, nothing worse.
  }
}

/** The four pages of explanation, then the search. */
const LAST = 4
const EASE = [0.22, 1, 0.36, 1] as const
/** How often the last page looks again while nothing has been found. */
const RESCAN_MS = 4000

/**
 * What Basalt is, for someone who installed only this app.
 *
 * Basalt is two apps, and an app store or a download page shows only one of
 * them. Someone who installed the player and opened it met a list of hosts
 * with nothing in it, and a note to check that a program they had never
 * heard of was running. This says, before anything else, that the files are
 * on their own computer and that a second app there shares them, and then
 * it looks for that computer itself.
 *
 * One picture runs through every page, and its pieces move between pages
 * rather than being replaced: the files go into the computer, the computer
 * steps aside for this device, a link is drawn between them, the PIN appears
 * over the link. Then the same picture searches: the computer appears, by
 * name, when its host answers.
 *
 * The search starts the moment this opens, so by the last page it is usually
 * known whether there is a host on the network. While there is none, it keeps
 * looking, so the person can install the host and watch their computer
 * arrive.
 */
export function Onboarding({
  onDone,
  onLeave,
}: {
  onDone: () => void
  /** Back from the first page, when it was opened from the drive list to see again. */
  onLeave?: () => void
}): React.JSX.Element {
  const phone = isMobileShell()
  const [step, setStep] = useState(0)
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null)
  const live = useRef(true)

  const scan = useCallback(async () => {
    try {
      const found = await api.discover()
      if (live.current) setHosts(found)
    } catch {
      if (live.current) setHosts((now) => now ?? [])
    }
  }, [])

  useEffect(() => {
    live.current = true
    void scan()
    return () => {
      live.current = false
    }
  }, [scan])

  const found = hosts !== null && hosts.length > 0
  useEffect(() => {
    if (step !== LAST || found) return undefined
    const timer = setInterval(() => void scan(), RESCAN_MS)
    return () => clearInterval(timer)
  }, [step, found, scan])

  // A computer arriving while the person watches is worth a tap they can feel.
  const announced = useRef(false)
  useEffect(() => {
    if (found && step === LAST && !announced.current) {
      announced.current = true
      void android.haptic('confirm')
    }
  }, [found, step])

  const go = useCallback((next: number) => {
    setStep(Math.max(0, Math.min(LAST, next)))
    void android.haptic('tap')
  }, [])

  // Back goes a page back; from the first, back to the drive list if that is
  // where it was opened from, and otherwise out of the app as usual.
  useBack(step > 0 || onLeave !== undefined, () => {
    if (step > 0) go(step - 1)
    else onLeave?.()
    return true
  })

  // On a phone the pages turn with a swipe too.
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent): void => {
    const t = e.touches[0]
    touch.current = t ? { x: t.clientX, y: t.clientY } : null
  }
  const onTouchEnd = (e: React.TouchEvent): void => {
    const from = touch.current
    const t = e.changedTouches[0]
    touch.current = null
    if (!from || !t || step === LAST) return
    const dx = t.clientX - from.x
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(t.clientY - from.y) * 1.5) return
    go(step + (dx < 0 ? 1 : -1))
  }

  const page = PAGES[step]

  return (
    <div
      className="relative flex h-full flex-col items-center overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="backdrop" />

      <div
        className={cn(
          'relative z-10 flex h-full w-full flex-col',
          phone ? 'px-6 pb-5 pt-3' : 'max-w-[480px] justify-center px-8 py-8',
        )}
      >
        {/* Top: a way back, and a way past the explanation. */}
        <div className="flex h-10 shrink-0 items-center justify-between">
          <button
            onClick={() => go(step - 1)}
            aria-label="Back"
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-full text-textDim transition-opacity hover:text-text',
              step === 0 && 'pointer-events-none opacity-0',
            )}
          >
            <ArrowLeft size={18} />
          </button>
          {step < LAST && (
            <button
              onClick={() => go(LAST)}
              className="rounded-full px-3 py-1.5 text-[13px] text-textDim transition-colors hover:text-text"
            >
              Skip
            </button>
          )}
        </div>

        <div className={cn('flex min-h-0 flex-col', phone ? 'flex-1' : '')}>
          {/* On a phone the picture takes whatever height the words leave. */}
          <div
            className={cn(
              'relative mx-auto flex w-full items-center justify-center',
              phone ? 'min-h-[150px] max-w-[440px] flex-1' : 'h-[240px] max-w-[420px]',
            )}
          >
            <OnboardingScene step={step} phone={phone} hosts={hosts} />
          </div>

          <div
            className={cn(
              'relative shrink-0',
              // The same height on every page, so nothing jumps as they turn;
              // the last page's buttons need more.
              phone ? (step === LAST ? 'mt-2' : 'mt-2 min-h-[196px]') : 'mt-6 min-h-[220px]',
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step === LAST ? `last-${found}` : step}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.28, ease: EASE }}
              >
                {step < LAST && page ? (
                  <>
                    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-textFaint">
                      {page.eyebrow}
                    </div>
                    <h1 className="mt-2.5 font-display text-[24px] font-semibold leading-[1.15] tracking-tighter text-text">
                      {page.title}
                    </h1>
                    <p className="mt-3 text-[14px] leading-relaxed text-textDim">
                      {page.body(phone)}
                    </p>
                  </>
                ) : (
                  <Finding phone={phone} hosts={hosts} onDone={onDone} />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {step < LAST && (
          <div className={cn('flex shrink-0 items-center justify-between gap-4', phone ? 'pt-4' : 'mt-8')}>
            <Dots step={step} onGo={go} />
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={() => go(step + 1)}
              className="flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[14px] font-semibold text-black transition-opacity hover:opacity-90"
            >
              {step === LAST - 1 ? 'Find my computer' : 'Continue'}
              <ArrowRight size={16} />
            </motion.button>
          </div>
        )}
      </div>
    </div>
  )
}

const PAGES: Array<{ eyebrow: string; title: string; body: (phone: boolean) => string }> = [
  {
    eyebrow: 'Welcome to Basalt',
    title: 'Your own drive, on every device',
    body: () =>
      'Basalt opens the files on your own computer from your phone and every other device: films and shows to stream, photos, music, documents, anything. No cloud in between.',
  },
  {
    eyebrow: 'Where it starts',
    title: 'Your files stay on your computer',
    body: () =>
      'Everything stays where it already is, on your computer and its drives. Basalt never sends it to a cloud or keeps a copy anywhere else.',
  },
  {
    eyebrow: 'Two apps, one drive',
    title: 'Basalt Host shares it',
    body: (phone) =>
      `A small free app, Basalt Host, runs on that computer and shares its drive over your home network. This ${
        phone ? 'app' : 'one'
      } opens what it shares: browse, stream, upload and download. You need both.`,
  },
  {
    eyebrow: 'Once, and done',
    title: 'Pair, and it just opens',
    body: (phone) =>
      `Pick your computer from a list and type the six digits it shows. This ${
        phone ? 'phone' : 'computer'
      } remembers it, and from then on Basalt opens straight to your drive.`,
  },
]

/** The last page: what was found, or how to get the host. */
function Finding({
  phone,
  hosts,
  onDone,
}: {
  phone: boolean
  hosts: DiscoveredHost[] | null
  onDone: () => void
}): React.JSX.Element {
  const found = hosts ?? []
  const named = found.length === 1 ? found[0]!.hostName : null

  if (hosts === null) {
    return (
      <>
        <Eyebrow>Looking on this network</Eyebrow>
        <Title>Looking for your computer…</Title>
        <Body>Basalt Host answers on your Wi-Fi when it’s running. This takes a second.</Body>
      </>
    )
  }

  if (found.length > 0) {
    return (
      <>
        <Eyebrow>Found on this network</Eyebrow>
        <Title>{named ? `${named} is ready` : `${found.length} computers are ready`}</Title>
        <Body>
          {named
            ? `Basalt Host is running there. Pair with it and your drive opens.`
            : 'Each is running Basalt Host. Choose the one with your files, and pair with it.'}
        </Body>
        <Primary onClick={onDone} icon={<ArrowRight size={16} />} trailing>
          {named ? `Pair with ${named}` : 'Choose your computer'}
        </Primary>
      </>
    )
  }

  return (
    <>
      <Eyebrow>
        <span className="relative mr-2 inline-flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-white/60" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-white/80" />
        </span>
        Still looking
      </Eyebrow>
      <Title>No Basalt Host on this network yet</Title>
      <Body>
        {phone
          ? 'Install Basalt Host on the computer with your files. Keep this open: it appears here by itself once the host starts.'
          : 'Install Basalt Host on the computer with your files, or on this one if they’re here. It appears on this page as soon as it starts.'}
      </Body>
      <div className="mt-5 flex flex-col gap-2">
        {phone ? (
          <>
            <Primary
              icon={<Send size={15} />}
              onClick={() =>
                void android.shareText(
                  `Basalt Host. Open this on your computer to download it: ${HOST_DOWNLOAD}`,
                  'Basalt Host for your computer',
                )
              }
            >
              Send the link to my computer
            </Primary>
            <Secondary icon={<Globe size={15} />} onClick={() => void openExternal(`${WEBSITE}/#download`)}>
              Open the download page
            </Secondary>
          </>
        ) : (
          <Primary icon={<Download size={15} />} onClick={() => void openExternal(HOST_DOWNLOAD)}>
            Download Basalt Host
          </Primary>
        )}
        <button
          onClick={onDone}
          className="mt-1 flex items-center justify-center gap-1.5 py-2 text-[12.5px] text-textFaint transition-colors hover:text-textDim"
        >
          <Keyboard size={13} />
          It’s running but not found? Enter its address
        </button>
      </div>
    </>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center font-mono text-[10.5px] uppercase tracking-[0.2em] text-textFaint">
      {children}
    </div>
  )
}

function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h1 className="mt-2.5 font-display text-[24px] font-semibold leading-[1.15] tracking-tighter text-text">
      {children}
    </h1>
  )
}

function Body({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mt-3 text-[14px] leading-relaxed text-textDim">{children}</p>
}

function Primary({
  children,
  icon,
  trailing,
  onClick,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  trailing?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white px-6 text-[14px] font-semibold text-black transition-opacity first:mt-0 hover:opacity-90"
    >
      {!trailing && icon}
      {children}
      {trailing && icon}
    </motion.button>
  )
}

function Secondary({
  children,
  icon,
  onClick,
}: {
  children: React.ReactNode
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex h-12 w-full items-center justify-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-6 text-[14px] text-textDim transition-colors hover:text-text"
    >
      {icon}
      {children}
    </button>
  )
}

function Dots({ step, onGo }: { step: number; onGo: (step: number) => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: LAST }, (_, i) => (
        <button
          key={i}
          onClick={() => onGo(i)}
          aria-label={`Page ${i + 1}`}
          className="flex h-6 items-center"
        >
          <motion.span
            animate={{ width: i === step ? 22 : 6, opacity: i === step ? 1 : 0.3 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="block h-1.5 rounded-full bg-white"
          />
        </button>
      ))}
    </div>
  )
}
