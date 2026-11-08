import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  FolderOpen, HardDrive, Info, Laptop, Radio, Send, Shield, Volume2, Wifi } from 'lucide-react'
import type { Nearby } from '@/lib/useNearby'
import { NearbySwitches } from '@/components/share/Nearby'
import { Switch } from './Switch'
import { setShowHidden, useShowHidden } from '@/lib/showHidden'
import { api, type KeyKind, type Status } from '@/lib/api'
import type { Inbox } from '@/lib/useInbox'
import type { Presence } from '@/lib/usePresence'
import { useAlwaysReady } from '@/lib/alwaysReady'
import { HeldList } from './share/Held'
import { SyncLogPanel } from './music/SyncLog'
import {
  audioDevices,
  savedAudioDevice,
  setAudioDevice,
  type AudioDevice,
} from '@/lib/useMpv'
import { About } from './About'
import { Dropdown } from './ui/Dropdown'
import { SpeedTest } from './SpeedTest'
import { cn, formatBytes } from '@/lib/utils'

/**
 * Settings.
 *
 * Every value here is read from the live connection. Where a setting is not
 * adjustable it is shown as a fact rather than as a switch that does nothing —
 * compression, batching and verification are always on because the
 * measurements left no case for turning them off, and a toggle implying
 * otherwise would be a lie about the software.
 */
/**
 * Which output mpv plays through.
 *
 * Read from mpv rather than from Windows: it is mpv that has to open the
 * device, and its list is the one that can actually be selected.
 */
function AudioOutput(): React.JSX.Element {
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [chosen, setChosen] = useState(savedAudioDevice)

  useEffect(() => {
    void audioDevices().then(setDevices)
  }, [])

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-[12.5px] text-textDim">Audio output</span>
      <Dropdown
        label="Audio output"
        className="w-[62%] max-w-[420px]"
        value={chosen}
        onChange={(next) => {
          setChosen(next)
          void setAudioDevice(next)
        }}
        options={[
          { value: 'auto', label: 'Automatic' },
          ...devices
            .filter((device) => device.name !== 'auto')
            .map((device) => ({ value: device.name, label: device.description })),
        ]}
      />
    </div>
  )
}

export function SettingsView({
  status,
  space,
  onForget,
  onChangeDrive,
  inbox,
  presence,
  nearby,
}: {
  /** Sharing between the host's devices, on a host that passes shares. */
  inbox?: Inbox
  /** Sharing with devices nearby, without a host. */
  nearby?: Nearby
  /** Who is online, for sharing again. */
  presence?: Presence
  status: Status | null
  space: [number, number] | null
  /** Unpairs from this vault; pairing with another starts from there. */
  onForget: () => void
  /** The drive list, to use another drive; this one stays paired. */
  onChangeDrive: () => void
}): React.JSX.Element {
  const [free, total] = space ?? [0, 0]
  const showHidden = useShowHidden()

  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-[640px] space-y-6">
        <Section icon={HardDrive} title="Drive" hint="The drive this app opens">
          <Row label="Name" value={status?.vault ?? '—'} />
          <Row label="Host" value={status?.hostName ?? '—'} />
          <Row label="Address" value={status?.address ?? 'Not connected'} mono />
          <Row
            label="Space"
            value={total > 0 ? `${formatBytes(free)} free of ${formatBytes(total)}` : '—'}
            mono
          />
          <Row label="Access" value={status?.writable ? 'Can change files' : 'Read only'} />
          {status?.address && <SpeedTest padded />}
          <Note>
            Basalt finds the host on your network by itself, even when its address
            changes. To use another drive, choose Change drive. This one stays paired,
            so you can come back to it in one click.
          </Note>
          <Action label="Change drive" onClick={onChangeDrive} />
          <Action label="Forget this drive" danger onClick={onForget} />
        </Section>

        {inbox && <SharingSection inbox={inbox} presence={presence} />}
        {nearby && (
          <Section icon={Radio} title="Nearby" hint="Devices around you that aren’t on your host">
            <NearbySwitches nearby={nearby} className="rounded-none px-4 py-2.5" />
          </Section>
        )}

        <Section icon={FolderOpen} title="Files" hint="What folders show">
          <Switch
            label="Show hidden files"
            description="Files the host’s computer normally hides, like desktop.ini on Windows or names starting with a dot on Linux."
            checked={showHidden}
            onChange={setShowHidden}
            // The same inset as every other row in Settings.
            className="rounded-none px-4 py-2.5"
          />
        </Section>

        <Section icon={Volume2} title="Playback" hint="Where the sound goes">
          <AudioOutput />
          <Note>
            {/* Worth saying, because the list is mpv's and not the system's, and
                the names differ enough to be confusing. */}
            Only for Basalt: other apps keep their own choice.{' '}
            <span className="text-textDim">Automatic</span> follows your computer’s
            sound setting.
          </Note>
          <SyncLogPanel />
        </Section>

        <Section icon={Wifi} title="Connection" hint="Between this computer and the host">
          <Row label="Encryption" value="Always on" />
          <Row label="Files" value="Checked as they arrive" />
          <Note>
            Everything between this computer and the host is encrypted, and every
            file is checked so it arrives exactly as it was. On Wi-Fi, connecting
            the host with a cable makes the biggest difference to speed.
          </Note>
        </Section>

        <Section icon={Laptop} title="This device" hint="How the host knows it">
          <Row label="Name" value={status?.deviceName ?? '—'} />
          <Note>
            Shown in the host&rsquo;s device list, where it can be removed at any
            time.
          </Note>
        </Section>

        <Section icon={Shield} title="Security">
          <Row
            label="Host identity"
            value={status?.hostId ? formatIdentity(status.hostId) : '—'}
            mono
          />
          <Row label="Security key" value={keyPlace(status?.key ?? null)} />
          <Row
            label="Signs in with"
            value={
              !status?.connected
                ? '—'
                : status.signsInWithKey
                  ? 'Its security key'
                  : 'Its pairing code'
            }
          />
          {status?.owner && <Row label="Manages this host" value="Yes" />}
          <Note>
            This computer only connects to the host it paired with, and proves who
            it is with its own key, which never leaves it.
          </Note>
        </Section>

        <Section icon={Info} title="About" hint="Basalt, by Refora Technologies">
          <About product="Basalt" />
        </Section>
      </div>
    </div>
  )
}

/** Where the device's key is kept, in words. */
function keyPlace(key: KeyKind | null): string {
  switch (key) {
    case 'chip':
      return 'In this computer’s security chip'
    case 'system':
      return 'Protected by Windows'
    case 'file':
      return 'In a file only Basalt can read'
    default:
      return 'Created when first needed'
  }
}

/** Groups a long hex identity so a person can compare it against a screen. */
function formatIdentity(hostId: string): string {
  return (hostId.match(/.{1,4}/g) ?? [hostId]).slice(0, 4).join(' ') + ' …'
}

function Section({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: typeof HardDrive
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="glass overflow-hidden rounded-lg"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <Icon size={15} className="text-textDim" />
        <span className="text-sm font-semibold tracking-tight text-text">{title}</span>
        {hint && <span className="ml-auto text-[11px] text-textFaint">{hint}</span>}
      </div>
      <div className="divide-y divide-white/[0.04]">{children}</div>
    </motion.section>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <span className="text-[13px] text-textDim">{label}</span>
      <span className={cn('text-[13px] text-text', mono && 'font-mono text-[12px]')}>
        {value}
      </span>
    </div>
  )
}

function Action({
  label,
  danger,
  onClick,
}: {
  label: string
  danger?: boolean
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div className="px-4 py-2.5">
      <button
        onClick={onClick}
        className={cn(
          'rounded-md border px-3 py-1.5 text-[12px] transition-colors',
          danger
            ? 'border-danger/25 bg-dangerBg text-danger hover:border-danger/50'
            : 'border-white/10 text-textDim hover:border-white/20 hover:text-text',
        )}
      >
        {label}
      </button>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-4 py-2.5 text-[11px] leading-relaxed text-textFaint">{children}</div>
  )
}

/** Sharing: whether the home's other profiles ask first, and where files land. */
function SharingSection({ inbox, presence }: { inbox: Inbox; presence?: Presence }): React.JSX.Element {
  const [usual, setUsual] = useState('')
  const [alwaysReady, setAlwaysReady] = useAlwaysReady()
  useEffect(() => {
    void api
      .defaultReceivedFolder()
      .then(setUsual)
      .catch(() => {})
  }, [])
  const choose = async (): Promise<void> => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ directory: true, multiple: false, title: 'Where shared files go' })
    if (typeof picked === 'string') inbox.setFolder(picked)
  }
  return (
    <Section icon={Send} title="Sharing" hint="Between your devices and this home">
      <Switch
        label="Always ready to receive"
        description="When you close Basalt, a small part keeps running in the tray, to receive files and tell you when something comes. Quit it from the tray icon."
        checked={alwaysReady}
        onChange={setAlwaysReady}
        className="rounded-none px-4 py-2.5"
      />
      <Switch
        label="Accept files from this home without asking"
        description="From the other profiles on this host. Your own devices never ask."
        checked={inbox.acceptFromHome}
        onChange={inbox.setAcceptFromHome}
        className="rounded-none px-4 py-2.5"
      />
      <Switch
        label="Remove from the host once answered"
        description="When someone accepts or declines what you sent through the host. You can change it for one send."
        checked={inbox.removeOnAnswer}
        onChange={inbox.setRemoveOnAnswer}
        className="rounded-none px-4 py-2.5"
      />
      <div className="flex items-center justify-between gap-4 px-4 py-2.5">
        <span className="min-w-0">
          <span className="block text-[13px] text-textDim">Received files go to</span>
          <span className="block truncate font-mono text-[12px] text-text">{inbox.folder || usual || '…'}</span>
        </span>
        <span className="flex shrink-0 gap-2">
          {inbox.folder && (
            <button onClick={() => inbox.setFolder('')} className="rounded-md px-2.5 py-1.5 text-[12px] text-textDim hover:bg-white/[0.05] hover:text-text">
              Usual folder
            </button>
          )}
          <button onClick={() => void choose()} className="rounded-md border border-white/10 px-2.5 py-1.5 text-[12px] text-text hover:bg-white/[0.05]">
            Change…
          </button>
        </span>
      </div>
      <div className="px-4 pb-1 pt-2 text-[13px] text-textDim">Shared through host</div>
      <HeldList inbox={inbox} presence={presence} />
    </Section>
  )
}
