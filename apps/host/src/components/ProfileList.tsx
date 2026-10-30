import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Copy, KeyRound, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { ProfileSummary } from '@/lib/api'
import { cn, formatAgo } from '@/lib/utils'
import { copyText } from '@/lib/copyText'
import { Tag } from './ui/Group'

/**
 * The household's profiles, and which devices are signed in to each.
 *
 * Names only. A PIN is never shown here, nor anywhere else: the host keeps a
 * hash of it and nothing more. What the host's owner can do is what a
 * forgotten PIN needs — clear it, so the next sign-in chooses a new one — and
 * remove a profile outright, with its history and stars.
 */

/** Avatar colours, muted to sit in a graphite interface. Mirrors the client. */
export const PROFILE_COLORS = [
  '#7384D8',
  '#4E9EA0',
  '#6BA674',
  '#C4A157',
  '#CC7E68',
  '#C27391',
  '#957AC9',
  '#8A8F98',
]

export function profileColor(index: number): string {
  return PROFILE_COLORS[((index % PROFILE_COLORS.length) + PROFILE_COLORS.length) % PROFILE_COLORS.length]!
}

export function Avatar({
  name,
  color,
  size = 40,
}: {
  name: string
  color: number
  size?: number
}): React.JSX.Element {
  const tone = profileColor(color)
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(145deg, ${tone}, ${tone}B0)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.22), 0 0 0 1px rgba(255,255,255,0.06)`,
      }}
      aria-hidden
    >
      {initialOf(name)}
    </span>
  )
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

export function ProfileList({
  profiles,
  ownerAdds,
  onAdd,
  onResetPin,
  onRemove,
  onNewCode,
}: {
  profiles: ProfileSummary[]
  /** Only this host adds profiles: the empty list says how. */
  ownerAdds: boolean
  onAdd: () => void
  onResetPin: (profile: ProfileSummary) => void
  onRemove: (profile: ProfileSummary) => void
  /** A new code for a profile waiting for its PIN. */
  onNewCode: (profile: ProfileSummary) => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-white/[0.05]">
      {profiles.length === 0 && (
        <p className="px-4 py-3.5 text-[11.5px] leading-relaxed text-textFaint">
          {ownerAdds
            ? 'No profiles yet. Add one for each person: a profile keeps its own watch history and stars, and takes them from one device to the next.'
            : 'No profiles yet. Add one here, or anyone on a paired device can make one when they open Basalt. A profile keeps its own watch history and stars.'}
        </p>
      )}
      <AnimatePresence initial={false}>
        {profiles.map((profile) => (
          <motion.div
            key={profile.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <ProfileRow
              profile={profile}
              onResetPin={() => onResetPin(profile)}
              onRemove={() => onRemove(profile)}
              onNewCode={() => onNewCode(profile)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      <button
        type="button"
        onClick={onAdd}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-textDim">
          <Plus size={15} />
        </span>
        <span className="text-[13px] text-text">Add a profile</span>
      </button>
    </div>
  )
}

/** Who a profile is signed in on, as a sentence part. */
function signedIn(profile: ProfileSummary): string {
  const names = profile.devices.map((d) => d.name)
  if (names.length === 0) return 'not signed in anywhere'
  if (names.length === 1) return `on ${names[0]}`
  if (names.length === 2) return `on ${names[0]} and ${names[1]}`
  return `on ${names.length} devices`
}

function ProfileRow({
  profile,
  onResetPin,
  onRemove,
  onNewCode,
}: {
  profile: ProfileSummary
  onResetPin: () => void
  onRemove: () => void
  onNewCode: () => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)
  const now = Date.now() / 1000
  const active = profile.devices.some((d) => now - d.lastUsed < 10 * 60)
  const waiting = !profile.hasPin && !profile.home
  const devicesTitle = profile.devices
    .map((d) => `${d.name}: ${d.remembered ? 'stays signed in' : 'signed in until the app closes'}`)
    .join('\n')

  return (
    <div className="relative px-4 py-2.5">
      <div className="flex min-h-[36px] items-center gap-3">
        <div className="relative">
          <Avatar name={profile.name} color={profile.color} size={32} />
          {active && (
            <span
              title="In use now"
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#151517] bg-emerald-400/90"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-text">
            {profile.name}
            {profile.home && <span className="ml-1.5 text-[11.5px] text-textFaint">from {profile.home}</span>}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-textFaint" title={devicesTitle || undefined}>
            {profile.home
              ? `Signs in on ${profile.home}, with no PIN here`
              : `${profile.lastUsed > 0 ? `Used ${formatAgo(profile.lastUsed)}` : 'Not used yet'} · ${signedIn(profile)}`}
          </div>
        </div>
        {waiting && (
          <Tag icon={<KeyRound size={10} />} title={profile.lastUsed === 0 ? `Waiting for ${profile.name} to sign in and choose a PIN` : 'PIN cleared: the next sign-in chooses a new one'}>
            new pin
          </Tag>
        )}
        <button
          onClick={() => setMenu((open) => !open)}
          aria-label={`Options for ${profile.name}`}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150',
            menu ? 'bg-white/[0.08] text-text' : 'text-textFaint hover:bg-white/[0.06] hover:text-text',
          )}
        >
          <MoreHorizontal size={15} />
        </button>
      </div>

      {waiting && profile.claimCode && (
        <div className="ml-11 mt-2 flex items-center gap-2 rounded-md bg-white/[0.04] px-2.5 py-1.5 text-[11px]">
          <span className="text-textFaint">Code to claim it</span>
          <span className="select-all font-mono text-[12.5px] tracking-[0.12em] text-text">{profile.claimCode}</span>
          <CopyCode code={profile.claimCode} />
          <button
            onClick={onNewCode}
            className="ml-auto rounded px-1.5 py-0.5 text-[10.5px] text-textFaint transition-colors hover:bg-white/[0.06] hover:text-text"
          >
            New code
          </button>
        </div>
      )}

      <AnimatePresence>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.13, ease: [0.22, 1, 0.36, 1] }}
              style={{ transformOrigin: 'top right' }}
              className="absolute right-3 top-11 z-20 w-[190px] overflow-hidden rounded-md border border-white/10 bg-panel2 p-1 shadow-lift"
            >
              {!profile.home && (
                <MenuItem
                  icon={KeyRound}
                  label="Reset PIN"
                  onClick={() => {
                    setMenu(false)
                    onResetPin()
                  }}
                />
              )}
              <MenuItem
                icon={Trash2}
                label="Remove profile"
                danger
                onClick={() => {
                  setMenu(false)
                  onRemove()
                }}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Trash2
  label: string
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[12px] transition-colors duration-100',
        danger ? 'text-danger hover:bg-dangerBg' : 'text-textDim hover:bg-white/[0.06] hover:text-text',
      )}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}

/** Copies a claim code, to send to the person it is for, and says so. */
function CopyCode({ code }: { code: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={(e) => {
        const shown = e.currentTarget.previousElementSibling
        void copyText(code).then((ok) => {
          if (!ok) {
            // Refused: the code is selected instead, to copy by hand.
            if (shown) window.getSelection()?.selectAllChildren(shown)
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title="Copy the code"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-textFaint transition-colors hover:bg-white/[0.06] hover:text-text"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
