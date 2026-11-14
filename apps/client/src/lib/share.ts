import type { ChannelMessage, PresentDevice } from './api'

/**
 * Sharing files between the host's devices: what the messages say, and the
 * rules. Pure, so every rule is tested; `useInbox` does the talking.
 *
 * A share goes to one device (the receiver may take it on another of theirs).
 * A file on the drive travels no further than the host: the device that
 * accepts downloads it from there into its received folder.
 */

/** One file in a share. */
export interface ShareFile {
  name: string
  size: number
  /** Where it is on the drive; empty for a file on the sending device. */
  path: string
  /**
   * A file on the sending device itself (a path, or a phone's content URI),
   * sent straight across rather than from the drive. Only the sender knows it.
   */
  source?: string
}

/** Where to take an offer's files from when they are on the sending device. */
export interface Direct {
  endpoint: { addresses: string[]; port: number; key: string }
  token: string
}

/** Who a share is from or for. */
export interface Party {
  device: string
  name: string
  form?: PresentDevice['form']
  profile?: string
  profileName?: string
}

/** `share.offer`: sent to the device chosen. */
export interface OfferBody {
  offer: string
  files: ShareFile[]
  from: Party
  to: Party
  /** Files on the sending device: taken straight from it. */
  direct?: Direct
  /** Kept on the host for this device while it was away: taken from there. */
  held?: boolean
}

/** `share.answer`: back to whoever sent the offer. */
export interface AnswerBody {
  offer: string
  answer: 'accepted' | 'declined' | 'done' | 'failed' | 'removed'
  /** The device that answered, which is not always the one asked. */
  by: Party
  reason?: string
  /**
   * It couldn't reach the sending device (a computer's firewall, Wi-Fi that
   * keeps devices apart): the sender sends it through the host instead.
   */
  unreachable?: boolean
}

/** `share.handoff`: "take this one here", to another of the receiver's devices. */
export interface HandoffBody {
  offer: OfferBody
}

/** `share.progress`: how far it has come, from the device taking it to the one that sent it, about once a second. */
export interface ProgressBody {
  offer: string
  done: number
  total: number
  /** Bytes a second now. */
  rate: number
}

export const KIND = {
  offer: 'share.offer',
  answer: 'share.answer',
  handoff: 'share.handoff',
  progress: 'share.progress',
} as const

/** How far a share has come, as the Inbox shows it. */
export interface Progress {
  done: number
  total: number
  /** Bytes a second now; 0 when not known. */
  rate: number
  /** Going up to the host first (a file on this device, for one away). */
  up?: boolean
  /** When this was last heard, Unix ms. */
  at: number
}

/** "45% · 12.3 MB of 88.7 MB · 4.2 MB/s · 20 s left". */
export function progressLine(p: Progress, format: (bytes: number) => string): string {
  const parts = [`${percentOf(p)}%`, `${format(p.done)} of ${format(p.total)}`]
  if (p.rate > 0) {
    parts.push(`${format(p.rate)}/s`)
    const left = (p.total - p.done) / p.rate
    if (left >= 1) parts.push(`${timeLeft(left)} left`)
  }
  return parts.join(' · ')
}

export function percentOf(p: Progress): number {
  return p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : 0
}

/** "20 s", "4 min", "1 h 5 min". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** A transfer of one of a share's files, as the transfer list has it. */
export interface FileMoving {
  id: string
  transferred: number
  status: 'active' | 'done' | 'failed' | 'cancelled'
  rate: number
}

/**
 * How far a share coming here has come, from its files' transfers (named
 * `share-<offer>-<n>`). Null when none has started.
 */
export function progressIn(item: ShareItem, transfers: FileMoving[], now: number): Progress | null {
  let done = 0
  let rate = 0
  let started = false
  item.files.forEach((file, n) => {
    const t = transfers.find((x) => x.id === `share-${item.id}-${n}`)
    if (!t) return
    started = true
    if (t.status === 'done') done += file.size
    else {
      done += Math.min(file.size, t.transferred)
      if (t.status === 'active') rate += t.rate
    }
  })
  if (!started) return null
  return { done, total: totalOf(item.files), rate, at: now }
}

/** How long an offer is worth answering, in ms. */
export const OFFER_TTL_MS = 10 * 60_000

/**
 * The shares waiting past OFFER_TTL_MS at `now`: an offer straight across
 * that nobody answered, sent from here or to here. One kept on the host
 * (sent through it, or held for this device) waits as the host says.
 */
export function unanswered(items: ShareItem[], now: number): ShareItem[] {
  return items.filter(
    (i) =>
      (i.state === 'waiting' &&
        now - i.at > OFFER_TTL_MS &&
        (i.direction === 'out' ? !i.reason : !!i.offer && !i.offer.held)) ||
      (i.direction === 'in' && i.state === 'moving' && i.reason === COMING_THROUGH_HOST && now - (i.since ?? i.at) > THROUGH_HOST_TTL_MS),
  )
}

/** Said on a share received here that couldn't come straight across, while it comes through the host. */
export const COMING_THROUGH_HOST = 'Couldn’t reach it directly: coming through the host'

/**
 * Said out loud, on whichever screen is open, when a share switches to the
 * host: the line on its row alone went unseen, and the sender looked as if
 * nothing had happened while the other device showed nothing coming.
 */
export function throughHostSaid(direction: 'in' | 'out', peer: string): string {
  return direction === 'out'
    ? `Couldn’t reach ${peer} directly: sending it through your host instead`
    : `Couldn’t reach ${peer} directly: it’s coming through your host instead`
}

/**
 * How long a share received here waits to come through the host, from when
 * it couldn't come straight across: the sender sends it up to the host first,
 * which for a big file over Wi-Fi takes a while. A sender that never does (one
 * from before this worked, or gone) leaves it waiting otherwise, at 0%, until
 * the app starts again.
 */
export const THROUGH_HOST_TTL_MS = 30 * 60_000

/** What an unanswered share says once it has ended. */
export function endedUnanswered(item: ShareItem): ShareItem {
  return {
    ...item,
    state: 'failed',
    offer: undefined,
    reason:
      item.state === 'moving'
        ? 'It didn’t come through the host: ask them to send it again.'
        : item.direction === 'out'
          ? 'No answer in 10 minutes.'
          : 'Not answered in 10 minutes: ask them to send it again.',
  }
}

export type ShareState =
  /** Asked, no answer yet. */
  | 'waiting'
  /** Accepted, the bytes on their way. */
  | 'moving'
  | 'done'
  | 'declined'
  | 'failed'

/** One share, as the Inbox lists it. */
export interface ShareItem {
  id: string
  direction: 'in' | 'out'
  files: ShareFile[]
  /** The other side: who sent it, or who it was for. */
  peer: Party
  state: ShareState
  /** When it started, Unix ms. */
  at: number
  /** The device that took it, when it was not the one asked. */
  takenOn?: string
  /** Where it landed, for one received. */
  savedAs?: string
  /** Each file as it landed here: to open, show in its folder, or share on. */
  saved?: SavedFile[]
  /** Why it failed, or was declined; or, while moving, what is happening. */
  reason?: string
  /** When it began coming through the host instead, Unix ms. */
  since?: number
  /** The offer itself, kept while it waits for an answer here. */
  offer?: OfferBody
}

/**
 * The files as they go in an offer: where each is on this device stays here
 * (only the sender knows it, and it is nobody else's business).
 */
export function toldOf(files: ShareFile[]): ShareFile[] {
  return files.map(({ source: _, ...rest }) => rest)
}

/**
 * A share sent from here, as this device keeps it: its files with where they
 * are here, so that if the receiver can't reach this device straight across,
 * the same files can go through the host. Kept without them (as in the
 * offer), every share sent straight across that couldn't reach the receiver
 * just failed: the Sony on 2026-11-12, behind a sender it couldn't reach.
 */
export function sentItem(offer: OfferBody, files: ShareFile[], at: number): ShareItem {
  return { id: offer.offer, direction: 'out', files, peer: offer.to, state: 'waiting', at }
}

/** The files of a share sent from here that can go through the host instead: all on this device. */
export function throughHostFiles(sent: ShareItem): { source: string; name: string; size: number }[] | null {
  if (sent.direction !== 'out' || sent.files.length === 0) return null
  if (!sent.files.every((f) => f.source)) return null
  return sent.files.map((f) => ({ source: f.source!, name: f.name, size: f.size }))
}

/** A file received here, and where it is. */
export interface SavedFile {
  name: string
  /** Where somebody would look for it: a folder and a name. */
  shownAs: string
  /** On a computer, the file itself. */
  path?: string
  /** On a phone, Android's address for it. */
  uri?: string
}

export function totalOf(files: ShareFile[]): number {
  return files.reduce((sum, f) => sum + Math.max(0, f.size), 0)
}

/** "Holiday 2026.mkv", or "Trip photos and 22 more". */
export function titleOf(files: ShareFile[]): string {
  if (files.length === 0) return 'Nothing'
  if (files.length === 1) return files[0]!.name
  return `${files[0]!.name} and ${files.length - 1} more`
}

/** Files a device should never open by itself: programs and scripts. */
const PROGRAM = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|apk|aab|sh|app|dmg|deb|rpm|appimage)$/i

export function isProgram(name: string): boolean {
  return PROGRAM.test(name.trim())
}

/**
 * Whether an offer is taken without asking: from one of this person's own
 * devices, always; from another profile of this home, when they said so.
 * Anything else asks.
 */
export function takesWithoutAsking(offer: OfferBody, myProfile: string | undefined, acceptFromHome: boolean): boolean {
  const mine = myProfile !== undefined && offer.from.profile === myProfile
  return mine || acceptFromHome
}

/**
 * Where a share can go: this person's other devices, and the rest of the
 * home by profile. Never this device, and never a TV, which doesn't take
 * files.
 */
export interface Targets {
  mine: PresentDevice[]
  home: { profile: string; name: string; color?: number; devices: PresentDevice[] }[]
  /** Devices signed in to no profile. */
  loose: PresentDevice[]
}

export function targetsOf(devices: PresentDevice[], you: string): Targets {
  const me = devices.find((d) => d.device === you)
  const takes = devices.filter((d) => d.device !== you && d.form !== 'tv')
  const order = (a: PresentDevice, b: PresentDevice): number =>
    Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
  const mine = me?.profile ? takes.filter((d) => d.profile === me.profile).sort(order) : []
  const groups = new Map<string, Targets['home'][number]>()
  for (const d of takes) {
    if (!d.profile || d.profile === me?.profile) continue
    const group = groups.get(d.profile) ?? { profile: d.profile, name: d.profileName ?? 'Someone', color: d.profileColor, devices: [] }
    group.devices.push(d)
    groups.set(d.profile, group)
  }
  const home = [...groups.values()]
    .map((g) => ({ ...g, devices: g.devices.sort(order) }))
    .sort((a, b) => Number(b.devices.some((d) => d.online)) - Number(a.devices.some((d) => d.online)) || a.name.localeCompare(b.name))
  const loose = takes.filter((d) => !d.profile).sort(order)
  return { mine, home, loose }
}

/**
 * The list as it was, brought up to date without moving anything: each row
 * keeps its place and takes the device's news (online, name); a device new to
 * the list joins the end of its part; one gone from it keeps its row as it was
 * last seen. The share sheet shows this while it is open: rebuilt each time
 * "who is online" came back, a device going on or off line jumped rows and a
 * refresh that came back empty for a moment dropped whole parts, so a tap
 * landed on the row that had moved under the finger.
 */
export function steadyTargets(before: Targets | null, now: Targets): Targets {
  if (!before) return now
  const shown = (t: Targets): PresentDevice[] => [...t.mine, ...t.home.flatMap((g) => g.devices), ...t.loose]
  const fresh = new Map(shown(now).map((d) => [d.device, d]))
  const had = new Set(shown(before).map((d) => d.device))
  const keep = (old: PresentDevice[], joining: PresentDevice[]): PresentDevice[] => [
    ...old.map((d) => fresh.get(d.device) ?? d),
    ...joining.filter((d) => !had.has(d.device)),
  ]
  const groups = new Map(now.home.map((g) => [g.profile, g]))
  const home = before.home.map((g) => {
    const latest = groups.get(g.profile)
    return { ...g, ...(latest ? { name: latest.name, color: latest.color } : {}), devices: keep(g.devices, latest?.devices ?? []) }
  })
  const kept = new Set(before.home.map((g) => g.profile))
  for (const g of now.home) {
    if (kept.has(g.profile)) continue
    const devices = g.devices.filter((d) => !had.has(d.device))
    if (devices.length > 0) home.push({ ...g, devices })
  }
  return { mine: keep(before.mine, now.mine), home, loose: keep(before.loose, now.loose) }
}

/** A device as a party to a share. */
export function partyOf(device: PresentDevice): Party {
  return {
    device: device.device,
    name: device.name,
    form: device.form,
    profile: device.profile,
    profileName: device.profileName,
  }
}

/** "Sam's phone", "your laptop": how a device is called in a line about a share. */
export function calledOf(party: Party, myProfile: string | undefined): string {
  const thing = party.form === 'phone' ? 'phone' : party.form === 'tablet' ? 'tablet' : party.form === 'computer' ? 'computer' : null
  if (party.profile && party.profile === myProfile) return thing ? `your ${thing}` : party.name
  if (party.profileName && thing) return `${party.profileName}’s ${thing}`
  return party.name
}

/**
 * What a message from another device does to the Inbox: the items it
 * changes, as they are now. Messages it has nothing to do with change
 * nothing.
 */
export function apply(items: ShareItem[], message: ChannelMessage): ShareItem[] {
  if (message.kind === KIND.answer) {
    const body = message.body as AnswerBody
    return items.map((item) => {
      if (item.id !== body.offer || item.direction !== 'out') return item
      const state: ShareState =
        body.answer === 'accepted' ? 'moving' : body.answer === 'done' ? 'done' : body.answer === 'declined' ? 'declined' : 'failed'
      // An answer never takes a share backwards: a late "accepted" after "done" stays done.
      if (rank(state) < rank(item.state)) return item
      // The host removed it before it was taken ("Clear share files"): no device took it.
      const takenOn = body.answer === 'removed' ? item.takenOn : body.by.device !== item.peer.device ? body.by.name : item.takenOn
      // An answer always moves it on, so why it waited ("On the host until
      // it's back") goes: only the answer's own reason stays.
      return { ...item, state, takenOn, reason: body.reason }
    })
  }
  return items
}

function rank(state: ShareState): number {
  return { waiting: 0, moving: 1, done: 2, declined: 2, failed: 2 }[state]
}

/** An offer that came in, as an Inbox item. */
export function received(body: OfferBody, at: number): ShareItem {
  return { id: body.offer, direction: 'in', files: body.files, peer: body.from, state: 'waiting', at, offer: body }
}

/** Newest first, and only so many kept. */
export function kept(items: ShareItem[], most = 200): ShareItem[] {
  return [...items].sort((a, b) => b.at - a.at).slice(0, most)
}

/** A short random id for an offer. */
export function newOfferId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
