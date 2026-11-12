import { Send, Trash2 } from 'lucide-react'

import type { ManagedSharing } from '@/lib/manage'
import { cn, formatBytes } from '@/lib/utils'
import { Group, Row, Rows, Toggle, useLayout } from './parts'
import type { Tools } from './tools'

const GB = 1024 ** 3
const LIMIT_CHOICES = [5, 10, 20, 50, 100, 200, 500].map((n) => n * GB)

/**
 * Sharing between devices: files sent through the host for a device that
 * was away. The same rows as the host's own window (D7, D8, D13): sizes per
 * profile, never names.
 */
export function SharingGroup({ m, view, confirm }: Tools): React.JSX.Element | null {
  const phone = useLayout() === 'phone'
  const sharing = view.status.sharing
  if (!sharing?.available) return null

  const clear = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear all share files?',
      message: `${sharedSaid(sharing)}. Files still waiting for someone offline will never arrive; their senders see “Removed by the host”. This can’t be undone.`,
      confirmLabel: 'Clear share files',
      danger: true,
    })
    if (ok) await m.act({ do: 'clearShares' })
  }

  return (
    <Group icon={Send} title="Sharing between devices">
      <Rows>
        <Toggle
          title="Keep shared files apart and locked"
          description={
            sharing.secure
              ? 'Files sent through the host for someone offline are kept outside the drive, locked. Only the sender, the receiver and someone at the host computer can read them.'
              : 'Files sent through the host go into a “Basalt shares” folder on the drive, one per profile, where anyone who uses the drive can open them.'
          }
          warn={!sharing.secure}
          checked={sharing.secure}
          onChange={(secure) => m.act({ do: 'setShareSecure', secure })}
        />
        <Toggle
          title="Limit what each profile can keep"
          description={
            sharing.limitsOn
              ? 'A send through the host that doesn’t fit is refused, and the sender sees why.'
              : 'Off: a profile can keep as much as the host has room for.'
          }
          checked={sharing.limitsOn}
          onChange={(on) => m.act({ do: 'setShareLimits', on })}
        />
        {sharing.limitsOn &&
          sharing.profiles.map((p) => (
            <Row
              key={p.id}
              title={p.name}
              sub={`${formatBytes(p.used)} used`}
              end={
                <LimitPicker
                  phone={phone}
                  value={p.limit}
                  general={sharing.newProfileLimit}
                  onChange={(limit) => void m.act({ do: 'setShareLimits', profile: p.id, limit })}
                />
              }
            />
          ))}
        {sharing.limitsOn && (
          <Row
            title="New profiles get"
            end={
              <LimitPicker
                phone={phone}
                value={sharing.newProfileLimit}
                onChange={(bytes) => bytes !== null && void m.act({ do: 'setShareLimits', newProfile: bytes })}
              />
            }
          />
        )}
        {!sharing.limitsOn && sharing.used > 0 && <Row title="Space by profile" sub={byProfile(sharing)} />}
        <Row
          icon={<Trash2 size={phone ? 17 : 14} />}
          danger
          title="Clear share files"
          sub={sharedSaid(sharing)}
          disabled={sharing.count === 0 || m.busy !== null}
          onClick={() => void clear()}
        />
      </Rows>
    </Group>
  )
}

/** "49.0 GB · 14 shares · from 3 profiles", or that there are none. */
export function sharedSaid(sharing: ManagedSharing): string {
  if (sharing.count === 0) return 'No share files on the host'
  const shares = `${sharing.count} ${sharing.count === 1 ? 'share' : 'shares'}`
  const from = `from ${sharing.from} ${sharing.from === 1 ? 'profile' : 'profiles'}`
  return `${formatBytes(sharing.used)} · ${shares} · ${from}`
}

function byProfile(sharing: ManagedSharing): string {
  return sharing.profiles
    .filter((p) => p.used > 0)
    .map((p) => `${p.name} ${formatBytes(p.used)}`)
    .join(' · ')
}

/** Bytes on the drive's disk taken by share files: for its space bar. */
export function shareBytesOnDrive(sharing: ManagedSharing | undefined): number {
  if (!sharing) return 0
  return sharing.used - sharing.locked + (sharing.sameDisk ? sharing.locked : 0)
}

function LimitPicker({
  value,
  general,
  onChange,
  phone,
}: {
  /** null: the general limit, which `general` is. */
  value: number | null
  general?: number
  onChange: (bytes: number | null) => void
  phone: boolean
}): React.JSX.Element {
  const choices = [...new Set([...LIMIT_CHOICES, ...(value ? [value] : []), ...(general ? [general] : [])])].sort((a, b) => a - b)
  return (
    <select
      value={value === null ? 'general' : String(value)}
      onChange={(e) => onChange(e.target.value === 'general' ? null : Number(e.target.value))}
      className={cn(
        'shrink-0 rounded-lg border border-white/10 bg-white/[0.04] font-mono text-text outline-none',
        phone ? 'px-3 py-2 text-[14px]' : 'px-2 py-1 text-[12px]',
      )}
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
