import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, KeyRound } from 'lucide-react'
import { Avatar, PROFILE_COLORS } from './ProfileList'
import { cn } from '@/lib/utils'

/**
 * A profile made from the host: a name and a colour, nothing else.
 *
 * No PIN. The person it is for chooses their own the first time they sign
 * in, so the host's owner never knows it, and the dialog says so: that is
 * what makes handing out profiles from here trustworthy.
 */
export function AddProfileDialog({
  open,
  taken,
  onClose,
  onAdd,
}: {
  open: boolean
  /** Names already in use, lower-cased. */
  taken: string[]
  onClose: () => void
  /** Resolves when added; rejects with the host's reason. */
  onAdd: (name: string, color: number) => Promise<void>
}): React.JSX.Element {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={onClose}
        >
          <Card taken={taken} onClose={onClose} onAdd={onAdd} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Card({
  taken,
  onClose,
  onAdd,
}: {
  taken: string[]
  onClose: () => void
  onAdd: (name: string, color: number) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => Math.floor(Math.random() * PROFILE_COLORS.length))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = name.trim()
  const clash = taken.includes(trimmed.toLowerCase())

  const submit = async (): Promise<void> => {
    if (!trimmed || clash || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(trimmed, color)
      onClose()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message.charAt(0).toUpperCase() + message.slice(1))
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 6 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
      role="dialog"
      aria-modal
      aria-label="Add a profile"
      className="w-[380px] rounded-lg border border-white/10 bg-panel2 p-5 shadow-lift"
    >
      <div className="flex items-center gap-3.5">
        <motion.div key={`${color}-${trimmed[0] ?? ''}`} initial={{ scale: 0.9 }} animate={{ scale: 1 }}>
          <Avatar name={trimmed || '?'} color={color} size={48} />
        </motion.div>
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-text">Add a profile</h2>
          <p className="mt-0.5 truncate text-[11.5px] text-textFaint">
            {trimmed ? `${trimmed} can sign in on any paired device` : 'For someone in your household'}
          </p>
        </div>
      </div>

      <label className="mt-5 block">
        <span className="text-[11px] text-textFaint">Name</span>
        <input
          value={name}
          autoFocus
          maxLength={32}
          placeholder="Maya"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          spellCheck={false}
          className="mt-1.5 h-9 w-full rounded-md border border-white/[0.09] bg-ink2 px-3 text-[13px] text-text outline-none transition-colors placeholder:text-textFaint focus:border-white/25"
        />
      </label>

      <div className="mt-4">
        <span className="text-[11px] text-textFaint">Colour</span>
        <div className="mt-2 flex justify-between">
          {PROFILE_COLORS.map((tone, index) => (
            <button
              key={tone}
              type="button"
              onClick={() => setColor(index)}
              aria-label={`Colour ${index + 1}`}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full transition-transform duration-150 hover:scale-110',
                color === index && 'ring-2 ring-white/80 ring-offset-2 ring-offset-panel2',
              )}
              style={{ background: tone }}
            >
              {color === index && <Check size={12} className="text-white" strokeWidth={3} />}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-start gap-2.5 rounded-md bg-white/[0.04] px-3 py-2.5">
        <KeyRound size={13} className="mt-0.5 shrink-0 text-textFaint" />
        <p className="text-[11.5px] leading-relaxed text-textDim">
          No PIN to set here.{' '}
          {trimmed
            ? `${trimmed} chooses one the first time they sign in, and only they know it.`
            : 'They choose one the first time they sign in, and only they know it.'}
        </p>
      </div>

      <div className="mt-2 h-4 text-[11px] text-danger">
        {clash ? 'There is already a profile with that name.' : error}
      </div>

      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-[12px] text-textDim transition-colors hover:bg-white/[0.05] hover:text-text"
        >
          Cancel
        </button>
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => void submit()}
          disabled={!trimmed || clash || busy}
          className="rounded-md bg-basalt px-3.5 py-1.5 text-[12px] font-medium text-ink transition-opacity disabled:opacity-40"
        >
          Add profile
        </motion.button>
      </div>
    </motion.div>
  )
}
