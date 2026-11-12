import { Laptop, Monitor, Smartphone, Tablet, Tv } from 'lucide-react'

import type { PresentDevice } from '@/lib/api'
import { seenLine } from '@/lib/usePresence'
import { cn } from '@/lib/utils'

/**
 * A profile's devices, with who is online: the same green dot the drive card
 * uses for "connected". This one first, called "This laptop" or "This phone".
 */
export function YourDevices({
  devices,
  you,
  compact,
}: {
  devices: PresentDevice[]
  you: string
  /** The computer's profile menu: smaller rows. */
  compact?: boolean
}): React.JSX.Element {
  const now = Date.now()
  return (
    <div className={compact ? 'py-0.5' : 'py-1'}>
      {devices.map((device) => {
        const Icon = iconOf(device.form)
        const here = device.device === you
        return (
          <div
            key={device.device}
            className={cn('flex items-center', compact ? 'gap-2.5 px-2.5 py-1.5' : 'gap-3.5 px-1 py-2.5')}
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
          </div>
        )
      })}
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
