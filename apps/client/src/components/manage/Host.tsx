import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronRight,
  Disc3,
  Folder,
  FolderOpen,
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

  const renameDrive = (): void =>
    prompt({
      title: 'Name this drive',
      value: vault?.name ?? '',
      confirmLabel: 'Rename',
      select: 'all',
      onConfirm: (name) => void m.act({ do: 'renameDrive', name }),
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
          {online} of {view.devices.length} {view.devices.length === 1 ? 'device' : 'devices'} connected
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
              <button
                onClick={renameDrive}
                title="Rename this drive"
                className={cn(
                  'group flex max-w-full items-center gap-1.5 text-left font-medium text-text',
                  phone ? 'text-[15px]' : 'text-[13px]',
                )}
              >
                <span className="truncate">{vault.name}</span>
                <Pencil
                  size={phone ? 13 : 11}
                  className={cn('shrink-0 text-textFaint transition-opacity', !phone && 'opacity-0 group-hover:opacity-100')}
                />
              </button>
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
              The drive is unplugged. Your devices see it again as soon as it’s back.
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
  const { m, view, confirm, prompt } = tools
  const { act } = m
  const phone = useLayout() === 'phone'
  const [asked, setAsked] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const current = view.status.vault?.path ?? null

  useEffect(() => {
    void act({ do: 'listDrives' }).then(() => setAsked(true))
  }, [act])

  /** A folder typed in: the host checks it is there. Named after its last part. */
  const choosePath = async (path: string): Promise<void> => {
    const trimmed = path.trim().replace(/[\\/]+$/, '') || path.trim()
    const name = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed
    const ok = await confirm({
      title: `Share ${name}?`,
      message: view.status.vault
        ? `Your devices see ${trimmed} in place of ${view.status.vault.name}. Nothing on either is moved or changed.`
        : `Your devices see ${trimmed}. Nothing in it is moved or changed.`,
      confirmLabel: 'Share this folder',
    })
    if (ok && (await m.act({ do: 'chooseDrive', path: trimmed, name }))) onDone()
  }

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

  /** The way it always was, for a path known by heart or pasted. */
  const typePath = (): void =>
    prompt({
      title: 'Share a folder',
      value: view.status.platform === 'windows' ? 'D:\\' : '/',
      confirmLabel: 'Share it',
      onConfirm: (path) => void choosePath(path),
    })

  if (browsing) {
    return (
      <FolderBrowser
        tools={tools}
        onShare={(path) => void choosePath(path)}
        onType={typePath}
        onBack={() => setBrowsing(false)}
      />
    )
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
                    ? 'Not ready: empty or locked'
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
          <Row
            icon={<FolderOpen size={phone ? 18 : 15} />}
            title="Choose a folder…"
            sub="For one folder rather than a whole drive"
            chevron
            disabled={m.busy === 'chooseDrive'}
            onClick={() => setBrowsing(true)}
          />
        </Rows>
      </Card>
      <p className={cn('mt-3 px-1 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
        {view.status.headless
          ? 'Drives the host can see. In Docker, these are the folders mounted under /media.'
          : 'Drives on the host’s computer.'}
      </p>
    </div>
  )
}

/**
 * The host's folders, looked through from here: tap into one, go back up,
 * and share the one you are in. Where it starts is the host's to say: the
 * drives on Windows, the folders mounted into a container, the top otherwise.
 */
function FolderBrowser({
  tools,
  onShare,
  onType,
  onBack,
}: {
  tools: Tools
  onShare: (path: string) => void
  onType: () => void
  onBack: () => void
}): React.JSX.Element {
  const { m, view } = tools
  const { act } = m
  const phone = useLayout() === 'phone'
  const [path, setPath] = useState('')
  const [loaded, setLoaded] = useState<string | null>(null)
  // A folder that would not open leaves you where you were; the host's
  // reason is shown as any refusal is.
  const lastGood = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    void act({ do: 'listFolders', path }).then((ok) => {
      if (!live) return
      if (ok) {
        lastGood.current = path
        setLoaded(path)
      } else if (lastGood.current !== null && lastGood.current !== path) {
        setPath(lastGood.current)
      } else {
        setLoaded(path)
      }
    })
    return () => {
      live = false
    }
  }, [act, path])

  const here = view.folders
  const ready = loaded !== null && here != null
  const loading = m.busy === 'listFolders' || loaded !== path
  // The list of drives on Windows is somewhere to start, not a folder.
  const atDrives = ready && here.path === ''

  return (
    <div className={phone ? 'px-4 pb-4 pt-1' : 'p-4'}>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => (ready && here.parent !== null ? setPath(here.parent) : onBack())}
          title={ready && here.parent !== null ? 'Up one folder' : 'Back to the drives'}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-full border border-white/[0.12] text-textDim transition-colors',
            phone ? 'h-9 w-9 active:bg-white/[0.06]' : 'h-7 w-7 hover:bg-white/[0.05]',
          )}
        >
          <ArrowUp size={phone ? 16 : 13} />
        </button>
        <div
          className={cn('min-w-0 flex-1 truncate font-mono text-textDim', phone ? 'text-[12.5px]' : 'text-[11.5px]')}
          dir="rtl"
          title={ready ? here.path : undefined}
        >
          {/* Right to left, so a long path shows its end: where you are. */}
          <bdi>{ready ? here.path || 'This computer' : ' '}</bdi>
        </div>
        {loading && <Loader2 size={phone ? 15 : 13} className="shrink-0 animate-spin text-textFaint" />}
      </div>

      <Card>
        {ready && here.folders.length > 0 ? (
          <div className={cn('overflow-y-auto', phone ? 'max-h-[46vh]' : 'max-h-[300px]')}>
            <Rows>
              {here.folders.map((folder) => (
                <Row
                  key={folder.path}
                  icon={<Folder size={phone ? 18 : 15} />}
                  title={folder.name}
                  end={<ChevronRight size={phone ? 16 : 13} className="shrink-0 text-textFaint" />}
                  disabled={loading}
                  onClick={() => setPath(folder.path)}
                />
              ))}
            </Rows>
          </div>
        ) : (
          <p className={cn('px-4 py-6 text-center text-textFaint', phone ? 'text-[13px]' : 'text-[12px]')}>
            {ready ? 'No folders in here.' : 'Looking…'}
          </p>
        )}
      </Card>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!ready || atDrives || loading || m.busy === 'chooseDrive'}
          onClick={() => ready && onShare(here.path)}
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-full border border-basalt/40 bg-basalt/15 text-text transition-colors disabled:opacity-40',
            phone ? 'px-4 py-2.5 text-[13.5px] active:bg-basalt/25' : 'px-3.5 py-1.5 text-[12px] hover:bg-basalt/25',
          )}
        >
          <Check size={phone ? 15 : 13} />
          Share this folder
        </button>
        <Pill onClick={onType}>Type a path</Pill>
      </div>
      <p className={cn('mt-3 px-1 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
        {view.status.headless
          ? 'Open the folder you want, then choose Share this folder. In Docker, only the folders mounted under /media are available.'
          : 'Open the folder you want, then choose Share this folder. Nothing in it is moved or changed.'}
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
            : 'Any device on the host’s network can join and open the drive without a PIN.'
        }
        warn={!requirePin}
        checked={requirePin}
        ask={async (require) =>
          require ||
          confirm({
            title: 'Let devices join without a PIN?',
            message:
              'Any device on the same network could join and open the drive. Turn it back on once your new device has joined.',
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
          label="Address"
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
              <span className="text-textFaint">No network</span>
            )
          }
        />
        <Fact label="Runs on" value={PLATFORM[status.platform] ?? 'another system'} />
        <Fact label="Identity" mono value={(status.hostId.match(/.{1,4}/g) ?? []).slice(0, 4).join(' ') + ' …'} />
        {status.endorsement && (
          <Fact
            label="Confirmed by"
            value={status.endorsement.by}
          />
        )}
      </Rows>
    </Group>
  )
}
