import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowDown,
  ArrowUp,
  Eye,
  Laptop,
  MonitorSmartphone,
  Pencil,
  ShieldCheck,
  Smartphone,
  Tablet,
  Trash2,
  Tv,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react'
import { signsIn, signsInWith, spacedPin, type ManagedDevice, type PairingRequest } from '@/lib/manage'
import { cn, formatBytes } from '@/lib/utils'
import { Card, Group, Pill, Presence, Row, Rows, Tag, Toggle, ago, useLayout } from './parts'
import { Surface } from './Surface'
import type { Tools } from './tools'

/**
 * Devices asking to join, each with the number to type on it.
 *
 * The number is on the host's screen too, but whoever manages the host is
 * often not at it: a phone that manages the host can read the number out, or
 * hand it over, from anywhere in the house.
 */
export function Pairings({ m, view }: Tools): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {view.pairings.map((request) => (
        <motion.div
          key={request.id}
          layout
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <Card tone="raised">
            <PairingCard request={request} onDeny={() => void m.act({ do: 'denyPairing', id: request.id })} />
          </Card>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

function PairingCard({ request, onDeny }: { request: PairingRequest; onDeny: () => void }): React.JSX.Element {
  const layout = useLayout()
  const left = useCountdown(request.secondsLeft)
  const phone = layout === 'phone'

  // A computer has the width to say it all on one line.
  if (!phone) {
    return (
      <div className="flex items-center gap-4 px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-basalt/[0.14] text-basalt">
          <UserPlus size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text">{request.deviceName}</div>
          <div className="text-[11.5px] text-textDim">
            {request.pin
              ? 'wants to join. Type this number on it to let it in:'
              : 'wants to join. This host doesn’t ask for a PIN, so it joins by itself.'}
          </div>
        </div>
        {request.pin && (
          <div className="shrink-0 text-right">
            <div className="tnum font-mono text-[26px] font-semibold leading-none tracking-[0.1em] text-text">
              {spacedPin(request.pin)}
            </div>
            <div className="tnum mt-1.5 font-mono text-[10px] text-textFaint">expires in {clock(left)}</div>
          </div>
        )}
        <Pill onClick={onDeny} icon={<X size={13} />}>
          Decline
        </Pill>
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex shrink-0 items-center justify-center bg-basalt/[0.14] text-basalt',
            phone ? 'h-10 w-10 rounded-xl' : 'h-8 w-8 rounded-lg',
          )}
        >
          <UserPlus size={phone ? 18 : 15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate font-medium text-text', phone ? 'text-[15px]' : 'text-[13px]')}>
            {request.deviceName}
          </div>
          <div className={cn('text-textDim', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
            wants to join this host
          </div>
        </div>
        <span className="tnum shrink-0 font-mono text-[11px] text-textFaint">{clock(left)}</span>
      </div>

      {request.pin ? (
        <div className="mt-3.5 rounded-xl border border-white/[0.08] bg-black/25 px-4 py-4 text-center">
          {/* Large, monospace and in two halves: this number gets read out
              across a room. */}
          <div
            className={cn(
              'tnum font-mono font-semibold leading-none tracking-[0.12em] text-text',
              phone ? 'text-[34px]' : 'text-[28px]',
            )}
          >
            {spacedPin(request.pin)}
          </div>
          <div className={cn('mt-2 text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
            Type this on {request.deviceName} to let it in
          </div>
        </div>
      ) : (
        <p className={cn('mt-3 text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
          This host doesn’t ask for a PIN, so it joins by itself.
        </p>
      )}

      <div className="mt-3 flex justify-end">
        <Pill onClick={onDeny} icon={<X size={14} />}>
          Decline
        </Pill>
      </div>
    </div>
  )
}

/** Seconds left, counting down between the host's answers. */
function useCountdown(seconds: number): number {
  const [left, setLeft] = useState(seconds)
  useEffect(() => {
    setLeft(seconds)
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000)
    return () => clearInterval(timer)
  }, [seconds])
  return left
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------

/** Which kind of device, guessed from its name, for its picture only. */
function deviceIcon(name: string): LucideIcon {
  if (/phone|pixel|galaxy|android/i.test(name)) return Smartphone
  if (/tablet|ipad|\btab\b/i.test(name)) return Tablet
  if (/\btv\b|television|shield|fire ?stick/i.test(name)) return Tv
  if (/laptop|notebook|macbook|surface/i.test(name)) return Laptop
  return MonitorSmartphone
}

/** "this phone" or "this computer", by where the screen is shown. */
function thisOne(layout: 'phone' | 'desktop'): string {
  return layout === 'phone' ? 'This phone' : 'This computer'
}

function lastManager(devices: ManagedDevice[], id: string): boolean {
  const managers = devices.filter((d) => d.owner)
  return managers.length === 1 && managers[0]!.id === id
}

/**
 * The devices paired with the host: this one first, then whichever are here
 * now, then by when each was last seen.
 */
export function Devices(tools: Tools): React.JSX.Element {
  const { view } = tools
  const layout = useLayout()
  const [openId, setOpenId] = useState<string | null>(null)

  const devices = [...view.devices].sort(
    (a, b) =>
      Number(b.id === view.you) - Number(a.id === view.you) ||
      Number(b.online) - Number(a.online) ||
      b.lastSeen - a.lastSeen,
  )
  const online = devices.filter((d) => d.online).length
  const open = view.devices.find((d) => d.id === openId) ?? null

  return (
    <>
      <Group icon={MonitorSmartphone} title="Devices" aside={`${online} of ${devices.length} connected`}>
        <Rows>
          {devices.map((device) => {
            const you = device.id === view.you
            // This device is known for what it is, whatever it is called.
            const Icon = you && layout === 'phone' ? Smartphone : deviceIcon(device.name)
            return (
              <Row
                key={device.id}
                icon={
                  <span className="relative">
                    <Icon size={layout === 'phone' ? 19 : 15} />
                    <span className="absolute -bottom-1 -right-1.5 rounded-full border-2 border-[#141416] leading-[0]">
                      <Presence on={device.online} />
                    </span>
                  </span>
                }
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{device.name}</span>
                  </span>
                }
                sub={
                  <>
                    {you && <span className="text-textDim">{thisOne(layout)} · </span>}
                    {device.online ? 'connected' : `seen ${ago(device.lastSeen)}`} · {signsIn(device)}
                  </>
                }
                end={
                  <span className="flex shrink-0 items-center gap-1.5">
                    {device.owner && <Tag icon={<ShieldCheck size={10} />}>manages</Tag>}
                    {!device.writable && <Tag icon={<Eye size={10} />}>read only</Tag>}
                  </span>
                }
                chevron
                onClick={() => setOpenId(device.id)}
              />
            )
          })}
        </Rows>
      </Group>

      <Surface open={open !== null} onClose={() => setOpenId(null)} title={open?.name ?? ''}>
        {open && <DeviceDetail tools={tools} device={open} onDone={() => setOpenId(null)} />}
      </Surface>
    </>
  )
}

function DeviceDetail({
  tools,
  device,
  onDone,
}: {
  tools: Tools
  device: ManagedDevice
  onDone: () => void
}): React.JSX.Element {
  const { m, view, confirm, prompt, leave } = tools
  const layout = useLayout()
  const phone = layout === 'phone'
  const you = device.id === view.you
  const only = lastManager(view.devices, device.id)
  const Icon = you && phone ? Smartphone : deviceIcon(device.name)

  const askManages = async (next: boolean): Promise<boolean> => {
    if (next) {
      return confirm({
        title: `Let ${device.name} manage this host?`,
        message:
          'Whoever uses it can change everything here, including the drive, who can join and the profiles.',
        confirmLabel: 'Let it manage',
      })
    }
    if (!you) return true
    return confirm({
      title: `Stop managing from ${phone ? 'this phone' : 'this computer'}?`,
      message:
        'This screen closes. Another device that manages the host, or the host’s own window, can let it manage again.',
      confirmLabel: 'Stop managing',
      danger: true,
    })
  }

  const manages = async (next: boolean): Promise<boolean> => {
    const took = await m.act({ do: 'setManages', id: device.id, manages: next })
    if (took && you && !next) leave()
    return took
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: you ? `Remove ${phone ? 'this phone' : 'this computer'}?` : `Remove ${device.name}?`,
      message: you
        ? 'It’s disconnected right away. To use the drive again, it has to pair again.'
        : 'It’s disconnected right away. To use the drive again, it has to pair again.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    if (await m.act({ do: 'removeDevice', id: device.id })) {
      onDone()
      if (you) leave()
    }
  }

  return (
    <div className={phone ? 'space-y-3 px-4 pb-4 pt-1' : 'space-y-3 p-4'}>
      <div className="flex items-center gap-3.5 px-1 pb-1">
        <span
          className={cn(
            'relative flex shrink-0 items-center justify-center bg-white/[0.06] text-textDim',
            phone ? 'h-14 w-14 rounded-2xl' : 'h-11 w-11 rounded-xl',
          )}
        >
          <Icon size={phone ? 24 : 19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn('flex items-center gap-2 text-textDim', phone ? 'text-[13px]' : 'text-[12px]')}>
            <Presence on={device.online} />
            {device.online
              ? `Connected${device.connections > 1 ? ` · ${device.connections} connections` : ''}`
              : `Last seen ${ago(device.lastSeen)}`}
          </div>
          <div className={cn('mt-0.5 text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
            Paired {ago(device.pairedAt)} · signs in with {signsInWith(device)}
          </div>
          <div className="tnum mt-1.5 flex gap-3 font-mono text-[11px] text-textFaint">
            <span className="flex items-center gap-1" title="Sent to this device">
              <ArrowDown size={11} />
              {formatBytes(device.sent)}
            </span>
            <span className="flex items-center gap-1" title="Received from this device">
              <ArrowUp size={11} />
              {formatBytes(device.received)}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <Rows>
          <Row
            icon={<Pencil size={phone ? 17 : 14} />}
            title="Rename"
            sub="The name shown for this device"
            chevron
            onClick={() =>
              prompt({
                title: 'Rename this device',
                value: device.name,
                confirmLabel: 'Rename',
                select: 'all',
                onConfirm: (name) => void m.act({ do: 'renameDevice', id: device.id, name }),
              })
            }
          />
          <Toggle
            title="Can change files"
            description={
              device.writable
                ? 'Can add, rename, move and delete on the drive.'
                : 'Read only: it can open and download, but changes nothing.'
            }
            checked={device.writable}
            onChange={(writable) => m.act({ do: 'setWritable', id: device.id, writable })}
          />
          <Toggle
            title="Manages this host"
            description={
              !device.keyed && !device.owner
                ? 'Update Basalt on this device first. Then it can manage the host.'
                : only
                  ? 'The only device that manages this host. Let another device manage it first.'
                  : device.owner
                    ? 'Can change everything on this screen, from anywhere it connects.'
                    : 'Off. It can use the drive, but not change these settings.'
            }
            checked={device.owner}
            disabled={(!device.keyed && !device.owner) || only}
            ask={askManages}
            onChange={manages}
          />
        </Rows>
      </Card>

      <Card>
        <Row
          icon={<Trash2 size={phone ? 17 : 14} />}
          title="Remove from this host"
          sub={only ? 'Let another device manage the host first.' : 'It can pair again later.'}
          danger
          disabled={only}
          onClick={() => void remove()}
        />
      </Card>
    </div>
  )
}
