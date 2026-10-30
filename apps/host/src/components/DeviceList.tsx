import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  Laptop,
  Monitor,
  MonitorSmartphone,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  Tablet,
  Trash2,
  Tv,
  type LucideIcon,
} from 'lucide-react'
import type { DeviceView, EndorsementView } from '@/lib/api'
import { cn, formatAgo, formatBytes, formatRate } from '@/lib/utils'
import { Tag } from './ui/Group'

/**
 * The paired devices, and what each is doing right now.
 *
 * Two numbers per device, both measured rather than inferred: cumulative bytes
 * since the host started, and a rate computed over the actual interval between
 * two polls. Nothing here divides by an assumed tick length, which is how the
 * client once came to display 35 MB/s over a 22.7 MB/s link.
 */
export function DeviceList({
  devices,
  onRevoke,
  onRename,
  onToggleWritable,
  onToggleOwner,
}: {
  devices: DeviceView[]
  onRevoke: (device: DeviceView) => void
  onRename: (device: DeviceView) => void
  onToggleWritable: (device: DeviceView) => void
  onToggleOwner: (device: DeviceView) => void
}): React.JSX.Element {
  if (devices.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-[13px] text-textDim">No devices yet.</p>
        <p className="mx-auto mt-1.5 max-w-[360px] text-[11.5px] leading-relaxed text-textFaint">
          Open Basalt on a phone or computer on this network. It lists this host by name,
          with nothing to type.
        </p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-white/[0.05]">
      <AnimatePresence initial={false}>
        {devices.map((device) => (
          <motion.div
            key={device.id}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.2 }}
          >
            <DeviceRow
              device={device}
              onRevoke={() => onRevoke(device)}
              onRename={() => onRename(device)}
              onToggleWritable={() => onToggleWritable(device)}
              onToggleOwner={() => onToggleOwner(device)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/**
 * Which owner's device last vouched for this computer, under the Devices
 * heading. Quiet when nothing is to be said: no device has a key yet.
 */
export function OwnerLine({
  endorsement,
  devices,
}: {
  endorsement: EndorsementView | null
  devices: DeviceView[]
}): React.JSX.Element | null {
  const owners = devices.some((d) => d.owner)
  if (endorsement) {
    const until = new Date(endorsement.until * 1000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    })
    return (
      <p
        title="A device that manages this host confirms its identity every week, so a copy of this host can always be told apart."
        className="flex items-center gap-1.5 px-4 py-2.5 text-[11.5px] text-textDim"
      >
        <ShieldCheck size={13} className="shrink-0 text-basalt" />
        Confirmed by {endorsement.by} until {until}
      </p>
    )
  }
  if (owners) {
    return (
      <p className="flex items-center gap-1.5 px-4 py-2.5 text-[11.5px] text-textFaint">
        <ShieldCheck size={13} className="shrink-0" />
        Waiting for a device that manages this host to connect and confirm it
      </p>
    )
  }
  if (!devices.some((d) => d.keyed)) return null
  return (
    <p className="flex items-center gap-1.5 px-4 py-2.5 text-[11.5px] text-textFaint">
      <ShieldCheck size={13} className="shrink-0" />
      Let one of your devices manage this host, and it confirms this host’s identity every week
    </p>
  )
}

/** How a device signs in, in two words, with the long version on hover. */
function KeyNote({ device }: { device: DeviceView }): React.JSX.Element {
  const [label, title] = !device.keyed
    ? [
        'older sign-in',
        'Signs in the older way. It moves to a secure key of its own once Basalt on it is updated.',
      ]
    : device.keyKind === 'chip'
      ? ['security chip', 'Signs in with a key kept in its security chip, which never leaves it.']
      : device.keyKind === 'system'
        ? ['secure key', 'Signs in with a key of its own, protected by its system.']
        : ['secure key', 'Signs in with a key of its own.']
  return (
    <span title={title}>{label}</span>
  )
}

function DeviceRow({
  device,
  onRevoke,
  onRename,
  onToggleWritable,
  onToggleOwner,
}: {
  device: DeviceView
  onRevoke: () => void
  onRename: () => void
  onToggleWritable: () => void
  onToggleOwner: () => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const moving = device.sendRate > 0 || device.receiveRate > 0

  const Icon = deviceIcon(device)

  return (
    <div
      title={`Sent ${formatBytes(device.sent)} · received ${formatBytes(device.received)} since the host started`}
      className="group relative flex min-h-[56px] items-center gap-3 px-4 py-2.5"
    >
      <span
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05]',
          device.online ? 'text-text' : 'text-textFaint',
        )}
      >
        <Icon size={15} />
        {/*
          Online means an open connection, not a recent timestamp. A laptop
          that shut its lid an hour ago still has a recent `lastSeen`, and
          calling that online would be a lie the user would act on.
        */}
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#151517]',
            device.online ? 'bg-emerald-400/90' : 'bg-white/20',
            moving && 'animate-breathe',
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-[13px]', device.online ? 'text-text' : 'text-textDim')}>
            {device.name}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-textFaint">
          <span>{device.online ? 'connected' : `seen ${formatAgo(device.lastSeen)}`}</span>
          <span>·</span>
          <KeyNote device={device} />
        </div>
      </div>

      {device.owner && (
        <Tag icon={<ShieldCheck size={10} />} title="Manages this host and confirms its identity">
          manages
        </Tag>
      )}
      {!device.writable && (
        <Tag title="This device can read but not change anything">read only</Tag>
      )}

      {/* The live rates, only while something moves. Fixed width so the
          column does not jitter as the digits change. */}
      {moving && (
        <div className="tnum hidden w-[92px] shrink-0 flex-col items-end gap-0.5 font-mono text-[10.5px] min-[600px]:flex">
          <Rate icon={<ArrowUp size={9} />} value={device.sendRate} />
          <Rate icon={<ArrowDown size={9} />} value={device.receiveRate} />
        </div>
      )}

      <div className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((open) => !open)}
          aria-label={`Options for ${device.name}`}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
            menuOpen ? 'bg-white/[0.08] text-text' : 'text-textFaint hover:bg-white/[0.06] hover:text-text',
          )}
        >
          <MoreHorizontal size={15} />
        </button>

        <AnimatePresence>
          {menuOpen && (
            <>
              {/* Catches the next click anywhere, so the menu closes the way
                  every other menu does. */}
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -4 }}
                transition={{ duration: 0.12 }}
                className="absolute right-0 top-8 z-50 w-[188px] origin-top-right overflow-hidden rounded-md border border-lineBright bg-panel2 py-1 shadow-lift"
              >
                <MenuItem
                  icon={<Pencil size={12} />}
                  label="Rename"
                  onClick={() => {
                    setMenuOpen(false)
                    onRename()
                  }}
                />
                <MenuItem
                  icon={<ShieldOff size={12} />}
                  label={device.writable ? 'Make read only' : 'Allow changes'}
                  onClick={() => {
                    setMenuOpen(false)
                    onToggleWritable()
                  }}
                />
                {device.keyed && (
                  <MenuItem
                    icon={<ShieldCheck size={12} />}
                    label={device.owner ? 'Stop managing the host' : 'Let it manage the host'}
                    onClick={() => {
                      setMenuOpen(false)
                      onToggleOwner()
                    }}
                  />
                )}
                <div className="my-1 h-px bg-line" />
                <MenuItem
                  icon={<Trash2 size={12} />}
                  label="Remove this device"
                  danger
                  onClick={() => {
                    setMenuOpen(false)
                    onRevoke()
                  }}
                />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function Rate({ icon, value }: { icon: React.ReactNode; value: number }): React.JSX.Element {
  const idle = value < 1
  return (
    <span
      className={cn(
        'flex items-center gap-1 transition-colors',
        idle ? 'text-textFaint/70' : 'text-textDim',
      )}
    >
      {icon}
      {formatRate(value)}
    </span>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors',
        danger
          ? 'text-danger hover:bg-dangerBg'
          : 'text-textDim hover:bg-panel hover:text-text',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {label}
    </button>
  )
}

/**
 * Which kind of device, for its picture only: what the device says it is, or
 * for one too old to say, a guess from its name. As in the app's Manage host.
 */
function deviceIcon(device: Pick<DeviceView, 'name' | 'form'>): LucideIcon {
  const name = device.name
  const laptop = /laptop|notebook|macbook|surface/i.test(name)
  switch (device.form) {
    case 'tv':
      return Tv
    case 'phone':
      return Smartphone
    case 'tablet':
      return Tablet
    case 'computer':
      return laptop ? Laptop : Monitor
  }
  if (/\btv\b|television|shield|fire ?(tv|stick)|firestick|chromecast|bravia|\baft/i.test(name)) return Tv
  if (/phone|pixel|galaxy|android/i.test(name)) return Smartphone
  if (/tablet|ipad|\btab\b/i.test(name)) return Tablet
  if (laptop) return Laptop
  return MonitorSmartphone
}
