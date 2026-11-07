import { Send, Trash2 } from 'lucide-react'

import type { HostStatus, SharingView } from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import { ActionRow, Group, SettingRow } from './ui/Group'
import { Switch } from './ui/Switch'

const GB = 1024 ** 3
/** The sizes a limit is picked from. */
export const LIMIT_CHOICES = [5, 10, 20, 50, 100, 200, 500].map((n) => n * GB)

/**
 * Sharing between devices: files sent through this host for a device that
 * was away. Sizes only, never names (D8): only the sender, the receiver and
 * someone at this computer can read them.
 */
export function SharingSettings({
  status,
  onSecure,
  onLimits,
  onNewProfileLimit,
  onProfileLimit,
  onClear,
}: {
  status: HostStatus
  onSecure: (secure: boolean) => void
  onLimits: (on: boolean) => void
  onNewProfileLimit: (bytes: number) => void
  /** null: back to the limit every profile gets. */
  onProfileLimit: (profile: string, bytes: number | null) => void
  onClear: () => void
}): React.JSX.Element | null {
  const sharing = status.sharing
  if (!sharing?.available) return null
  return (
    <Group icon={Send} title="Sharing between devices">
      <SettingRow
        onToggle={() => onSecure(!sharing.secure)}
        title="Keep shared files apart and locked"
        detail={
          sharing.secure
            ? 'Files sent through this host for someone offline are kept outside the drive, locked. Only the sender, the receiver and someone at this computer can read them.'
            : 'Files sent through this host go into a “Basalt shares” folder on the drive, one per profile, where anyone who uses the drive can open them.'
        }
        warn={!sharing.secure}
        control={<Switch checked={sharing.secure} onChange={onSecure} label="Keep shared files apart and locked" />}
      />
      <SettingRow
        onToggle={() => onLimits(!sharing.limitsOn)}
        title="Limit what each profile can keep here"
        detail={
          sharing.limitsOn
            ? 'A send through the host that doesn’t fit is refused, and the sender sees why.'
            : 'Off: a profile can keep as much as the host has room for.'
        }
        control={<Switch checked={sharing.limitsOn} onChange={onLimits} label="Limit what each profile can keep here" />}
      />
      {sharing.limitsOn && (
        <>
          {sharing.profiles.map((p) => (
            <SettingRow
              key={p.id}
              sub
              title={p.name}
              detail={`${formatBytes(p.used)} used`}
              control={
                <LimitPicker
                  value={p.limit}
                  general={sharing.newProfileLimit}
                  onChange={(bytes) => onProfileLimit(p.id, bytes)}
                />
              }
            />
          ))}
          <SettingRow
            sub
            title="New profiles get"
            control={<LimitPicker value={sharing.newProfileLimit} onChange={(bytes) => bytes !== null && onNewProfileLimit(bytes)} />}
          />
        </>
      )}
      {!sharing.limitsOn && sharing.used > 0 && (
        <p className="px-4 py-2.5 text-[11.5px] leading-snug text-textFaint">{byProfile(sharing)}</p>
      )}
      <ActionRow
        icon={<Trash2 size={14} className="text-danger" />}
        title="Clear share files"
        danger
        detail={sharedSaid(sharing)}
        disabled={sharing.count === 0}
        onClick={onClear}
      />
    </Group>
  )
}

/** "49.0 GB · 14 files · 3 profiles", or that there are none. */
export function sharedSaid(sharing: SharingView): string {
  if (sharing.count === 0) return 'No share files on this host'
  const shares = `${sharing.count} ${sharing.count === 1 ? 'share' : 'shares'}`
  const from = `from ${sharing.from} ${sharing.from === 1 ? 'profile' : 'profiles'}`
  return `${formatBytes(sharing.used)} · ${shares} · ${from}`
}

function byProfile(sharing: SharingView): string {
  return sharing.profiles
    .filter((p) => p.used > 0)
    .map((p) => `${p.name} ${formatBytes(p.used)}`)
    .join(' · ')
}

/** The question before "Clear share files". */
export function clearQuestion(sharing: SharingView): { title: string; message: string } {
  return {
    title: 'Clear all share files?',
    message: `${sharedSaid(sharing)}. Files still waiting for someone offline will never arrive; their senders see “Removed by the host”. This can’t be undone.`,
  }
}

/** Bytes on the drive's disk taken by share files: for its space bar. */
export function shareBytesOnDrive(sharing: SharingView | undefined): number {
  if (!sharing) return 0
  const plain = sharing.used - sharing.locked
  return plain + (sharing.sameDisk ? sharing.locked : 0)
}

function LimitPicker({
  value,
  general,
  onChange,
}: {
  /** null: the general limit, which `general` is. */
  value: number | null
  general?: number
  onChange: (bytes: number | null) => void
}): React.JSX.Element {
  const choices = [...new Set([...LIMIT_CHOICES, ...(value ? [value] : []), ...(general ? [general] : [])])].sort((a, b) => a - b)
  return (
    <select
      value={value === null ? 'general' : String(value)}
      onChange={(e) => onChange(e.target.value === 'general' ? null : Number(e.target.value))}
      className="rounded-md border border-lineBright bg-ink2 px-2 py-1 font-mono text-[12px] text-text outline-none"
    >
      {general !== undefined && <option value="general">{formatBytes(general)} (as all)</option>}
      {choices.map((bytes) => (
        <option key={bytes} value={String(bytes)}>
          {formatBytes(bytes)}
        </option>
      ))}
    </select>
  )
}
