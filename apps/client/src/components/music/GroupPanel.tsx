import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Laptop, Link2, Smartphone, Tablet, Tv, X } from 'lucide-react'

import type { MusicPlayerApi } from '@/lib/musicPlayer'
import { useBack } from '@/mobile/useBack'
import { cn } from '@/lib/utils'

/**
 * The devices playing in sync with this one (1.6.4, mockup 15b): each by
 * name with how it's doing, stopping one of them, leaving the group and
 * playing on here, or stopping them all. Opened from the "In sync" chip, so
 * nothing stops on a single tap any more.
 */
export function GroupPanel({
  player,
  title,
  open,
  onClose,
  phone,
}: {
  player: MusicPlayerApi
  /** The song playing, to say what they play together. */
  title: string
  open: boolean
  onClose: () => void
  /** Rises from the bottom; on a computer, a card in the middle. */
  phone?: boolean
}): React.JSX.Element {
  useBack(open, () => {
    onClose()
    return true
  })
  const count = player.together.length + 1
  // The last of the others stopped or left: nothing to show, so it goes.
  const alone = player.together.length === 0
  useEffect(() => {
    if (open && alone) onClose()
  }, [open, alone, onClose])
  // Over everything, whatever layer opened it (the full player moves).
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={cn('fixed inset-0 z-[90] flex bg-black/55', phone ? 'items-end' : 'items-center justify-center p-6')}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-label="Playing in sync"
            onClick={(e) => e.stopPropagation()}
            initial={phone ? { y: 40 } : { scale: 0.97, opacity: 0 }}
            animate={phone ? { y: 0 } : { scale: 1, opacity: 1 }}
            exit={phone ? { y: 40 } : { scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'w-full border border-white/10 bg-panel2 shadow-lift [--surface:#1C1C1F]',
              phone ? 'rounded-t-3xl pb-[calc(var(--inset-bottom,0px)+16px)]' : 'max-w-[400px] rounded-2xl pb-4',
            )}
          >
            <div className="flex items-start gap-3 px-5 pb-3 pt-5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-basalt/[0.18] text-basalt">
                <Link2 size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold text-text">Playing in sync</p>
                <p className="truncate text-[12.5px] text-textFaint">
                  {title} · {count} devices · the same second on all
                </p>
              </div>
              <button onClick={onClose} aria-label="Close" className="-mr-1 rounded-full p-1.5 text-textDim hover:bg-white/[0.06] hover:text-text">
                <X size={16} />
              </button>
            </div>

            <div className="border-y border-white/[0.06] py-1">
              <Row form={phone ? 'phone' : 'computer'} name="This device" state="In step" />
              {player.together.map((d) => (
                <Row
                  key={d.device}
                  form={d.form}
                  name={d.name}
                  state={stateOf(player, d.device)}
                  onStop={() => player.stopThere(d.device)}
                />
              ))}
            </div>

            <div className="flex flex-col gap-2 px-5 pt-4">
              <button
                onClick={() => {
                  player.unlink()
                  onClose()
                }}
                className="rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text hover:bg-white/[0.04]"
              >
                Leave the group, keep playing here
              </button>
              <button
                onClick={() => {
                  player.stopAll()
                  onClose()
                }}
                className="rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text hover:bg-white/[0.04]"
              >
                Stop on all devices
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/** How a device in the group is doing, as far as its last word says. */
function stateOf(player: MusicPlayerApi, device: string): string {
  const there = player.others.find((s) => s.device === device)
  if (!there) return 'Joining…'
  return there.report.playing === !player.paused ? 'In step' : 'Catching up…'
}

function Row({
  form,
  name,
  state,
  onStop,
}: {
  form?: string | null
  name: string
  state: string
  onStop?: () => void
}): React.JSX.Element {
  const Icon = form === 'phone' ? Smartphone : form === 'tablet' ? Tablet : form === 'tv' ? Tv : Laptop
  const settled = state === 'In step'
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-text">
        <Icon size={16} />
        <span
          className={cn(
            'surface-ring absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full',
            settled ? 'bg-emerald-400' : 'bg-amber-300',
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-text">{name}</span>
        <span className="block text-[12px] text-textFaint">{state}</span>
      </span>
      {onStop && (
        <button
          onClick={onStop}
          className="shrink-0 rounded-full border border-white/[0.12] px-3 py-1.5 text-[12.5px] text-text hover:bg-white/[0.05]"
        >
          Stop there
        </button>
      )}
    </div>
  )
}
