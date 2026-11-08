import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, onChannel, onShareSending, type ChannelMessage, type HeldShare, type PresentDevice } from './api'
import type { Presence } from './usePresence'
import type { Transfers } from './useTransfers'
import {
  KIND,
  OFFER_TTL_MS,
  apply,
  kept,
  newOfferId,
  partyOf,
  progressIn,
  received,
  takesWithoutAsking,
  type AnswerBody,
  type HandoffBody,
  type OfferBody,
  type Party,
  type Progress,
  type ProgressBody,
  type SavedFile,
  type ShareFile,
  type ShareItem,
} from './share'

export interface Inbox {
  items: ShareItem[]
  /** Offers waiting for this person's answer: what the badge counts. */
  waiting: ShareItem[]
  /** Sends files on the drive to one device. Throws when it can't be reached. */
  send: (files: ShareFile[], to: PresentDevice) => Promise<string>
  /** Keeps files on the drive on the host for a device that's away; `keep` past its answer. */
  sendThroughHost: (files: ShareFile[], to: PresentDevice, keep: boolean) => Promise<string>
  /** "Share again": a copy of what the host keeps, for another device. */
  shareAgain: (share: HeldShare, to: PresentDevice) => Promise<void>
  /** "Remove from the host once answered": the default for each send through it. */
  removeOnAnswer: boolean
  setRemoveOnAnswer: (on: boolean) => void
  accept: (item: ShareItem) => void
  decline: (item: ShareItem) => void
  /** "Accept on another device": that one of mine takes it instead. */
  acceptOn: (item: ShareItem, device: PresentDevice) => Promise<void>
  /** Forgets one from the list; nothing else changes. */
  forget: (item: ShareItem) => void
  acceptFromHome: boolean
  setAcceptFromHome: (on: boolean) => void
  /** The folder received files go to; empty for the usual one. */
  folder: string
  setFolder: (folder: string) => void
  /** How far one moving has come: here from its transfers, for one sent from what the other side says. */
  progressOf: (item: ShareItem) => Progress | null
}

/**
 * The Inbox: shares coming in and going out, kept on this device per host
 * and profile. Messages that came while the page wasn't there wait in the
 * app (`channelTake`) and are taken as it starts.
 */
export function useInbox(
  who: string | null,
  presence: Presence,
  transfers: Transfers,
  /** The profile this device is signed in to: known before the device list is. */
  profile?: string,
): Inbox {
  const key = who ? `basalt.inbox.${who}` : null
  const [items, setItems] = useState<ShareItem[]>(() => load(key))
  const [acceptFromHome, setAcceptFromHomeState] = useState(() => localStorage.getItem(ACCEPT_KEY) === '1')
  const [folder, setFolderState] = useState(() => localStorage.getItem(FOLDER_KEY) ?? '')
  const [removeOnAnswer, setRemoveOnAnswerState] = useState(() => localStorage.getItem(REMOVE_KEY) !== '0')
  const seen = useRef(new Set<string>())
  // The list as last drawn: whether an offer is new is asked of it at once,
  // not inside a state update, which React runs later.
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    setItems(load(key))
    seen.current = new Set()
  }, [key])
  useEffect(() => {
    if (key) save(key, items)
  }, [key, items])

  const presenceRef = useRef(presence)
  presenceRef.current = presence
  const settings = useRef({ acceptFromHome, folder })
  settings.current = { acceptFromHome, folder }
  const transfersRef = useRef(transfers)
  transfersRef.current = transfers
  const profileRef = useRef(profile)
  profileRef.current = profile

  // How far shares sent from here have come: told by the device taking
  // them, or, going up to the host first, by this app.
  const [sentProgress, setSentProgress] = useState<Map<string, Progress>>(() => new Map())
  useEffect(() => {
    let gone = false
    let stop: (() => void) | null = null
    void onShareSending((s) =>
      setSentProgress((map) => new Map(map).set(s.offer, { done: s.done, total: s.total, rate: 0, up: true, at: Date.now() })),
    ).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [])

  // How far each share coming here has come, from its files' transfers.
  const moving = transfers.transfers
  const progressOf = useCallback(
    (item: ShareItem): Progress | null => {
      if (item.state !== 'moving') return null
      if (item.direction === 'in') return progressIn(item, moving, Date.now())
      return sentProgress.get(item.id) ?? null
    },
    [moving, sentProgress],
  )

  // Told back to the device that sent it, about once a second, so its Sent
  // shows how far it has come too.
  const toldAt = useRef(new Map<string, number>())
  useEffect(() => {
    const now = Date.now()
    for (const item of itemsRef.current) {
      if (item.direction !== 'in' || item.state !== 'moving' || !item.offer) continue
      if (now - (toldAt.current.get(item.id) ?? 0) < PROGRESS_EVERY_MS) continue
      const p = progressIn(item, moving, now)
      if (!p) continue
      toldAt.current.set(item.id, now)
      const body: ProgressBody = { offer: item.id, done: p.done, total: p.total, rate: p.rate }
      void api.channelSend({ to: 'device', device: item.offer.from.device }, KIND.progress, body, 0).catch(() => {})
    }
  }, [moving])

  const me = (): Party | null => {
    const p = presenceRef.current
    const mine = p.devices.find((d) => d.device === p.you)
    return mine ? partyOf(mine) : null
  }

  const update = useCallback((id: string, change: (item: ShareItem) => ShareItem) => {
    setItems((list) => list.map((item) => (item.id === id ? change(item) : item)))
  }, [])

  const answer = useCallback(async (offer: OfferBody, reply: AnswerBody['answer'], reason?: string, unreachable?: boolean) => {
    const by = me()
    if (!by) return
    const body: AnswerBody = { offer: offer.offer, answer: reply, by, reason, ...(unreachable ? { unreachable } : {}) }
    await api.channelSend({ to: 'device', device: offer.from.device }, KIND.answer, body, OFFER_TTL_MS).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Takes every file of an offer from the drive, one after another. */
  const take = useCallback(
    async (item: ShareItem) => {
      const offer = item.offer
      if (!offer) return
      update(item.id, (i) => ({ ...i, state: 'moving' }))
      void answer(offer, 'accepted')
      let last = ''
      const saved: SavedFile[] = []
      try {
        for (const [n, file] of offer.files.entries()) {
          const id = `share-${offer.offer}-${n}`
          transfersRef.current.start({ id, kind: 'download', name: file.name, path: file.path || file.name, total: file.size })
          try {
            const folder = settings.current.folder || undefined
            // On the sending device: straight from it. On the drive: from the host.
            const landed = offer.held
              ? await api.receiveHeld(offer.offer, n, file.name, file.size, id, folder)
              : offer.direct
                ? await api.receiveDirect(offer.direct.endpoint, offer.offer, offer.direct.token, n, file.name, id, folder)
                : await api.receiveFile(file.path, id, folder)
            transfersRef.current.finish(id)
            last = landed.shownAs
            saved.push({ name: file.name, shownAs: landed.shownAs, path: landed.path, uri: landed.uri })
          } catch (e) {
            transfersRef.current.finish(id, e)
            throw e
          }
        }
        update(item.id, (i) => ({ ...i, state: 'done', savedAs: last, saved, offer: undefined }))
        void answer(offer, 'done')
        // Kept on the host for this device: told it arrived, so it can go.
        if (offer.held) void api.shareAnswer(offer.offer, true).catch(() => {})
      } catch (e) {
        const reason = plainReason(e instanceof Error ? e.message : String(e))
        // Straight across failed to reach it, on the same host: the sender
        // is asked to send it through the host instead, and it comes again.
        const through = !!offer.direct && reason === UNREACHABLE
        update(item.id, (i) => ({
          ...i,
          state: through ? 'moving' : 'failed',
          reason: through ? 'Couldn’t reach it directly: coming through the host' : reason,
        }))
        void answer(offer, 'failed', reason, through)
      }
    },
    [answer, update],
  )

  const hear = useCallback(
    (message: ChannelMessage) => {
      if (seen.current.has(message.id)) return
      seen.current.add(message.id)
      if (message.kind === KIND.offer || message.kind === KIND.handoff) {
        const body = message.kind === KIND.offer ? (message.body as OfferBody) : (message.body as HandoffBody).offer
        if (!body?.offer || !Array.isArray(body.files)) return
        const item = received(body, Date.now())
        const before = itemsRef.current.find((i) => i.id === item.id && i.direction === 'in')
        // Coming again through the host, after it couldn't come straight
        // across: taken at once, as the first was.
        if (before && body.held && before.state === 'moving' && before.offer?.direct) {
          const again = { ...item, at: before.at }
          itemsRef.current = kept([again, ...itemsRef.current.filter((i) => i !== before)])
          setItems((list) => kept([again, ...list.filter((i) => !(i.id === item.id && i.direction === 'in'))]))
          void take(again)
          return
        }
        if (before) return
        itemsRef.current = kept([item, ...itemsRef.current])
        setItems((list) => (list.some((i) => i.id === item.id && i.direction === 'in') ? list : kept([item, ...list])))
        // Asked by one of my own devices to take it here, or a send this
        // person said needs no asking: taken at once.
        const myProfile = profileRef.current
        const handoff = message.kind === KIND.handoff
        if (handoff || takesWithoutAsking(body, myProfile, settings.current.acceptFromHome)) void take(item)
        return
      }
      if (message.kind === KIND.progress) {
        const said = message.body as ProgressBody
        if (!said?.offer) return
        // Only for a share sent from here, and it can only come forward.
        const sent = itemsRef.current.find((i) => i.id === said.offer && i.direction === 'out')
        if (!sent) return
        setSentProgress((map) => new Map(map).set(said.offer, { done: said.done, total: said.total, rate: said.rate, at: Date.now() }))
        if (sent.state === 'waiting') update(sent.id, (i) => (i.direction === 'out' ? { ...i, state: 'moving' } : i))
        return
      }
      if (message.kind === KIND.answer) {
        const said = message.body as AnswerBody
        // It couldn't reach this device: the same files, through the host,
        // under the same offer, for the same device.
        const sent = itemsRef.current.find((i) => i.id === said.offer && i.direction === 'out')
        if (said.unreachable && sent && sent.files.every((f) => f.source)) {
          setItems((list) =>
            list.map((i) => (i === sent ? { ...i, state: 'moving', reason: 'Couldn’t reach it directly: going through the host' } : i)),
          )
          void api
            .shareHoldLocal(
              sent.id,
              sent.peer.device,
              false,
              sent.files.map((f) => ({ source: f.source!, name: f.name, size: f.size })),
            )
            .catch((e: unknown) =>
              setItems((list) =>
                list.map((i) => (i.id === sent.id && i.direction === 'out' ? { ...i, state: 'failed', reason: e instanceof Error ? e.message : String(e) } : i)),
              ),
            )
          return
        }
        setItems((list) => apply(list, message))
      }
    },
    [take],
  )

  // What came while there was no page, then each as it comes.
  useEffect(() => {
    if (!who) return undefined
    let stop: (() => void) | null = null
    let gone = false
    void api
      .channelTake()
      .then((waiting) => waiting.forEach(hear))
      .catch(() => {})
    void onChannel(hear).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [who, hear])

  const send = useCallback(async (files: ShareFile[], to: PresentDevice): Promise<string> => {
    const from = me()
    if (!from) throw new Error('Not connected to the host.')
    const offer = newOfferId()
    // Files on this device go straight across: offered from here first, and
    // the receiver told where to take them. Their sources stay here.
    const local = files.filter((f) => f.source)
    const direct = local.length > 0 ? await api.shareLocal(offer, files.map((f) => f.source ?? '')) : undefined
    const told = files.map(({ source: _, ...rest }) => rest)
    const body: OfferBody = { offer, files: told, from, to: partyOf(to), direct }
    const sent = await api.channelSend({ to: 'device', device: to.device }, KIND.offer, body, 0)
    if (sent.delivered.length === 0) {
      if (direct) void api.withdrawLocal(offer).catch(() => {})
      throw new Error(`${to.name} isn’t online.`)
    }
    setItems((list) =>
      kept([{ id: body.offer, direction: 'out', files: told, peer: body.to, state: 'waiting', at: Date.now() }, ...list]),
    )
    return offer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendThroughHost = useCallback(async (files: ShareFile[], to: PresentDevice, keep: boolean): Promise<string> => {
    const offer = newOfferId()
    if (files.every((f) => f.source)) {
      // On this device: up to the host first, then kept there.
      await api.shareHoldLocal(
        offer,
        to.device,
        keep,
        files.map((f) => ({ source: f.source!, name: f.name, size: f.size })),
      )
    } else if (files.every((f) => !f.source)) {
      await api.shareHold(
        offer,
        to.device,
        keep,
        files.map((f) => f.path),
      )
    } else {
      throw new Error('Send files from the drive and from this device apart.')
    }
    setItems((list) =>
      kept([{ id: offer, direction: 'out', files, peer: partyOf(to), state: 'waiting', at: Date.now(), reason: 'On the host until it’s back' }, ...list]),
    )
    return offer
  }, [])

  const shareAgain = useCallback(
    async (share: HeldShare, to: PresentDevice) => {
      const offer = newOfferId()
      await api.shareManage('again', share.id, '', { to: to.device, id: offer, keep: !removeOnAnswer })
      const files: ShareFile[] = share.files.map((f) => ({ name: f.name, size: f.size, path: '' }))
      setItems((list) =>
        kept([{ id: offer, direction: 'out', files, peer: partyOf(to), state: 'waiting', at: Date.now(), reason: 'On the host until it’s taken' }, ...list]),
      )
    },
    [removeOnAnswer],
  )

  const accept = useCallback((item: ShareItem) => void take(item), [take])

  const decline = useCallback(
    (item: ShareItem) => {
      if (item.offer) void answer(item.offer, 'declined')
      if (item.offer?.held) void api.shareAnswer(item.offer.offer, false).catch(() => {})
      update(item.id, (i) => ({ ...i, state: 'declined', offer: undefined }))
    },
    [answer, update],
  )

  const acceptOn = useCallback(
    async (item: ShareItem, device: PresentDevice) => {
      if (!item.offer) return
      const body: HandoffBody = { offer: item.offer }
      const sent = await api.channelSend({ to: 'device', device: device.device }, KIND.handoff, body, 0)
      if (sent.delivered.length === 0) throw new Error(`${device.name} isn’t online.`)
      update(item.id, (i) => ({ ...i, state: 'done', takenOn: device.name, offer: undefined }))
    },
    [update],
  )

  const forget = useCallback((item: ShareItem) => {
    setItems((list) => list.filter((i) => i !== item))
  }, [])

  const setAcceptFromHome = useCallback((on: boolean) => {
    setAcceptFromHomeState(on)
    localStorage.setItem(ACCEPT_KEY, on ? '1' : '0')
  }, [])
  const setRemoveOnAnswer = useCallback((on: boolean) => {
    setRemoveOnAnswerState(on)
    localStorage.setItem(REMOVE_KEY, on ? '1' : '0')
  }, [])
  const setFolder = useCallback((next: string) => {
    setFolderState(next)
    localStorage.setItem(FOLDER_KEY, next)
  }, [])

  const waiting = useMemo(() => items.filter((i) => i.direction === 'in' && i.state === 'waiting' && i.offer), [items])

  return {
    items,
    waiting,
    send,
    sendThroughHost,
    shareAgain,
    removeOnAnswer,
    setRemoveOnAnswer,
    accept,
    decline,
    acceptOn,
    forget,
    acceptFromHome,
    setAcceptFromHome,
    folder,
    setFolder,
    progressOf,
  }
}

/** How often a device taking a share tells the sender how far it has come. */
const PROGRESS_EVERY_MS = 1_000

const ACCEPT_KEY = 'basalt.share.acceptFromHome'
const FOLDER_KEY = 'basalt.share.folder'
const REMOVE_KEY = 'basalt.share.removeOnAnswer'

function load(key: string | null): ShareItem[] {
  if (!key) return []
  try {
    const kept = JSON.parse(localStorage.getItem(key) ?? '[]') as ShareItem[]
    // A share that was moving when the app closed did not finish.
    return Array.isArray(kept)
      ? kept.map((i) => (i.state === 'moving' && i.direction === 'in' ? { ...i, state: 'failed', reason: 'Stopped before it finished.' } : i))
      : []
  } catch {
    return []
  }
}

function save(key: string, items: ShareItem[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(kept(items)))
  } catch {
    // Not kept: the Inbox starts empty next time.
  }
}

/** Why a share didn't arrive, as a person would say it rather than as the code does. */
/** Why straight across failed, when it was the network between them. */
const UNREACHABLE = 'The two devices couldn’t reach each other on this Wi-Fi.'

export function plainReason(raw: string): string {
  const said = raw.replace(/^protocol:\s*/i, '').replace(/^the device that sent it said:\s*/i, '')
  if (/FileNotFound|No item at|no such file|not found/i.test(said)) return 'It’s no longer on the device that sent it.'
  if (/couldn.t reach|didn.t answer|timed out|refused/i.test(said)) return 'The two devices couldn’t reach each other on this Wi-Fi.'
  if (/that isn.t offered/i.test(said)) return 'The device that sent it took it back.'
  if (/cancelled/i.test(said)) return 'Cancelled.'
  if (/stopped part-way/i.test(said)) return 'It stopped part-way.'
  return said.charAt(0).toUpperCase() + said.slice(1)
}
