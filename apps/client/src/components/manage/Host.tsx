import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Disc3,
  HardDrive,
  Info,
  Loader2,
  Network,
  Pencil,
  Repeat,
  ShieldCheck,
  Usb,
} from 'lucide-react'
import type { HostDrive } from '@/lib/manage'
import { cn, formatBytes } from '@/lib/utils'
import { Card, Fact, Group, Pill, Presence, Row, Rows, Toggle, useLayout } from './parts'
import { Surface } from './Surface'
import type { Tools } from './tools'

const PLATFORM: Record<string, string> = {
  windows: 'Windows',
  linux: 'Linux',
  macos: 'macOS',
  other: 'its computer',
}

/**
 * The host at a glance: its name, whether it is sharing, and its drive.
 * The first thing on the screen, and the answer to "is everything all right?"
 */
export function HostHero(tools: Tools): React.JSX.Element {
  const { m, view, prompt } = tools
  const layout = useLayout()
  const phone = layout === 'phone'
  const { status } = view
  const [choosing, setChoosing] = useState(false)
  const online = view.devices.filter((d) => d.online).length
  const vault = status.vault

  const rename = (): void =>
    prompt({
      title: 'Name this host',
      value: status.hostName,
      confirmLabel: 'Rename',
      select: 'all',
      onConfirm: (name) => void m.act({ do: 'setHostName', name }),
    })

  const name = (
    <div className="min-w-0">
      <button
        onClick={rename}
        className={cn(
          'group flex max-w-full items-center gap-2 text-left font-semibold tracking-tight text-text',
          phone ? 'text-[24px] leading-tight' : 'text-[22px] leading-tight',
        )}
      >
        <span className="truncate">{status.hostName}</span>
        <Pencil
          size={phone ? 15 : 13}
          className={cn('shrink-0 text-textFaint transition-opacity', !phone && 'opacity-0 group-hover:opacity-100')}
        />
      </button>
      <div className={cn('mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-textDim', phone ? 'text-[13px]' : 'text-[12px]')}>
        <span className="flex items-center gap-1.5">
          <Presence on={status.serving} />
          {status.serving ? 'Sharing' : 'Not sharing'}
        </span>
        <span className="text-textFaint">·</span>
        <span>
          {online} of {view.devices.length} {view.devices.length === 1 ? 'device' : 'devices'} here
        </span>
        <span className="text-textFaint">·</span>
        <span>on {PLATFORM[status.platform] ?? 'its computer'}</span>
      </div>
    </div>
  )

  const drive = (
    <div className="p-4">
      {vault ? (
        <>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex shrink-0 items-center justify-center bg-white/[0.06] text-textDim',
                phone ? 'h-10 w-10 rounded-xl' : 'h-9 w-9 rounded-lg',
              )}
            >
              <HardDrive size={phone ? 19 : 16} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('truncate font-medium text-text', phone ? 'text-[15px]' : 'text-[13px]')}>{vault.name}</div>
              <div className="truncate font-mono text-[11px] text-textFaint">{vault.path}</div>
            </div>
          </div>
          {vault.available ? (
            vault.total > 0 && (
              <>
                <div className="mt-3.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className="h-full rounded-full bg-basaltDeep"
                    style={{ width: `${((vault.total - vault.free) / vault.total) * 100}%` }}
                  />
                </div>
                <div className="tnum mt-2 font-mono text-[11.5px] text-textFaint">
                  {formatBytes(vault.free)} free of {formatBytes(vault.total)}
                </div>
              </>
            )
          ) : (
            <p className={cn('mt-3 flex items-start gap-2 leading-snug text-danger', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              The drive is unplugged. Your devices see it again as soon as it is back.
            </p>
          )}
        </>
      ) : (
        <p className={cn('text-textDim', phone ? 'text-[14px]' : 'text-[12.5px]')}>No drive is shared yet.</p>
      )}
      <div className="mt-3.5">
        <Pill onClick={() => setChoosing(true)} icon={<Repeat size={phone ? 15 : 13} />}>
          {vault ? 'Share a different drive' : 'Choose a drive'}
        </Pill>
      </div>
    </div>
  )

  return (
    <>
      {phone ? (
        <div className="space-y-4">
          <div className="px-1 pt-1">{name}</div>
          {status.problem && <Problem text={status.problem} />}
          <Card>{drive}</Card>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="glass grid grid-cols-[1fr_minmax(260px,340px)] items-center overflow-hidden rounded-lg">
            <div className="px-5 py-5">{name}</div>
            <div className="border-l border-line">{drive}</div>
          </div>
          {status.problem && <Problem text={status.problem} />}
        </div>
      )}

      <Surface open={choosing} onClose={() => setChoosing(false)} title="Share a drive">
        {choosing && <DrivePicker tools={tools} onDone={() => setChoosing(false)} />}
      </Surface>
    </>
  )
}

function Problem({ text }: { text: string }): React.JSX.Element {
  const phone = useLayout() === 'phone'
  return (
    <Card tone="danger">
      <p className={cn('flex items-start gap-2.5 p-4 leading-snug text-danger', phone ? 'text-[13.5px]' : 'text-[12.5px]')}>
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        {text}
      </p>
    </Card>
  )
}

function driveIcon(kind: HostDrive['kind']): typeof HardDrive {
  switch (kind) {
    case 'removable':
      return Usb
    case 'network':
      return Network
    case 'cdrom':
      return Disc3
    default:
      return HardDrive
  }
}

/**
 * The drives the host's computer could share, as its own window lists them.
 * Asked for when opened, so a drive plugged in a moment ago is there.
 */
function DrivePicker({ tools, onDone }: { tools: Tools; onDone: () => void }): React.JSX.Element {
  const { m, view, confirm } = tools
  const { act } = m
  const phone = useLayout() === 'phone'
  const [asked, setAsked] = useState(false)
  const current = view.status.vault?.path ?? null

  useEffect(() => {
    void act({ do: 'listDrives' }).then(() => setAsked(true))
  }, [act])

  const choose = async (drive: HostDrive): Promise<void> => {
    if (drive.path === current) return
    const name = drive.label || drive.name
    const ok = await confirm({
      title: `Share ${name} instead?`,
      message: view.status.vault
        ? `Your devices see ${name} in place of ${view.status.vault.name}. Nothing on either drive is moved or changed, and you can switch back at any time.`
        : `Your devices see ${name}. Nothing on it is moved or changed.`,
      confirmLabel: 'Share this drive',
    })
    if (ok && (await m.act({ do: 'chooseDrive', path: drive.path, name: drive.label }))) onDone()
  }

  if (!asked || !view.drives) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-textFaint">
        <Loader2 size={15} className="animate-spin" />
        Looking for drives…
      </div>
    )
  }

  return (
    <div className={phone ? 'px-4 pb-4 pt-1' : 'p-4'}>
      <Card>
        <Rows>
          {view.drives.map((drive) => {
            const Icon = driveIcon(drive.kind)
            const here = drive.path === current
            return (
              <Row
                key={drive.path}
                icon={<Icon size={phone ? 18 : 15} />}
                title={drive.name}
                sub={
                  !drive.ready
                    ? 'Not ready: nothing in it, or locked'
                    : drive.total > 0
                      ? `${formatBytes(drive.free)} free of ${formatBytes(drive.total)}`
                      : drive.path
                }
                end={
                  here ? (
                    <span className="flex shrink-0 items-center gap-1 text-[12px] text-basalt">
                      <Check size={14} />
                      Shared
                    </span>
                  ) : m.busy === 'chooseDrive' ? (
                    <Loader2 size={15} className="shrink-0 animate-spin text-textFaint" />
                  ) : undefined
                }
                disabled={!drive.ready || m.busy === 'chooseDrive'}
                onClick={here ? undefined : () => void choose(drive)}
              />
            )
          })}
        </Rows>
      </Card>
      <p className={cn('mt-3 px-1 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
        Drives on the host’s computer. To share one folder rather than a whole drive, choose it at the host.
      </p>
    </div>
  )
}

/** Who may join, and how. */
export function Joining({ m, view, confirm }: Tools): React.JSX.Element {
  const { requirePin } = view.status
  return (
    <Group icon={ShieldCheck} title="Joining">
      <Toggle
        title="Ask for a PIN when pairing"
        description={
          requirePin
            ? 'A new device shows up on this screen with a number to type. Nobody joins without being let in.'
            : 'Anyone on the host’s network who finds it can read the drive without being let in.'
        }
        warn={!requirePin}
        checked={requirePin}
        ask={async (require) =>
          require ||
          confirm({
            title: 'Let devices join without a PIN?',
            message:
              'Anyone on the same network who finds this host could read the drive. Turn it back on once the device you are adding has joined.',
            confirmLabel: 'Turn off',
            danger: true,
          })
        }
        onChange={(require) => m.act({ do: 'setRequirePin', require })}
      />
    </Group>
  )
}

/** Facts about the host, for whoever wants to know. */
export function AboutHost({ view }: Tools): React.JSX.Element {
  const { status } = view
  return (
    <Group icon={Info} title="About this host">
      <Rows>
        <Fact
          label="Reachable at"
          mono
          value={
            status.addresses.length > 0 ? (
              <span className="flex flex-col items-end gap-0.5">
                {/* The network the host's computer uses first; the rest,
                    usually VirtualBox or WSL adapters, quietly after. */}
                {status.addresses.map((address, i) => (
                  <span key={address} className={i > 0 ? 'text-[11px] text-textFaint' : undefined}>
                    {address}
                    <span className="text-textFaint">:{status.port}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-textFaint">no network</span>
            )
          }
        />
        <Fact label="Runs on" value={PLATFORM[status.platform] ?? 'another system'} />
        <Fact label="Identity" mono value={(status.hostId.match(/.{1,4}/g) ?? []).slice(0, 4).join(' ') + ' …'} />
        {status.endorsement && (
          <Fact
            label="Vouched for by"
            value={status.endorsement.by}
          />
        )}
      </Rows>
    </Group>
  )
}
