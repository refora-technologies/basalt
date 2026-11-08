import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  api,
  onNearbyProgress,
  onNearbyReady,
  onNearbySent,
  type NearbyCodeSaid,
  type NearbyDevice,
  type NearbyMe,
  type NearbyReadyEvent,
  type NearbyTake,
} from './api'
import type { Transfers } from './useTransfers'
import { kept, newOfferId, progressIn, type Progress, type SavedFile, type ShareFile, type ShareItem } from './share'
import { plainReason } from './useInbox'

/**
 * Sharing with devices nearby, without a host (1.6.4): a guest's phone, two
 * people in a café. Works with or without a drive, so it lives beside the
 * drive's own sharing, not inside it.
 *
 * A device that is "Ready to receive from nearby" shows on others' Share
 * sheets by name and short id; one tapped is asked Accept or Decline. With
 * "Always ask for a code" on either side, the receiver then shows a code and
 * the sender types it, so the two have to talk first.
 */
export interface Nearby {
  /** Only in the app: the page preview pretends. */
  supported: boolean
  /** This device as others see it. */
  me: NearbyMe | null
  ready: boolean
  setReady: (on: boolean) => void
  alwaysCode: boolean
  setAlwaysCode: (on: boolean) => void
  /** Devices ready to receive nearby, while something looks (see `useNearbyDevices`). */
  devices: NearbyDevice[]
  looking: boolean
  /** Looks again now. */
  look: () => void
  /** Keeps looking while on: a Share sheet open. */
  watch: (on: boolean) => void
  /** Offers here, from devices nearby, until answered and agreed. */
  incoming: Incoming[]
  accept: (ask: string) => void
  decline: (ask: string) => void
  /** Offers sent from here, while being answered: the code to type, if one is asked. */
  outgoing: Outgoing[]
  /** Sends at once and says the offer's id; what comes of it is in `outgoing` and `items`. */
  send: (device: NearbyDevice, files: ShareFile[]) => string
  typeCode: (offer: string, code: string) => Promise<NearbyCodeSaid>
  cancel: (offer: string) => void
  /** What came and went, for the Inbox's lists. */
  items: ShareItem[]
  progressOf: (item: ShareItem) => Progress | null
  forget: (item: ShareItem) => void
  /** The Nearby screen: opened from anywhere, before a drive too. */
  screenOpen: boolean
  setScreenOpen: (open: boolean) => void
}

/** An offer to this device, from one nearby. */
export interface Incoming {
  ask: string
  from: NearbyMe
  files: { name: string; size: number }[]
  /** A code will be shown here once accepted. */
  code: boolean
  /** Accepted here; waiting for the code to be typed, or for the files. */
  accepted?: boolean
  /** The code to tell the sender. */
  shown?: string
  /** Wrong codes typed there, and tries left. */
  left?: number
  at: number
}

/** An offer from this device, while it's answered. */
export interface Outgoing {
  offer: string
  device: NearbyDevice
  files: ShareFile[]
  state: 'asking' | 'code' | 'sending'
  /** Tries left after a wrong code. */
  left?: number
}

const READY_KEY = 'basalt.nearby.ready'
const CODE_KEY = 'basalt.nearby.alwaysCode'
const ITEMS_KEY = 'basalt.nearby.items'
const FOLDER_KEY = 'basalt.share.folder'
/** How often a Share sheet that is open looks again. */
const LOOK_EVERY_MS = 4_000

export function useNearby(transfers: Transfers): Nearby {
  const [me, setMe] = useState<NearbyMe | null>(null)
  const [ready, setReadyState] = useState(() => localStorage.getItem(READY_KEY) === '1')
  const [alwaysCode, setAlwaysCodeState] = useState(() => localStorage.getItem(CODE_KEY) === '1')
  const [devices, setDevices] = useState<NearbyDevice[]>([])
  const [looking, setLooking] = useState(false)
  const [watchers, setWatchers] = useState(0)
  const [incoming, setIncoming] = useState<Incoming[]>([])
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [items, setItems] = useState<ShareItem[]>(() => load())
  const [screenOpen, setScreenOpen] = useState(false)
  /** How far each offer sent from here has come there. */
  const [sentProgress, setSentProgress] = useState<Map<string, Progress>>(() => new Map())
  const transfersRef = useRef(transfers)
  transfersRef.current = transfers
  const incomingRef = useRef(incoming)
  incomingRef.current = incoming
  const outgoingRef = useRef(outgoing)
  outgoingRef.current = outgoing

  useEffect(() => {
    void api
      .nearbyWhoami()
      .then(setMe)
      .catch(() => {})
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(kept(items, 100)))
    } catch {
      // Not kept: the list starts empty next time.
    }
  }, [items])

  // Ready or not, as set; again whenever the code setting changes.
  useEffect(() => {
    void api.nearbyReady(ready, alwaysCode).catch(() => {})
  }, [ready, alwaysCode])

  const setReady = useCallback((on: boolean) => {
    setReadyState(on)
    localStorage.setItem(READY_KEY, on ? '1' : '0')
  }, [])
  const setAlwaysCode = useCallback((on: boolean) => {
    setAlwaysCodeState(on)
    localStorage.setItem(CODE_KEY, on ? '1' : '0')
  }, [])

  const update = useCallback((id: string, direction: 'in' | 'out', change: (item: ShareItem) => ShareItem) => {
    setItems((list) => list.map((i) => (i.id === id && i.direction === direction ? change(i) : i)))
  }, [])

  /** Takes the files agreed, one after another, then tells the sender how it went. */
  const take = useCallback(
    async (ask: string, offer: Incoming, where: NearbyTake) => {
      const id = `nb-${ask}`
      const peer = { device: `nearby-${offer.from.id}`, name: `${offer.from.name} · ${offer.from.id}`, form: offer.from.form }
      const files: ShareFile[] = offer.files.map((f) => ({ name: f.name, size: f.size, path: '' }))
      setItems((list) => kept([{ id, direction: 'in', files, peer, state: 'moving', at: Date.now() }, ...list.filter((i) => i.id !== id)]))
      const saved: SavedFile[] = []
      try {
        for (const [n, file] of offer.files.entries()) {
          const transfer = `share-${id}-${n}`
          transfersRef.current.start({ id: transfer, kind: 'download', name: file.name, path: file.name, total: file.size })
          try {
            const folder = localStorage.getItem(FOLDER_KEY) || undefined
            const landed = await api.receiveDirect(where.endpoint, where.offer, where.token, n, file.name, transfer, folder)
            transfersRef.current.finish(transfer)
            saved.push({ name: file.name, shownAs: landed.shownAs, path: landed.path, uri: landed.uri })
          } catch (e) {
            transfersRef.current.finish(transfer, e)
            throw e
          }
        }
        update(id, 'in', (i) => ({ ...i, state: 'done', saved, savedAs: saved[saved.length - 1]?.shownAs }))
        void api.nearbyFinish(ask, 'done').catch(() => {})
      } catch (e) {
        update(id, 'in', (i) => ({ ...i, state: 'failed', reason: plainReason(e instanceof Error ? e.message : String(e)) }))
        void api.nearbyFinish(ask, 'failed').catch(() => {})
      }
    },
    [update],
  )

  // What comes to this device while it's ready.
  useEffect(() => {
    let gone = false
    let stop: (() => void) | null = null
    const hear = (event: NearbyReadyEvent): void => {
      const forget = (): void => setIncoming((list) => list.filter((i) => i.ask !== event.ask))
      switch (event.kind) {
        case 'offer':
          setIncoming((list) => [
            ...list.filter((i) => i.ask !== event.ask),
            { ask: event.ask, from: event.from, files: event.files, code: event.code, at: Date.now() },
          ])
          break
        case 'code':
          setIncoming((list) => list.map((i) => (i.ask === event.ask ? { ...i, accepted: true, shown: event.code } : i)))
          break
        case 'wrongCode':
          setIncoming((list) => list.map((i) => (i.ask === event.ask ? { ...i, left: event.left } : i)))
          break
        case 'take': {
          const offer = incomingRef.current.find((i) => i.ask === event.ask)
          forget()
          // Stopped here meanwhile: the sender is told it didn't go.
          if (offer) void take(event.ask, offer, event.take)
          else void api.nearbyFinish(event.ask, 'failed').catch(() => {})
          break
        }
        case 'gone':
          forget()
          break
      }
    }
    void onNearbyReady(hear).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [take])

  // How far each offer sent from here has come there.
  useEffect(() => {
    let gone = false
    let stop: (() => void) | null = null
    void onNearbyProgress(({ offer, done, total }) =>
      setSentProgress((map) => new Map(map).set(offer, { done, total, rate: rateOf(map.get(offer), done), at: Date.now() })),
    ).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [])

  // How each offer sent from here ended there.
  useEffect(() => {
    let gone = false
    let stop: (() => void) | null = null
    void onNearbySent(({ offer, answer }) => {
      setOutgoing((list) => list.filter((o) => o.offer !== offer))
      update(offer, 'out', (i) => ({
        ...i,
        state: answer === 'done' ? 'done' : 'failed',
        reason: answer === 'done' ? undefined : 'It didn’t arrive.',
      }))
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [update])

  const accept = useCallback((ask: string) => {
    setIncoming((list) => list.map((i) => (i.ask === ask ? { ...i, accepted: true } : i)))
    void api.nearbyReply(ask, true).then((there) => {
      if (!there) setIncoming((list) => list.filter((i) => i.ask !== ask))
    })
  }, [])

  const decline = useCallback((ask: string) => {
    const offer = incomingRef.current.find((i) => i.ask === ask)
    setIncoming((list) => list.filter((i) => i.ask !== ask))
    void api.nearbyReply(ask, false).catch(() => {})
    if (offer) {
      const files: ShareFile[] = offer.files.map((f) => ({ name: f.name, size: f.size, path: '' }))
      const peer = { device: `nearby-${offer.from.id}`, name: `${offer.from.name} · ${offer.from.id}`, form: offer.from.form }
      setItems((list) => kept([{ id: `nb-${ask}`, direction: 'in', files, peer, state: 'declined', at: Date.now() }, ...list]))
    }
  }, [])

  const look = useCallback(() => {
    setLooking(true)
    void api
      .nearbyFind()
      .then(setDevices)
      .catch(() => {})
      .finally(() => setLooking(false))
  }, [])

  const watch = useCallback((on: boolean) => setWatchers((n) => Math.max(0, n + (on ? 1 : -1))), [])
  useEffect(() => {
    if (watchers === 0) return undefined
    look()
    const timer = setInterval(look, LOOK_EVERY_MS)
    return () => clearInterval(timer)
  }, [watchers, look])

  const send = useCallback(
    (device: NearbyDevice, files: ShareFile[]): string => {
      const offer = newOfferId()
      const peer = { device: `nearby-${device.id}`, name: `${device.name} · ${device.id}`, form: device.form }
      setOutgoing((list) => [...list, { offer, device, files, state: 'asking' }])
      setItems((list) => kept([{ id: offer, direction: 'out', files, peer, state: 'waiting', at: Date.now() }, ...list]))
      void (async () => {
      try {
        const said = await api.nearbyOffer(
          device,
          offer,
          // A file on the drive: passed on from the host by this device as it comes.
          files.map((f) => ({ source: f.source ?? `drive:${f.path}`, name: f.name, size: f.size })),
          alwaysCode,
        )
        if (said.kind === 'declined') {
          setOutgoing((list) => list.filter((o) => o.offer !== offer))
          update(offer, 'out', (i) => ({ ...i, state: 'declined' }))
        } else if (said.kind === 'code') {
          setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, state: 'code' } : o)))
          update(offer, 'out', (i) => ({ ...i, reason: 'Type the code shown there' }))
        } else {
          setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, state: 'sending' } : o)))
          update(offer, 'out', (i) => ({ ...i, state: 'moving', reason: undefined }))
        }
      } catch (e) {
        setOutgoing((list) => list.filter((o) => o.offer !== offer))
        const reason = plainReason(e instanceof Error ? e.message : String(e))
        update(offer, 'out', (i) => ({ ...i, state: 'failed', reason }))
      }
      })()
      return offer
    },
    [alwaysCode, update],
  )

  const typeCode = useCallback(
    async (offer: string, code: string): Promise<NearbyCodeSaid> => {
      const said = await api.nearbyCode(offer, code)
      if (said.kind === 'right') {
        setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, state: 'sending' } : o)))
        update(offer, 'out', (i) => ({ ...i, state: 'moving', reason: undefined }))
      } else if (said.left === 0) {
        setOutgoing((list) => list.filter((o) => o.offer !== offer))
        update(offer, 'out', (i) => ({ ...i, state: 'failed', reason: 'Too many wrong codes.' }))
      } else {
        setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, left: said.left } : o)))
      }
      return said
    },
    [update],
  )

  const cancel = useCallback(
    (offer: string) => {
      setOutgoing((list) => list.filter((o) => o.offer !== offer))
      update(offer, 'out', (i) => (i.state === 'waiting' ? { ...i, state: 'failed', reason: 'Cancelled.' } : i))
      void api.nearbyCancel(offer).catch(() => {})
    },
    [update],
  )

  const moving = transfers.transfers
  const progressOf = useCallback(
    (item: ShareItem): Progress | null => {
      if (item.state !== 'moving') return null
      return item.direction === 'in' ? progressIn(item, moving, Date.now()) : (sentProgress.get(item.id) ?? null)
    },
    [moving, sentProgress],
  )

  // How far each share coming here has come, told to its sender about once a second.
  const toldAt = useRef(new Map<string, number>())
  useEffect(() => {
    const now = Date.now()
    for (const item of items) {
      if (item.direction !== 'in' || item.state !== 'moving' || !item.id.startsWith('nb-')) continue
      if (now - (toldAt.current.get(item.id) ?? 0) < 1_000) continue
      const p = progressIn(item, moving, now)
      if (!p) continue
      toldAt.current.set(item.id, now)
      void api.nearbyProgress(item.id.slice(3), p.done, p.total).catch(() => {})
    }
  }, [moving, items])

  const forget = useCallback((item: ShareItem) => setItems((list) => list.filter((i) => i !== item)), [])

  return useMemo(
    () => ({
      supported: true,
      me,
      ready,
      setReady,
      alwaysCode,
      setAlwaysCode,
      devices,
      looking,
      look,
      watch,
      incoming,
      accept,
      decline,
      outgoing,
      send,
      typeCode,
      cancel,
      items,
      progressOf,
      forget,
      screenOpen,
      setScreenOpen,
    }),
    [me, ready, setReady, alwaysCode, setAlwaysCode, devices, looking, look, watch, incoming, accept, decline, outgoing, send, typeCode, cancel, items, progressOf, forget, screenOpen],
  )
}

/** Keeps looking for devices nearby while `on` (a Share sheet open). */
export function useNearbyDevices(nearby: Nearby, on: boolean): NearbyDevice[] {
  const { watch } = nearby
  useEffect(() => {
    if (!on) return undefined
    watch(true)
    return () => watch(false)
  }, [on, watch])
  return nearby.devices
}

/** Bytes a second, from the last word and this one. */
function rateOf(last: Progress | undefined, done: number): number {
  if (!last) return 0
  const seconds = (Date.now() - last.at) / 1000
  if (seconds <= 0) return last.rate
  const now = Math.max(0, (done - last.done) / seconds)
  // Smoothed, so the time left doesn't jump about.
  return last.rate > 0 ? last.rate * 0.6 + now * 0.4 : now
}

function load(): ShareItem[] {
  try {
    const list = JSON.parse(localStorage.getItem(ITEMS_KEY) ?? '[]') as ShareItem[]
    // One that was moving when the app closed did not finish.
    return Array.isArray(list)
      ? list.map((i) =>
          i.state === 'moving' || i.state === 'waiting' ? { ...i, state: 'failed', reason: 'Stopped before it finished.' } : i,
        )
      : []
  } catch {
    return []
  }
}
