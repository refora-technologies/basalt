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
  /** From a device nearby, by a code: answered on the line it came by, not the host's. */
  nearby?: boolean
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

export const KIND = {
  offer: 'share.offer',
  answer: 'share.answer',
  handoff: 'share.handoff',
} as const

/** How long an offer is worth answering, in ms. */
export const OFFER_TTL_MS = 10 * 60_000

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
  /** Why it failed, or was declined. */
  reason?: string
  /** The offer itself, kept while it waits for an answer here. */
  offer?: OfferBody
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
      return { ...item, state, takenOn, reason: body.reason ?? item.reason }
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
