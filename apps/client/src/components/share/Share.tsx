import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  ChevronDown,
  ExternalLink,
  FileText,
  FolderOpen,
  Share2,
  Upload,
  Film,
  Image,
  Laptop,
  Loader2,
  Monitor,
  Music,
  Smartphone,
  Tablet,
  Tv,
  X,
} from 'lucide-react'

import { api, onShareSending, type NearbyDevice, type PresentDevice } from '@/lib/api'
import { NearbyChooser, NearbyList } from './Nearby'
import type { Nearby } from '@/lib/useNearby'
import type { Presence } from '@/lib/usePresence'
import { seenLine } from '@/lib/usePresence'
import type { Inbox } from '@/lib/useInbox'
import {
  calledOf,
  isProgram,
  percentOf,
  progressLine,
  targetsOf,
  titleOf,
  totalOf,
  type Progress,
  type SavedFile,
  type ShareFile,
  type ShareItem,
} from '@/lib/share'
import { cn, formatBytes } from '@/lib/utils'
import { android } from '@/lib/android'
import { isAndroid } from '@/lib/platform'
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
  sheet,
  nearby,
}: {
  files: ShareFile[]
  presence: Presence
  inbox: Inbox
  onDone: (said: string) => void
  /** Devices nearby, not on this host: for files on this device. */
  nearby?: Nearby
  /** In a phone's sheet: the button stays at the bottom, over the list, never scrolled away. */
  sheet?: boolean
}): React.JSX.Element {
  const targets = useMemo(() => targetsOf(presence.devices, presence.you), [presence])
  const [chosen, setChosen] = useState<PresentDevice | null>(null)
  const [busy, setBusy] = useState(false)
  // Pressed once is sent once: a second press while the first is on its
  // way does nothing (it offered the same file five times to the other side).
  const sending = useRef(false)
  /** Sent: the window follows it from here. */
  const [sent, setSent] = useState<{ id: string; to: string } | null>(null)
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
  const [nearbyPick, setNearbyPick] = useState<NearbyDevice | null>(null)
  const byCode = nearbyPick !== null
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
    if (!chosen || sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    try {
      if (!chosen.online) {
        await inbox.sendThroughHost(files, chosen, !removeIfAnswered)
        onDone(`On the host for ${chosen.name}. It arrives when it’s back.`)
        return
      }
      const id = await inbox.send(files, chosen)
      const who = calledOf({ device: chosen.device, name: chosen.name, form: chosen.form, profile: chosen.profile, profileName: chosen.profileName }, myProfile)
      setSent({ id, to: who })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      sending.current = false
    } finally {
      setBusy(false)
    }
  }
  const sentItem = sent ? (inbox.items.find((i) => i.id === sent.id && i.direction === 'out') ?? null) : null

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

      {sent ? (
        <ShareStatus item={sentItem} to={sent.to} progress={sentItem ? inbox.progressOf(sentItem) : null} onDone={() => onDone('')} />
      ) : nearbyPick && nearby ? (
        <div className="flex min-h-0 flex-1 flex-col pb-1 pt-2">
          <NearbyChooser nearby={nearby} files={files} phone={sheet} initial={nearbyPick} onDone={() => onDone('')} />
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
        {nearby && (onThisDevice || onDrive) && (
          <>
            <Section>Nearby, not in this home</Section>
            <NearbyList nearby={nearby} chosen={null} onChoose={setNearbyPick} />
          </>
        )}
      </div>
      )}

      {!chosen && !byCode && !nobody && !sent && (
        <div className={cn('border-t border-white/[0.06] px-5 pt-3.5', sheet && 'sticky bottom-0 bg-[#141416] pb-1')}>
          <button disabled className="w-full rounded-full bg-white/[0.06] py-3 text-[14px] font-semibold text-textFaint">
            Choose where it goes
          </button>
        </div>
      )}
      {chosen && !byCode && !sent && (
        <div
          className={cn(
            'border-t border-white/[0.06] px-5 pt-3.5',
            sheet && 'sticky bottom-0 bg-[#141416] pb-1 shadow-[0_-10px_20px_rgba(0,0,0,0.35)]',
          )}
        >
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

/** What a share's row says under its name. */
export function shareLine(item: ShareItem, who: string, progress: Progress | null): string {
  if (item.direction === 'in') {
    if (item.state === 'waiting') return `From ${who} · ${formatBytes(totalOf(item.files))}`
    if (item.state === 'moving') return progress ? `From ${who}` : `From ${who} · ${item.reason ?? 'starting…'}`
    if (item.state === 'done') {
      if (item.takenOn) return `Taken on ${item.takenOn}`
      // Several: the folder they're in, not the last one's name.
      const where = item.savedAs && item.files.length > 1 ? item.savedAs.replace(/[\\/][^\\/]*$/, '') : item.savedAs
      return `From ${who} · ${where ?? 'received'}`
    }
    if (item.state === 'declined') return `From ${who} · declined`
    return `From ${who} · didn’t arrive${item.reason ? `: ${item.reason}` : ''}`
  }
  if (item.state === 'waiting') return `To ${who} · ${item.reason ?? 'waiting for an answer'}`
  if (item.state === 'moving') {
    if (progress?.up) return `To ${who} · going up to the host`
    return progress ? `To ${item.takenOn ?? who}` : `To ${item.takenOn ?? who} · ${item.reason ?? 'on its way'}`
  }
  if (item.state === 'done') return `To ${item.takenOn ?? who} · arrived`
  if (item.state === 'declined') return `To ${who} · declined`
  return `To ${who} · didn’t arrive${item.reason ? `: ${item.reason}` : ''}`
}

/**
 * One share in the Inbox: what it is, who it's from or for, how far it has
 * come while it moves, and, once here, what can be done with it.
 */
function ShareRow({
  item,
  who,
  progress,
  onAnswer,
  onForget,
}: {
  item: ShareItem
  who: string
  progress: Progress | null
  onAnswer: () => void
  onForget: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saved = item.direction === 'in' && item.state === 'done' && !item.takenOn ? (item.saved ?? []) : []
  const finished = item.state === 'done' || item.state === 'declined' || item.state === 'failed'
  // One simple mark per state, drawn the same size everywhere: a tick,
  // a cross, an arrow the way it goes, or a clock while it waits.
  const Badge =
    item.state === 'done'
      ? Check
      : item.state === 'declined' || item.state === 'failed'
        ? X
        : item.state === 'moving'
          ? item.direction === 'out'
            ? ArrowUp
            : ArrowDown
          : Clock
  const tried = (work: Promise<unknown>): void => {
    setError(null)
    void work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  return (
    <div className="group px-5 py-2.5">
      <div className="flex items-center gap-3">
        <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-textDim">
          <FileIcon name={item.files[0]?.name ?? ''} size={17} />
          <span
            className={cn(
              'surface-ring absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full',
              item.state === 'done'
                ? 'bg-emerald-400 text-black'
                : item.state === 'failed' || item.state === 'declined'
                  ? 'bg-[#5a5a60] text-white'
                  : item.state === 'waiting'
                    ? 'bg-amber-300 text-black'
                    : 'bg-white text-black',
            )}
          >
            <Badge size={11} strokeWidth={2.75} />
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] text-text">{titleOf(item.files)}</span>
          <span className="block truncate text-[12px] text-textFaint">{shareLine(item, who, progress)}</span>
        </span>
        {item.direction === 'in' && item.state === 'waiting' && item.offer && (
          <button onClick={onAnswer} className="rounded-full bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-black">
            Answer
          </button>
        )}
        {finished && (
          <button
            onClick={onForget}
            aria-label="Remove from the list"
            title="Remove from the list (the file stays where it is)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-textFaint opacity-60 hover:bg-white/[0.06] hover:text-text hover:opacity-100 group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        )}
      </div>
      {item.state === 'moving' && (
        <div className="ml-[52px] mt-2">
          <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]">
            {progress ? (
              <div
                className="h-full rounded-full bg-white transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(2, percentOf(progress))}%` }}
              />
            ) : (
              <div className="share-starting h-full w-1/3 rounded-full bg-white/60" />
            )}
          </div>
          {progress && (
            <div className="mt-1 font-mono text-[11px] tabular-nums text-textFaint">{progressLine(progress, formatBytes)}</div>
          )}
        </div>
      )}
      {saved.length === 1 && <SavedActions file={saved[0]!} onTry={tried} />}
      {saved.length > 1 && (
        <div className="ml-[52px] mt-1.5">
          <div className="flex flex-wrap gap-2">
            {!isAndroid() && saved[0]?.path && (
              <ActionButton icon={FolderOpen} onClick={() => tried(api.receivedShow(saved[0]!.path!))}>
                Show in folder
              </ActionButton>
            )}
            <ActionButton icon={ChevronDown} onClick={() => setOpen((v) => !v)} turned={open}>
              {open ? 'Hide the files' : `The ${saved.length} files`}
            </ActionButton>
          </div>
          {open && (
            <div className="mt-2 rounded-xl border border-white/[0.06] py-1">
              {saved.map((file) => (
                <div key={file.shownAs} className="flex items-center gap-2 px-3 py-1.5 text-textDim">
                  <FileIcon name={file.name} size={14} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{file.name}</span>
                  {!isProgram(file.name) && (
                    <button
                      onClick={() => tried(openSaved(file))}
                      className="rounded-full px-2.5 py-1 text-[12px] text-text hover:bg-white/[0.06] active:bg-white/[0.08]"
                    >
                      Open
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="ml-[52px] mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  )
}

/** Opens a file received here: on a computer as it opens it, on a phone with the app for it. */
function openSaved(file: SavedFile): Promise<unknown> {
  if (isAndroid() && file.uri) return android.openDownload(file.uri)
  if (file.path) return api.receivedOpen(file.path)
  return Promise.reject(new Error('It can’t be opened from here.'))
}

/** Open, and Show in folder on a computer or Share on a phone, for one file received. */
function SavedActions({ file, onTry }: { file: SavedFile; onTry: (work: Promise<unknown>) => void }): React.JSX.Element {
  const program = isProgram(file.name)
  const phone = isAndroid()
  return (
    <div className="ml-[52px] mt-1.5 flex flex-wrap gap-2">
      {!program && (
        <ActionButton icon={ExternalLink} onClick={() => onTry(openSaved(file))}>
          Open
        </ActionButton>
      )}
      {!phone && file.path && (
        <ActionButton icon={FolderOpen} onClick={() => onTry(api.receivedShow(file.path!))}>
          Show in folder
        </ActionButton>
      )}
      {phone && file.uri && (
        <ActionButton icon={Share2} onClick={() => onTry(android.shareDownload(file.uri!))}>
          Share
        </ActionButton>
      )}
    </div>
  )
}

function ActionButton({
  icon: Icon,
  onClick,
  turned,
  children,
}: {
  icon: typeof Check
  onClick: () => void
  turned?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-white/[0.12] px-3 py-1.5 text-[12.5px] text-text transition-colors hover:bg-white/[0.06] active:bg-white/[0.08]"
    >
      <Icon size={13} className={cn('text-textDim transition-transform', turned && 'rotate-180')} />
      {children}
    </button>
  )
}

/**
 * One share sent from here, as it goes: waiting for the other side's
 * answer, accepted and moving (how far, how fast), then arrived, or why
 * not. The Share window stays on it after Send, so nobody wonders whether
 * it went and presses again.
 */
export function ShareStatus({
  item,
  to,
  progress,
  onDone,
  onCancel,
}: {
  item: ShareItem | null
  /** Who it went to, as said here. */
  to: string
  progress: Progress | null
  onDone: () => void
  /** While it waits for an answer: take it back. */
  onCancel?: () => void
}): React.JSX.Element {
  const state = item?.state ?? 'waiting'
  const Icon =
    state === 'done' ? Check : state === 'declined' || state === 'failed' ? X : state === 'moving' ? Upload : Loader2
  return (
    <div className="px-5 pb-1 pt-4">
      <div className="flex flex-col items-center text-center">
        <span
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-full',
            state === 'done'
              ? 'bg-emerald-400/15 text-emerald-300'
              : state === 'declined' || state === 'failed'
                ? 'bg-white/[0.06] text-textDim'
                : 'bg-white/[0.08] text-text',
          )}
        >
          <Icon size={22} className={state === 'waiting' ? 'animate-spin' : undefined} />
        </span>
        <p className="mt-3 text-[15px] font-semibold text-text">
          {state === 'waiting'
            ? `Waiting for ${to} to accept`
            : state === 'moving'
              ? progress
                ? `Sending to ${to}`
                : `Accepted: starting`
              : state === 'done'
                ? `Arrived on ${item?.takenOn ?? to}`
                : state === 'declined'
                  ? `${to} declined it`
                  : 'It didn’t arrive'}
        </p>
        <p className="mt-1 text-[12.5px] leading-snug text-textFaint">
          {state === 'waiting'
            ? (item?.reason ?? 'They see it now, and answer Accept or Decline.')
            : state === 'failed'
              ? (item?.reason ?? 'Try again.')
              : state === 'moving'
                ? 'It carries on if you close this.'
                : ''}
        </p>
      </div>
      {state === 'moving' && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            {progress ? (
              <div
                className="h-full rounded-full bg-white transition-[width] duration-500 ease-out"
                style={{ width: `${Math.max(2, percentOf(progress))}%` }}
              />
            ) : (
              <div className="share-starting h-full w-1/3 rounded-full bg-white/60" />
            )}
          </div>
          {progress && (
            <div className="mt-1.5 text-center font-mono text-[11px] tabular-nums text-textFaint">
              {progressLine(progress, formatBytes)}
            </div>
          )}
        </div>
      )}
      <div className="mt-5 flex gap-2.5">
        {state === 'waiting' && onCancel && (
          <button onClick={onCancel} className="flex-1 rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text">
            Take it back
          </button>
        )}
        <button
          onClick={onDone}
          className={cn(
            'flex-1 rounded-full py-2.5 text-[13.5px] font-semibold',
            state === 'done' || state === 'declined' || state === 'failed' ? 'bg-white text-black' : 'border border-white/[0.12] text-text',
          )}
        >
          {state === 'done' || state === 'declined' || state === 'failed' ? 'Done' : 'Close'}
        </button>
      </div>
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
          <span className="surface-ring absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full bg-emerald-400" />
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
  nearby,
  direction,
  onAnswer,
}: {
  inbox: Inbox
  presence: Presence
  /** Shares with devices nearby, listed with the home's. */
  nearby?: Nearby
  direction: 'in' | 'out'
  /** Opens the prompt for one waiting. */
  onAnswer: (item: ShareItem) => void
}): React.JSX.Element {
  const myProfile = presence.devices.find((d) => d.device === presence.you)?.profile
  const fromNearby = new Set(nearby?.items ?? [])
  const mine = [...inbox.items, ...(nearby?.items ?? [])].filter((i) => i.direction === direction).sort((a, b) => b.at - a.at)
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
  const rowOf = (item: ShareItem): React.JSX.Element => (
    <ShareRow
      key={`${item.direction}-${item.id}`}
      item={item}
      who={fromNearby.has(item) ? item.peer.name : calledOf(item.peer, myProfile)}
      progress={fromNearby.has(item) ? (nearby?.progressOf(item) ?? null) : inbox.progressOf(item)}
      onAnswer={() => onAnswer(item)}
      onForget={() => (fromNearby.has(item) ? nearby?.forget(item) : inbox.forget(item))}
    />
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
