import { useState } from 'react'
import { Laptop, Monitor, Smartphone, Tablet, Tv, X } from 'lucide-react'

import { api, type PresentDevice } from '@/lib/api'
import { seenLine } from '@/lib/usePresence'
import { cn } from '@/lib/utils'
import { useConfirm } from './ui/ConfirmDialog'

/**
 * A profile's devices, with who is online: the same green dot the drive card
 * uses for "connected". This one first, called "This laptop" or "This phone".
 *
 * With `profileName` (a host that can), each of the others can be removed
 * from the profile: one lost, sold or lent. It is signed out of the profile
 * there, stays the home's for anyone else, and asks for the PIN to be this
 * profile's again. This device itself signs out with Sign out.
 */
export function YourDevices({
  devices,
  you,
  compact,
  profileName,
}: {
  devices: PresentDevice[]
  you: string
  /** The computer's profile menu: smaller rows. */
  compact?: boolean
  /** The profile's name, when the host can remove its devices. */
  profileName?: string
}): React.JSX.Element {
  const now = Date.now()
  const { confirm, dialog } = useConfirm()
  // Gone from the list at once; the host's own word follows down the watch.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const remove = async (device: PresentDevice): Promise<void> => {
    if (!profileName) return
    const ok = await confirm({
      title: `Remove ${device.name} from ${profileName}?`,
      message: `It’s signed out of ${profileName} at once, and asks for the PIN to be ${profileName}’s again. It stays in this home for anyone else. For a device that’s lost, sold or lent.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    setError(null)
    try {
      await api.forgetProfileDevice(device.device)
      setRemoved((gone) => new Set(gone).add(device.device))
    } catch (e) {
      setError(`Couldn’t remove ${device.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className={compact ? 'py-0.5' : 'py-1'}>
      {devices
        .filter((device) => !removed.has(device.device))
        .map((device) => {
          const Icon = iconOf(device.form)
          const here = device.device === you
          const removable = !!profileName && !here
          return (
            <div
              key={device.device}
              className={cn('group flex items-center', compact ? 'gap-2.5 px-2.5 py-1.5' : 'gap-3.5 px-1 py-2.5')}
            >
              <span
                className={cn(
                  'relative flex shrink-0 items-center justify-center rounded-full',
                  compact ? 'h-7 w-7' : 'h-10 w-10',
                  device.online ? 'bg-white/[0.08] text-text' : 'bg-white/[0.04] text-textFaint',
                )}
              >
                <Icon size={compact ? 13 : 17} />
                {device.online && (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute -bottom-px -right-px rounded-full border-2 border-panel2 bg-emerald-400/80',
                      compact ? 'h-2.5 w-2.5' : 'h-3 w-3',
                    )}
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block truncate',
                    compact ? 'text-[12px]' : 'text-[15px]',
                    device.online ? 'text-text' : 'text-textDim',
                  )}
                >
                  {here ? `This ${wordFor(device.form)}` : device.name}
                </span>
                {!here && (
                  <span className={cn('block truncate text-textFaint', compact ? 'text-[10.5px]' : 'text-[12.5px]')}>
                    {seenLine(device, now)}
                  </span>
                )}
              </span>
              {removable &&
                (compact ? (
                  <button
                    type="button"
                    onClick={() => void remove(device)}
                    aria-label={`Remove ${device.name} from ${profileName}`}
                    title={`Remove from ${profileName}`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-textFaint opacity-0 transition-opacity hover:bg-white/[0.08] hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void remove(device)}
                    aria-label={`Remove ${device.name} from ${profileName}`}
                    className="shrink-0 rounded-full border border-white/[0.12] px-3.5 py-1.5 text-[12.5px] text-textDim active:bg-white/[0.06]"
                  >
                    Remove
                  </button>
                ))}
            </div>
          )
        })}
      {error && <p className={cn('px-1 text-danger', compact ? 'text-[11px]' : 'text-[12.5px]')}>{error}</p>}
      {dialog}
    </div>
  )
}

function iconOf(form: PresentDevice['form']): typeof Laptop {
  switch (form) {
    case 'phone':
      return Smartphone
    case 'tablet':
      return Tablet
    case 'tv':
      return Tv
    case 'computer':
      return Laptop
    default:
      return Monitor
  }
}

/** "This laptop", "This phone": what a person calls the device in their hand. */
function wordFor(form: PresentDevice['form']): string {
  switch (form) {
    case 'phone':
      return 'phone'
    case 'tablet':
      return 'tablet'
    case 'tv':
      return 'TV'
    case 'computer':
      return 'computer'
    default:
      return 'device'
  }
}
