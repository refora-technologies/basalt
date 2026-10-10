import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  FolderOpen, HardDrive, Info, Laptop, Shield, Volume2, Wifi } from 'lucide-react'
import { Switch } from './Switch'
import { setShowHidden, useShowHidden } from '@/lib/showHidden'
import type { KeyKind, Status } from '@/lib/api'
import {
  audioDevices,
  savedAudioDevice,
  setAudioDevice,
  type AudioDevice,
} from '@/lib/useMpv'
import { About } from './About'
import { Dropdown } from './ui/Dropdown'
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
}: {
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
          <Note>
            Basalt finds the host on your network by itself, even when its address
            changes. To use another drive, choose Change drive. This one stays paired,
            so you can come back to it in one click.
          </Note>
          <Action label="Change drive" onClick={onChangeDrive} />
          <Action label="Forget this drive" danger onClick={onForget} />
        </Section>

        <Section icon={Info} title="About" hint="Basalt, by Refora Technologies">
          <About product="Basalt" />
        </Section>

        <Section icon={FolderOpen} title="Files" hint="What folders show">
          <Switch
            label="Show hidden files"
            description="Files the host’s computer normally hides, such as desktop.ini and the Recycle Bin."
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
