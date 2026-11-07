import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  Download,
  FileText,
  Film,
  HardDrive,
  Hash,
  Image,
  Laptop,
  Monitor,
  Music,
  Send,
  Smartphone,
  Tablet,
  Tv,
  X,
} from 'lucide-react'

import { api, onShareSending, type PresentDevice } from '@/lib/api'
import { SendWithCode } from './Nearby'
import type { Presence } from '@/lib/usePresence'
import { seenLine } from '@/lib/usePresence'
import type { Inbox } from '@/lib/useInbox'
import { calledOf, isProgram, targetsOf, titleOf, totalOf, type ShareFile, type ShareItem } from '@/lib/share'
import { cn, formatBytes } from '@/lib/utils'
import { profileColor } from '@/lib/useIdentity'

/**
 * Sharing, the parts both the phone and the computer show: the list of
 * devices to share with, the prompt for one that came, and the Inbox's lists.
 * Each app puts them in its own sheet or window.
 */

// ---------------------------------------------------------------------------
// Choosing where it goes
// ---------------------------------------------------------------------------

/**
 * The Share sheet's body: this person's devices, then the home by person,
 * then devices on their own. A plain list; a device tapped is chosen, and one
 * button at the bottom says what will happen.
 */
export function ShareChooser({
  files,
  presence,
  inbox,
  onDone,
}: {
  files: ShareFile[]
  presence: Presence
  inbox: Inbox
  onDone: (said: string) => void
}): React.JSX.Element {
  const targets = useMemo(() => targetsOf(presence.devices, presence.you), [presence])
  const [chosen, setChosen] = useState<PresentDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removeIfAnswered, setRemoveIfAnswered] = useState(inbox.removeOnAnswer)
  const myProfile = presence.devices.find((d) => d.device === presence.you)?.profile
  const onDrive = files.every((f) => !f.source)
  // All on the drive, or all on this device (uploaded to the host first).
  const holdable = onDrive || files.every((f) => f.source)
  // How far files on this device have gone up to the host.
  const [upPart, setUpPart] = useState<number | null>(null)
  useEffect(() => {
    if (!busy || onDrive) {
      setUpPart(null)
      return
    }
    let gone = false
    let stop: (() => void) | null = null
    void onShareSending((s) => setUpPart(s.total > 0 ? s.done / s.total : null)).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [busy, onDrive])
  const nobody = targets.mine.length + targets.home.length + targets.loose.length === 0
  // To a device not on this host, nearby, by a code (05): files on this device only.
  const [byCode, setByCode] = useState(false)
  const onThisDevice = files.length > 0 && files.every((f) => f.source)
  // What the host can keep now, asked once a device that's away is chosen.
  const [host, setHost] = useState<{ room?: number; secure?: boolean } | null>(null)
  const away = chosen !== null && !chosen.online
  useEffect(() => {
    if (!away || !holdable) return
    let live = true
    api
      .shareHeld()
      .then((answer) => live && setHost({ room: answer.room, secure: answer.secure }))
      .catch(() => live && setHost({}))
    return () => {
      live = false
    }
  }, [away, holdable])
  const noRoom = host?.room !== undefined && totalOf(files) > host.room

  const send = async (): Promise<void> => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      if (!chosen.online) {
        await inbox.sendThroughHost(files, chosen, !removeIfAnswered)
        onDone(`On the host for ${chosen.name}. It arrives when it’s back.`)
        return
      }
      await inbox.send(files, chosen)
      const who = calledOf({ device: chosen.device, name: chosen.name, form: chosen.form, profile: chosen.profile, profileName: chosen.profileName }, myProfile)
      onDone(chosen.profile && chosen.profile === myProfile ? `Sent to ${who}.` : `Sent. ${chosen.profileName ?? chosen.name} is asked to accept.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const row = (device: PresentDevice, indent = false): React.JSX.Element => (
    <DeviceRow
      key={device.device}
      device={device}
      chosen={chosen?.device === device.device}
      indent={indent}
      onClick={() => {
        setError(null)
        setChosen((c) => (c?.device === device.device ? null : device))
      }}
    />
  )

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 pb-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-textDim">
          <FileIcon name={files[0]?.name ?? ''} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold text-text">Share “{titleOf(files)}”</span>
          <span className="block font-mono text-[11.5px] text-textFaint">
            {files.length > 1 ? `${files.length} files · ` : ''}
            {formatBytes(totalOf(files))}
          </span>
        </span>
      </div>

      {byCode ? (
        <div className="min-h-0 flex-1 overflow-y-auto pb-1 pt-2">
          <SendWithCode files={files} onDone={() => onDone('')} />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {nobody && !onThisDevice && (
          <p className="px-5 py-6 text-[13px] leading-relaxed text-textFaint">
            No other devices on this host yet. Pair another phone or computer, and it shows here.
          </p>
        )}
        {targets.mine.length > 0 && (
          <>
            <Section>My devices</Section>
            {targets.mine.map((d) => row(d))}
          </>
        )}
        {(targets.home.length > 0 || targets.loose.length > 0) && <Section>This home</Section>}
        {targets.home.map((group) => (
          <div key={group.profile}>
            <div className="flex items-center gap-2.5 px-5 pb-0.5 pt-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: profileColor(group.color ?? 0) }}
              >
                {group.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-[13px] font-semibold text-text">{group.name}</span>
            </div>
            {group.devices.map((d) => row(d, true))}
          </div>
        ))}
        {targets.loose.map((d) => row(d))}
        {onThisDevice && (
          <>
            <Section>Nearby</Section>
            <button
              onClick={() => setByCode(true)}
              className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-white/[0.03] active:bg-white/[0.05]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-textDim">
                <Hash size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-text">Send with a code</span>
                <span className="block text-[12px] text-textFaint">To a device not on this host, on the same Wi-Fi</span>
              </span>
            </button>
          </>
        )}
      </div>
      )}

      {chosen && !byCode && (
        <div className="border-t border-white/[0.06] px-5 pt-3.5">
          {chosen.online ? (
            <button
              disabled={busy}
              onClick={() => void send()}
              className="w-full rounded-full bg-white py-3 text-[14px] font-semibold text-black transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? 'Sending…' : `Send to ${calledOf({ device: chosen.device, name: chosen.name, form: chosen.form, profile: chosen.profile, profileName: chosen.profileName }, myProfile)}`}
            </button>
          ) : holdable && noRoom ? (
            <button disabled className="w-full rounded-full bg-white/[0.06] py-3 text-[14px] font-semibold text-textFaint">
              Send through host
            </button>
          ) : holdable ? (
            <button
              disabled={busy}
              onClick={() => void send()}
              className="w-full rounded-full bg-white py-3 text-[14px] font-semibold text-black transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {busy
                ? upPart !== null && upPart < 1
                  ? `Sending to the host… ${Math.floor(upPart * 100)}%`
                  : 'Keeping it on the host…'
                : 'Send through host'}
            </button>
          ) : (
            <button disabled className="w-full rounded-full bg-white/[0.06] py-3 text-[14px] font-semibold text-textFaint">
              Not online
            </button>
          )}
          <p className="mt-2 text-center text-[12px] leading-snug text-textFaint">
            {error ??
              (chosen.online
                ? `${files.some((f) => f.source) ? 'Straight to it, on this Wi-Fi.' : 'From the drive, straight to it.'} ${
                    chosen.profile && chosen.profile === myProfile
                      ? 'It arrives at once.'
                      : `${chosen.profileName ?? 'They'} ${chosen.profileName ? 'is' : 'are'} asked to accept.`
                  }`
                : holdable && noRoom
                  ? `${chosen.name} isn’t online, and the host hasn’t room to keep this for it: ${formatBytes(host?.room ?? 0)} left for you.`
                  : holdable
                  ? `${chosen.name} isn’t online. The host keeps it${host?.secure === false ? ' in its Basalt shares folder' : ', locked,'} and delivers it when it’s back.`
                  : 'Send files from the drive and from this device apart.')}
          </p>
          {!chosen.online && holdable && (
            <label className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] px-3 py-2.5 text-[12.5px] text-textDim">
              <span>Remove it from the host once it’s answered</span>
              <input
                type="checkbox"
                checked={removeIfAnswered}
                onChange={(e) => setRemoveIfAnswered(e.target.checked)}
                className="h-4 w-4 accent-white"
              />
            </label>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-5 pb-1 pt-3.5 font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">{children}</div>
  )
}

function DeviceRow({
  device,
  chosen,
  indent,
  onClick,
}: {
  device: PresentDevice
  chosen: boolean
  indent: boolean
  onClick: () => void
}): React.JSX.Element {
  const Icon = deviceIcon(device.form)
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 py-2.5 text-left transition-colors',
        indent ? 'pl-14 pr-5' : 'px-5',
        chosen ? 'bg-white/[0.07]' : 'active:bg-white/[0.05] hover:bg-white/[0.03]',
      )}
    >
      <span
        className={cn(
          'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          device.online ? 'bg-white/[0.08] text-text' : 'bg-white/[0.04] text-textFaint',
        )}
      >
        <Icon size={16} />
        {device.online && (
          <span className="absolute -bottom-px -right-px h-3 w-3 rounded-full border-2 border-panel2 bg-emerald-400/80" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[14.5px]', device.online ? 'text-text' : 'text-textDim')}>{device.name}</span>
        <span className="block truncate text-[12px] text-textFaint">{seenLine(device, Date.now())}</span>
      </span>
      {chosen && (
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-white text-black">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

export function deviceIcon(form: PresentDevice['form']): typeof Laptop {
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

function FileIcon({ name, size = 18 }: { name: string; size?: number }): React.JSX.Element {
  if (/\.(mkv|mp4|mov|avi|webm|m4v)$/i.test(name)) return <Film size={size} />
  if (/\.(mp3|flac|m4a|wav|ogg|opus|aac)$/i.test(name)) return <Music size={size} />
  if (/\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(name)) return <Image size={size} />
  return <FileText size={size} />
}

// ---------------------------------------------------------------------------
// One that came
// ---------------------------------------------------------------------------

/**
 * An offer waiting for this person: who from, what, and the three ways to
 * answer. "Accept on another device" opens this person's other devices that
 * are online; the one picked takes it instead.
 */
export function ReceivePrompt({
  item,
  presence,
  inbox,
  compact,
  onDone,
}: {
  item: ShareItem
  presence: Presence
  inbox: Inbox
  /** The computer's corner card: smaller. */
  compact?: boolean
  onDone: () => void
}): React.JSX.Element {
  const [elsewhere, setElsewhere] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = presence.devices.find((d) => d.device === presence.you)
  const others = presence.devices.filter(
    (d) => d.device !== presence.you && d.online && d.form !== 'tv' && !!me?.profile && d.profile === me.profile,
  )
  const from = item.peer.profileName ?? item.peer.name
  const programs = item.files.filter((f) => isProgram(f.name))
  return (
    <div className={compact ? '' : 'px-5'}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[14px] font-semibold text-text">
          {from.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className={cn('block font-semibold text-text', compact ? 'text-[13.5px]' : 'text-[15px]')}>
            {from} wants to send you {item.files.length === 1 ? 'a file' : `${item.files.length} files`}
          </span>
          <span className="block text-[12px] text-textFaint">From {item.peer.name}</span>
        </span>
      </div>
      <div className="mt-3.5 flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-textDim">
          <FileIcon name={item.files[0]?.name ?? ''} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] text-text">{titleOf(item.files)}</span>
          <span className="block font-mono text-[11.5px] text-textFaint">{formatBytes(totalOf(item.files))}</span>
        </span>
      </div>
      {programs.length > 0 && (
        <p className="mt-2.5 rounded-xl bg-white/[0.04] px-3 py-2 text-[12px] leading-snug text-textDim">
          {programs.length === item.files.length ? 'This is a program.' : 'There are programs among these.'} Basalt never opens
          one by itself; only open it if you trust where it came from.
        </p>
      )}
      <div className={cn('mt-4 flex gap-2.5', compact ? 'flex-row flex-wrap' : 'flex-col')}>
        <button
          onClick={() => {
            inbox.accept(item)
            onDone()
          }}
          className={cn('rounded-full bg-white font-semibold text-black active:scale-[0.98]', compact ? 'px-4 py-2 text-[12.5px]' : 'py-3 text-[14px]')}
        >
          {compact ? 'Accept' : `Accept on this ${me?.form === 'computer' ? 'computer' : me?.form === 'tablet' ? 'tablet' : 'phone'}`}
        </button>
        {others.length > 0 && (
          <button
            onClick={() => setElsewhere((v) => !v)}
            className={cn('rounded-full border border-white/[0.16] text-text', compact ? 'px-4 py-2 text-[12.5px]' : 'py-3 text-[14px]')}
          >
            {compact ? 'On another device' : 'Accept on another device'}
          </button>
        )}
        <button
          onClick={() => {
            inbox.decline(item)
            onDone()
          }}
          className={cn('text-textDim', compact ? 'ml-auto px-2 py-2 text-[12.5px]' : 'py-2 text-[13px]')}
        >
          Decline
        </button>
      </div>
      {elsewhere && (
        <div className="mt-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] py-1">
          {others.map((d) => {
            const Icon = deviceIcon(d.form)
            return (
              <div key={d.device} className="flex items-center gap-3 px-3 py-2">
                <Icon size={16} className="shrink-0 text-textDim" />
                <span className="min-w-0 flex-1 truncate text-[14px] text-text">{d.name}</span>
                <button
                  onClick={() =>
                    void inbox
                      .acceptOn(item, d)
                      .then(onDone)
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                  }
                  className="rounded-full bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-black"
                >
                  Accept here
                </button>
              </div>
            )
          })}
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The Inbox's lists
// ---------------------------------------------------------------------------

/** Received or Sent: what's waiting, what's moving, and earlier ones. */
export function InboxList({
  inbox,
  presence,
  direction,
  onAnswer,
}: {
  inbox: Inbox
  presence: Presence
  direction: 'in' | 'out'
  /** Opens the prompt for one waiting. */
  onAnswer: (item: ShareItem) => void
}): React.JSX.Element {
  const myProfile = presence.devices.find((d) => d.device === presence.you)?.profile
  const mine = inbox.items.filter((i) => i.direction === direction)
  const waiting = mine.filter((i) => i.state === 'waiting')
  const moving = mine.filter((i) => i.state === 'moving')
  const earlier = mine.filter((i) => i.state !== 'waiting' && i.state !== 'moving')
  if (mine.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-[13px] leading-relaxed text-textFaint">
        {direction === 'in'
          ? 'Nothing received yet. Files shared with this device show here.'
          : 'Nothing sent yet. Choose Share on any file or folder.'}
      </p>
    )
  }
  const line = (item: ShareItem): string => {
    const who = calledOf(item.peer, myProfile)
    if (direction === 'in') {
      if (item.state === 'waiting') return `From ${who} · ${formatBytes(totalOf(item.files))}`
      if (item.state === 'moving') return `From ${who} · from the host`
      if (item.state === 'done') return item.takenOn ? `Taken on ${item.takenOn}` : `From ${who} · ${item.savedAs ?? 'received'}`
      if (item.state === 'declined') return `From ${who} · declined`
      return `From ${who} · didn’t arrive${item.reason ? `: ${item.reason}` : ''}`
    }
    if (item.state === 'waiting') return `To ${who} · waiting for an answer`
    if (item.state === 'moving') return `To ${item.takenOn ?? who} · on its way`
    if (item.state === 'done') return `To ${item.takenOn ?? who} · arrived`
    if (item.state === 'declined') return `To ${who} · declined`
    return `To ${who} · didn’t arrive${item.reason ? `: ${item.reason}` : ''}`
  }
  const rowOf = (item: ShareItem): React.JSX.Element => (
    <div key={`${item.direction}-${item.id}`} className="flex items-center gap-3 px-5 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-textDim">
        {item.state === 'done' ? (
          <Check size={15} />
        ) : item.state === 'declined' || item.state === 'failed' ? (
          <X size={15} />
        ) : item.state === 'moving' ? (
          <Download size={15} />
        ) : direction === 'in' ? (
          <HardDrive size={15} />
        ) : (
          <Send size={15} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] text-text">{titleOf(item.files)}</span>
        <span className="block truncate text-[12px] text-textFaint">{line(item)}</span>
      </span>
      {direction === 'in' && item.state === 'waiting' && item.offer && (
        <button onClick={() => onAnswer(item)} className="rounded-full bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-black">
          Answer
        </button>
      )}
    </div>
  )
  return (
    <div className="pb-4">
      {waiting.length > 0 && (
        <>
          <Section>{direction === 'in' ? 'Waiting for you' : 'Waiting for an answer'}</Section>
          {waiting.map(rowOf)}
        </>
      )}
      {moving.length > 0 && (
        <>
          <Section>Moving now</Section>
          {moving.map(rowOf)}
        </>
      )}
      {earlier.length > 0 && (
        <>
          <Section>Earlier</Section>
          {earlier.map(rowOf)}
        </>
      )}
    </div>
  )
}
