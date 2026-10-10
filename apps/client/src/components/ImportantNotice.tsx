import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { KeyRound, Server, Sparkles } from 'lucide-react'
import { useBack } from '@/mobile/useBack'

/** Which notice this is. A later one gets a new id and shows once in turn. */
const NOTICE = 'basalt-1.5'
const KEY = 'basalt.notice'

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === NOTICE
  } catch {
    return true
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(KEY, NOTICE)
  } catch {
    // Not remembered: it shows once more next time, nothing worse.
  }
}

/**
 * Something everyone using this version has to know, shown once.
 *
 * Unlike every other dialog here it cannot be waved away: not by tapping or
 * clicking outside, not by Escape or the phone's back gesture. A notice that
 * can be closed without reading it is one most people never read, and this
 * one decides whether the other devices get updated at all. Okay is the only
 * way on, and it is focused, so Enter does it.
 */
export function ImportantNotice(): React.JSX.Element | null {
  const [open, setOpen] = useState(() => !seen())
  if (!open) return null
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
      // A click beside it does nothing, and does not take the focus off Okay.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <Card
        onOkay={() => {
          markSeen()
          setOpen(false)
        }}
      />
    </motion.div>,
    document.body,
  )
}

/** One of the notice's two parts: a heading with its icon, and a few lines. */
function Part({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-4">
      <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
        <span className="text-basalt">{icon}</span>
        {title}
      </h3>
      <div className="mt-1.5 space-y-2 text-[13px] leading-relaxed text-textDim">{children}</div>
    </section>
  )
}

function Card({ onOkay }: { onOkay: () => void }): React.JSX.Element {
  const okay = useRef<HTMLButtonElement>(null)

  // Back is taken and does nothing, rather than leaving the app with the
  // notice unread underneath.
  useBack(true, () => true)

  // Nothing else answers the keyboard while this is up: Escape does not
  // close it, Tab does not leave it, and the app's own shortcuts wait.
  useEffect(() => {
    okay.current?.focus()
    const hold = (e: KeyboardEvent): void => {
      okay.current?.focus()
      if (e.key === 'Enter' || e.key === ' ') return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', hold, true)
    return () => window.removeEventListener('keydown', hold, true)
  }, [])

  return (
    <motion.div
      role="alertdialog"
      aria-modal
      aria-labelledby="notice-title"
      initial={{ opacity: 0, scale: 0.97, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="max-h-[calc(100vh-48px)] w-[min(460px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-white/10 bg-panel2 p-6 shadow-lift"
    >
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-basalt">
        <Sparkles size={13} />
        Basalt 1.5
      </div>
      <h2 id="notice-title" className="mt-2 text-[20px] font-semibold tracking-tight text-text">
        Update Basalt on all your devices
      </h2>

      <Part icon={<KeyRound size={14} />} title="Safer sign-in">
        <p>
          This device now signs in with its own key, created here and kept in its security chip when
          it has one. The key never leaves the device, so a copy of its settings can no longer open
          your drive.
        </p>
        <p>
          Update your other devices too, starting with the computer that shares your drive. Until
          then, they keep working as before.
        </p>
      </Part>

      <Part icon={<Server size={14} />} title="Basalt Host for Linux">
        <p>
          Share your drive from a Linux computer, a home server, a NAS or a Raspberry Pi, with or
          without a screen, or with Docker. You set it up and manage it from this app. Get it at
          basalt.reforatech.com.
        </p>
      </Part>

      <p className="mt-4 text-[12px] leading-relaxed text-textFaint">
        After this update, going back to an older version of Basalt on this device means pairing it
        again.
      </p>

      <button
        ref={okay}
        onClick={onOkay}
        className="mt-5 w-full rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-black outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel2"
      >
        Okay
      </button>
    </motion.div>
  )
}
