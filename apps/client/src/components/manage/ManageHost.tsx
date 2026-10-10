import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, ChevronLeft, Loader2, ShieldOff } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { PromptDialog, type PromptRequest } from '@/components/ui/PromptDialog'
import { useManage, type Manage } from '@/lib/manage'
import { usePresence } from '@/mobile/presence'
import { useBack } from '@/mobile/useBack'
import { cn } from '@/lib/utils'
import { Devices, Pairings } from './Devices'
import { AboutHost, HostHero, Joining } from './Host'
import { ConversionGroup, LibraryGroup, SectionsGroup } from './Media'
import { LayoutContext, type Layout } from './parts'
import { Profiles } from './Profiles'
import type { Tools } from './tools'

/**
 * Managing the host from this device: what the host's own window does, from
 * wherever this device is.
 *
 * The same parts, in the same order, on a phone and on a computer: the host at
 * a glance, then anyone waiting to join, then the devices and the people who
 * use the drive, then the settings. What changes is only how it is laid out —
 * one column for a thumb, two for a desk.
 */
export function ManageHost({ layout, onClose }: { layout: Layout; onClose: () => void }): React.JSX.Element {
  const m = useManage()
  const { confirm, dialog } = useConfirm()
  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const view = m.view
  const lost = m.error !== null && /does not manage this host/i.test(m.error)

  const tools: Tools | null = view
    ? { m, view, confirm, prompt: setPrompt, leave: onClose }
    : null

  const body = lost ? (
    <Lost layout={layout} hostName={view?.status.hostName ?? null} onClose={onClose} />
  ) : !tools ? (
    <Waiting layout={layout} error={m.error} />
  ) : layout === 'phone' ? (
    <PhoneBody tools={tools} />
  ) : (
    <DesktopBody tools={tools} />
  )

  return (
    <LayoutContext.Provider value={layout}>
      {layout === 'phone' ? (
        <PhoneFrame title={view?.status.hostName ?? null} busy={m.busy !== null} onBack={onClose}>
          {body}
        </PhoneFrame>
      ) : (
        <div className="relative h-full">{body}</div>
      )}
      {!lost && <Trouble m={m} layout={layout} />}
      <PromptDialog request={prompt} onClose={() => setPrompt(null)} />
      {dialog}
    </LayoutContext.Provider>
  )
}

/**
 * The phone's screen for it: over the tabs, sliding in from the side as a
 * screen opened from a list does, and gone again by back or its own arrow.
 */
export function PhoneManagePanel({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  useBack(open, () => {
    onClose()
    return true
  })
  const { mounted, visible } = usePresence(open, 340)
  if (!mounted) return null
  return (
    <div
      className="fixed inset-0 z-[60] bg-ink transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
      style={{
        transform: visible ? 'translate3d(0, 0, 0)' : 'translate3d(100%, 0, 0)',
        paddingLeft: 'var(--inset-left, 0px)',
        paddingRight: 'var(--inset-right, 0px)',
      }}
    >
      <ManageHost layout="phone" onClose={onClose} />
    </div>
  )
}

function PhoneFrame({
  title,
  busy,
  onBack,
  children,
}: {
  title: string | null
  busy: boolean
  onBack: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // The host's name moves up into the bar once its own heading scrolls away.
  const [scrolled, setScrolled] = useState(false)
  return (
    <div className="flex h-full flex-col">
      <div style={{ height: 'var(--inset-top, 0px)' }} className="shrink-0" />
      <header
        className={cn(
          'flex h-14 shrink-0 items-center gap-1 border-b px-1.5 transition-colors duration-200',
          scrolled ? 'border-white/[0.07]' : 'border-transparent',
        )}
      >
        <button
          onClick={onBack}
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center rounded-full text-text active:bg-white/[0.08]"
        >
          <ChevronLeft size={24} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold leading-tight text-text">Manage host</div>
          <div
            className={cn(
              'truncate text-[12px] leading-tight text-textFaint transition-[opacity,max-height] duration-200',
              scrolled && title ? 'max-h-4 opacity-100' : 'max-h-0 opacity-0',
            )}
          >
            {title}
          </div>
        </div>
        <span className="flex w-11 justify-center">
          {busy && <Loader2 size={16} className="animate-spin text-textFaint" />}
        </span>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
        style={{ paddingBottom: 'calc(var(--inset-bottom, 0px) + 28px)' }}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 56)}
      >
        {children}
      </div>
    </div>
  )
}

function PhoneBody({ tools }: { tools: Tools }): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[560px] space-y-6 pt-2">
      <HostHero {...tools} />
      {tools.view.pairings.length > 0 && (
        <div className="space-y-3">
          <Pairings {...tools} />
        </div>
      )}
      <Devices {...tools} />
      <Profiles {...tools} />
      <Joining {...tools} />
      <LibraryGroup {...tools} />
      <SectionsGroup {...tools} />
      <ConversionGroup {...tools} />
      <AboutHost {...tools} />
    </div>
  )
}

/** Wide enough for two columns side by side. */
const TWO_COLUMNS_PX = 860

function DesktopBody({ tools }: { tools: Tools }): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setWide(el.clientWidth >= TWO_COLUMNS_PX))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const people = (
    <>
      <Devices {...tools} />
      <Profiles {...tools} />
      <Joining {...tools} />
    </>
  )
  const settings = (
    <>
      <LibraryGroup {...tools} />
      <ConversionGroup {...tools} />
      <SectionsGroup {...tools} />
      <AboutHost {...tools} />
    </>
  )

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <motion.div
        ref={box}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto max-w-[1080px] space-y-5"
      >
        <div className="flex items-center justify-between px-1">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">Manage host</span>
          {tools.m.busy !== null && <Loader2 size={13} className="animate-spin text-textFaint" />}
        </div>
        <HostHero {...tools} />
        {tools.view.pairings.length > 0 && (
          <div className="space-y-3">
            <Pairings {...tools} />
          </div>
        )}
        {wide ? (
          <div className="grid grid-cols-2 items-start gap-5">
            <div className="space-y-5">{people}</div>
            <div className="space-y-5">{settings}</div>
          </div>
        ) : (
          <div className="space-y-5">
            {people}
            {settings}
          </div>
        )}
      </motion.div>
    </div>
  )
}

/** Before the host's first answer: a moment, or why it has not come. */
function Waiting({ layout, error }: { layout: Layout; error: string | null }): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-8 text-center',
        layout === 'phone' ? 'h-[70%]' : 'h-full',
      )}
    >
      {error ? (
        <>
          <AlertTriangle size={20} className="text-textFaint" />
          <p className="max-w-[340px] text-[13.5px] leading-snug text-textDim">{error}</p>
          <p className="text-[12px] text-textFaint">Trying again…</p>
        </>
      ) : (
        <Loader2 size={18} className="animate-spin text-textFaint" />
      )}
    </div>
  )
}

/** This device no longer manages the host: said plainly, with a way out. */
function Lost({
  layout,
  hostName,
  onClose,
}: {
  layout: Layout
  hostName: string | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-8 text-center',
        layout === 'phone' ? 'h-[70%]' : 'h-full',
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-textDim">
        <ShieldOff size={20} />
      </span>
      <div className="text-[16px] font-medium text-text">
        {layout === 'phone' ? 'This phone' : 'This computer'} no longer manages {hostName ?? 'the host'}
      </div>
      <p className="max-w-[340px] text-[13px] leading-snug text-textFaint">
        It still uses the drive as before. A device that manages the host, or the host’s own window, can let it
        manage again.
      </p>
      <button
        onClick={onClose}
        className="mt-2 rounded-full border border-white/[0.12] px-4 py-2 text-[13.5px] text-text active:bg-white/[0.06]"
      >
        Back
      </button>
    </div>
  )
}

/**
 * What the host said no to, or why it could not be asked, along the bottom
 * until it is tapped away or a moment has passed. The control that was
 * changed has already gone back to what the host has.
 */
function Trouble({ m, layout }: { m: Manage; layout: Layout }): React.JSX.Element {
  const { error, clearError, view } = m
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(clearError, 6000)
    return () => clearTimeout(timer)
  }, [error, clearError])

  // Before the first answer, the waiting screen says it instead.
  const shown = error !== null && view !== null
  return (
    <AnimatePresence>
      {shown && (
        <motion.button
          key={error}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={clearError}
          className={cn(
            'fixed inset-x-4 z-[70] mx-auto flex max-w-[480px] items-start gap-2.5 border border-danger/25 bg-[#221516] text-left text-danger shadow-lift',
            layout === 'phone' ? 'rounded-xl px-4 py-3 text-[13.5px]' : 'rounded-lg px-3.5 py-2.5 text-[12.5px]',
          )}
          style={{ bottom: layout === 'phone' ? 'calc(var(--inset-bottom, 0px) + 20px)' : 24 }}
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="leading-snug">{error}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
