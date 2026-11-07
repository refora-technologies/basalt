import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, onChannel, type ChannelMessage, type PresentDevice } from './api'
import type { Presence } from './usePresence'
import type { Transfers } from './useTransfers'
import {
  KIND,
  OFFER_TTL_MS,
  apply,
  kept,
  newOfferId,
  partyOf,
  received,
  takesWithoutAsking,
  type AnswerBody,
  type HandoffBody,
  type OfferBody,
  type Party,
  type ShareFile,
  type ShareItem,
} from './share'

export interface Inbox {
  items: ShareItem[]
  /** Offers waiting for this person's answer: what the badge counts. */
  waiting: ShareItem[]
  /** Sends files on the drive to one device. Throws when it can't be reached. */
  send: (files: ShareFile[], to: PresentDevice) => Promise<void>
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
  const seen = useRef(new Set<string>())

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

  const me = (): Party | null => {
    const p = presenceRef.current
    const mine = p.devices.find((d) => d.device === p.you)
    return mine ? partyOf(mine) : null
  }

  const update = useCallback((id: string, change: (item: ShareItem) => ShareItem) => {
    setItems((list) => list.map((item) => (item.id === id ? change(item) : item)))
  }, [])

  const answer = useCallback(async (offer: OfferBody, reply: AnswerBody['answer'], reason?: string) => {
    const by = me()
    if (!by) return
    const body: AnswerBody = { offer: offer.offer, answer: reply, by, reason }
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
      try {
        for (const [n, file] of offer.files.entries()) {
          const id = `share-${offer.offer}-${n}`
          transfersRef.current.start({ id, kind: 'download', name: file.name, path: file.path, total: file.size })
          try {
            const saved = await api.receiveFile(file.path, id, settings.current.folder || undefined)
            transfersRef.current.finish(id)
            last = saved.shownAs
          } catch (e) {
            transfersRef.current.finish(id, e)
            throw e
          }
        }
        update(item.id, (i) => ({ ...i, state: 'done', savedAs: last, offer: undefined }))
        void answer(offer, 'done')
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        update(item.id, (i) => ({ ...i, state: 'failed', reason }))
        void answer(offer, 'failed', reason)
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
        let fresh = false
        setItems((list) => {
          if (list.some((i) => i.id === item.id && i.direction === 'in')) return list
          fresh = true
          return kept([item, ...list])
        })
        // Asked by one of my own devices to take it here, or a send this
        // person said needs no asking: taken at once.
        const myProfile = profileRef.current
        const handoff = message.kind === KIND.handoff
        if (handoff || takesWithoutAsking(body, myProfile, settings.current.acceptFromHome)) {
          queueMicrotask(() => {
            if (fresh) void take(item)
          })
        }
        return
      }
      if (message.kind === KIND.answer) setItems((list) => apply(list, message))
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

  const send = useCallback(async (files: ShareFile[], to: PresentDevice) => {
    const from = me()
    if (!from) throw new Error('Not connected to the host.')
    const body: OfferBody = { offer: newOfferId(), files, from, to: partyOf(to) }
    const sent = await api.channelSend({ to: 'device', device: to.device }, KIND.offer, body, 0)
    if (sent.delivered.length === 0) throw new Error(`${to.name} isn’t online.`)
    setItems((list) =>
      kept([{ id: body.offer, direction: 'out', files, peer: body.to, state: 'waiting', at: Date.now() }, ...list]),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accept = useCallback((item: ShareItem) => void take(item), [take])

  const decline = useCallback(
    (item: ShareItem) => {
      if (item.offer) void answer(item.offer, 'declined')
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
  const setFolder = useCallback((next: string) => {
    setFolderState(next)
    localStorage.setItem(FOLDER_KEY, next)
  }, [])

  const waiting = useMemo(() => items.filter((i) => i.direction === 'in' && i.state === 'waiting' && i.offer), [items])

  return { items, waiting, send, accept, decline, acceptOn, forget, acceptFromHome, setAcceptFromHome, folder, setFolder }
}

const ACCEPT_KEY = 'basalt.share.acceptFromHome'
const FOLDER_KEY = 'basalt.share.folder'

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
