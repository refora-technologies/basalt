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
} from './api'
import type { Transfers } from './useTransfers'
import { kept, newOfferId, progressIn, type Progress, type SavedFile, type ShareFile, type ShareItem } from './share'
import { plainReason } from './useInbox'
import { isAndroid } from './platform'
import { hostWifi, joinWifi, leaveWifi, scanWifi, turnWifiOn, wifiReady, type FoundWifi, type WifiState } from './nearbyWifi'
import { pluginReason } from './android'

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
  /** Why devices with no Wi-Fi in common can't find this one or be found, if they can't. */
  wifiNote: string | null
  /** On a computer: Windows Firewall keeps devices nearby out (`blocked`), until let through. */
  firewall: 'open' | 'blocked' | 'unknown'
  /** Lets them through: Windows asks for an administrator. Throws what went wrong. */
  allowFirewall: () => Promise<void>
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
  /** Joining its own Wi-Fi first (no network in common), then asking, a code, sending. */
  state: 'joining' | 'asking' | 'code' | 'sending'
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
  /** Devices found by their own Wi-Fi: no network in common. */
  const [far, setFar] = useState<FoundWifi[]>([])
  const [wifiNote, setWifiNote] = useState<string | null>(null)
  const [firewall, setFirewall] = useState<'open' | 'blocked' | 'unknown'>('open')
  /** Offers sent over a Wi-Fi joined for them: left once each ends. */
  const joinedFor = useRef(new Set<string>())
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

  // Ready on a computer: whether Windows Firewall lets devices nearby in.
  useEffect(() => {
    if (!ready || isAndroid()) return
    void api
      .nearbyFirewall()
      .then(setFirewall)
      .catch(() => setFirewall('unknown'))
  }, [ready])
  const allowFirewall = useCallback(async () => {
    setFirewall(await api.nearbyFirewallAllow())
  }, [])

  // Ready: a Wi-Fi of its own too, for devices with no network in common,
  // once Wi-Fi is on and Android lets it (see `hostNow` for when it's open).
  const [hostable, setHostable] = useState(false)
  useEffect(() => {
    if (!ready) {
      setWifiNote(null)
      setHostable(false)
      return undefined
    }
    let live = true
    let again: ReturnType<typeof setTimeout> | null = null
    let askedWifi = false
    const start = async (): Promise<void> => {
      const state = await wifiReady(true)
      if (!live) return
      if (state === 'wifi') {
        // Off: turned on (Android's panel, from Android 10), and looked at
        // again until it is, then hosted.
        if (!askedWifi) {
          askedWifi = true
          void turnWifiOn().catch(() => {})
        }
        setWifiNote(wifiNoteFor(state))
        again = setTimeout(() => void start(), 2_000)
        return
      }
      if (state !== 'granted') {
        setWifiNote(wifiNoteFor(state))
        return
      }
      setHostable(true)
    }
    void start()
    return () => {
      live = false
      setHostable(false)
      if (again) clearTimeout(again)
    }
  }, [ready])

  /**
   * Its own Wi-Fi is open only while this device isn't looking for others or
   * sending over another's: a phone hosting one can't look at the Wi-Fis
   * around (the Samsung A03s's looks never come back while it hosts), and
   * every phone's own is 192.168.49.1, so on another's it would only find
   * itself. Ready on the same Wi-Fi stays as it is throughout.
   */
  const [joined, setJoined] = useState(0)
  const hostNow = ready && hostable && watchers === 0 && joined === 0
  /** One change at a time, in order: Android's Wi-Fi Direct is busy otherwise. */
  const hosting = useRef<Promise<void>>(Promise.resolve())
  const host = useCallback((on: boolean): Promise<void> => {
    const next = hosting.current.then(() => hostWifi(on))
    hosting.current = next.catch(() => {})
    return next
  }, [])
  useEffect(() => {
    let live = true
    host(hostNow)
      .then(() => {
        note(hostNow ? 'hosting its own Wi-Fi' : 'own Wi-Fi closed')
        if (hostNow && live) setWifiNote(null)
      })
      .catch((e: unknown) => {
        if (!hostNow) return
        note(`hosting failed: ${pluginReason(e)}`)
        if (live) setWifiNote(`Devices with no Wi-Fi in common can’t find this one: ${pluginReason(e)}`)
      })
    return () => {
      live = false
    }
  }, [hostNow, host])

  /** Leaves the Wi-Fi joined for an offer, once it has ended: its own opens again then, if ready. */
  const leaveFor = useCallback((offer: string) => {
    if (!joinedFor.current.delete(offer)) return
    if (joinedFor.current.size > 0) return
    void leaveWifi()
      .catch(() => {})
      .finally(() => setJoined(joinedFor.current.size))
  }, [])

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
    async (ask: string, offer: Incoming) => {
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
            // Down the line the offer came up: this device never has to reach the sender.
            const landed = await api.nearbyTakeFile(ask, n, file.name, transfer, folder)
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
        update(id, 'in', (i) => ({ ...i, state: 'failed', reason: plainReason(pluginReason(e)) }))
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
          if (offer) void take(event.ask, offer)
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
      leaveFor(offer)
      setOutgoing((list) => list.filter((o) => o.offer !== offer))
      update(offer, 'out', (i) => ({
        ...i,
        state: answer === 'done' ? 'done' : 'failed',
        reason: answer === 'done' ? undefined : 'The other device couldn’t take it.',
      }))
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [update, leaveFor])

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

  // Devices with no network in common, by their own Wi-Fi: looked for less
  // often (Android allows a few looks a minute). Asked for what it needs once.
  useEffect(() => {
    if (watchers === 0) return undefined
    let live = true
    const lookFar = async (ask: boolean): Promise<void> => {
      const state = await wifiReady(ask)
      if (!live) return
      if (state !== 'granted') {
        setFar([])
        return
      }
      const found = await scanWifi().catch(() => [])
      if (live) setFar(found)
    }
    // A moment first, for this device's own Wi-Fi to close (see `hostNow`):
    // a phone hosting one can't look.
    const first = setTimeout(() => void lookFar(true), 1_500)
    const timer = setInterval(() => void lookFar(false), FAR_LOOK_EVERY_MS)
    return () => {
      live = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [watchers])

  // Both, each device once (on this Wi-Fi rather than by its own), each
  // where it was first seen: a row never moves under a finger about to tap it.
  const firstSeen = useRef(new Map<string, number>())
  const all = useMemo(() => {
    const here = new Set(devices.map((d) => d.id))
    const farAway: NearbyDevice[] = far
      .filter((f) => !here.has(f.id) && f.id !== me?.id)
      .map((f) => ({ id: f.id, name: f.name || 'A device', address: '', port: 0, key: '', code: true, ssid: f.ssid }))
    const both = [...devices, ...farAway]
    const seen = firstSeen.current
    for (const d of both) if (!seen.has(d.id)) seen.set(d.id, seen.size)
    return both.sort((a, b) => (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0))
  }, [devices, far, me])

  const send = useCallback(
    (device: NearbyDevice, files: ShareFile[]): string => {
      const offer = newOfferId()
      const peer = { device: `nearby-${device.id}`, name: `${device.name} · ${device.id}`, form: device.form }
      setOutgoing((list) => [...list, { offer, device, files, state: device.ssid ? 'joining' : 'asking' }])
      setItems((list) => kept([{ id: offer, direction: 'out', files, peer, state: 'waiting', at: Date.now() }, ...list]))
      if (device.ssid) {
        // Counted at once, before the list that chose it closes: its own
        // Wi-Fi stays closed from here (see `hostNow`).
        joinedFor.current.add(offer)
        setJoined(joinedFor.current.size)
      }
      void (async () => {
      try {
        let there = device
        note(`offer ${offer} to ${device.name} · ${device.id}${device.ssid ? ' by its own Wi-Fi' : ` at ${device.address}`}`)
        if (device.ssid) {
          // No network in common: its own Wi-Fi joined, and it found there.
          if ((await wifiReady(false)) === 'wifi') {
            await turnWifiOn().catch(() => {})
            throw new Error('Turn on Wi-Fi, then send again.')
          }
          // Its own closed first (see `hostNow`), and waited for.
          await host(false).catch(() => {})
          await joinWifi(device.ssid)
          note(`joined ${device.ssid}`)
          there = await findOnJoined(device.id)
          note(`found there at ${there.address}:${there.port}`)
          setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, device: there, state: 'asking' } : o)))
        }
        const said = await api.nearbyOffer(
          there,
          offer,
          // A file on the drive: passed on from the host by this device as it comes.
          files.map((f) => ({ source: f.source ?? `drive:${f.path}`, name: f.name, size: f.size })),
          // Over its own Wi-Fi anyone nearby could join: a code, always.
          alwaysCode || !!device.ssid,
        )
        if (said.kind === 'declined') {
          leaveFor(offer)
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
        note(`offer ${offer} failed: ${pluginReason(e)}`)
        leaveFor(offer)
        setOutgoing((list) => list.filter((o) => o.offer !== offer))
        const reason = plainReason(pluginReason(e))
        update(offer, 'out', (i) => ({ ...i, state: 'failed', reason }))
      }
      })()
      return offer
    },
    [alwaysCode, update, leaveFor, host],
  )

  const typeCode = useCallback(
    async (offer: string, code: string): Promise<NearbyCodeSaid> => {
      const said = await api.nearbyCode(offer, code)
      if (said.kind === 'right') {
        setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, state: 'sending' } : o)))
        update(offer, 'out', (i) => ({ ...i, state: 'moving', reason: undefined }))
      } else if (said.left === 0) {
        leaveFor(offer)
        setOutgoing((list) => list.filter((o) => o.offer !== offer))
        update(offer, 'out', (i) => ({ ...i, state: 'failed', reason: 'Too many wrong codes.' }))
      } else {
        setOutgoing((list) => list.map((o) => (o.offer === offer ? { ...o, left: said.left } : o)))
      }
      return said
    },
    [update, leaveFor],
  )

  const cancel = useCallback(
    (offer: string) => {
      leaveFor(offer)
      setOutgoing((list) => list.filter((o) => o.offer !== offer))
      update(offer, 'out', (i) => (i.state === 'waiting' ? { ...i, state: 'failed', reason: 'Cancelled.' } : i))
      void api.nearbyCancel(offer).catch(() => {})
    },
    [update, leaveFor],
  )

  const moving = transfers.transfers
  const progressOf = useCallback(
    (item: ShareItem): Progress | null => {
      if (item.state !== 'moving') return null
      return item.direction === 'in' ? progressIn(item, moving, Date.now()) : (sentProgress.get(item.id) ?? null)
    },
    [moving, sentProgress],
  )


  const forget = useCallback((item: ShareItem) => setItems((list) => list.filter((i) => i !== item)), [])

  return useMemo(
    () => ({
      supported: true,
      me,
      ready,
      setReady,
      alwaysCode,
      setAlwaysCode,
      wifiNote,
      firewall,
      allowFirewall,
      devices: all,
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
    [me, ready, setReady, alwaysCode, setAlwaysCode, wifiNote, firewall, allowFirewall, all, looking, look, watch, incoming, accept, decline, outgoing, send, typeCode, cancel, items, progressOf, forget, screenOpen],
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

/** How often devices with no network in common are looked for. */
const FAR_LOOK_EVERY_MS = 12_000

/** Once its Wi-Fi is joined, the device there, as the same-Wi-Fi look finds it. */
async function findOnJoined(id: string): Promise<NearbyDevice> {
  for (let tries = 1; tries <= 8; tries++) {
    const all = await api.nearbyFind().catch((e: unknown) => {
      note(`find failed: ${pluginReason(e)}`)
      return [] as NearbyDevice[]
    })
    const found = all.find((d) => d.id === id)
    if (found) return found
    note(`not found there yet (try ${tries}; ${all.length} others)`)
    await new Promise((done) => setTimeout(done, 1_000))
  }
  throw new Error('Joined its Wi-Fi, but it didn’t answer there.')
}

/** A step of sharing nearby, into the device's own log. */
function note(line: string): void {
  void api.nearbyNote(line).catch(() => {})
}

/** What stands in the way of a Wi-Fi of its own, said plainly. */
function wifiNoteFor(state: WifiState): string {
  switch (state) {
    case 'wifi':
      return 'Turn on Wi-Fi so devices that aren’t on your Wi-Fi can find this one. It doesn’t need to be connected to a network.'
    case 'location':
      return 'Turn on Location so devices that aren’t on your Wi-Fi can find this one. Android needs it to look for Wi-Fi.'
    case 'ask':
    case 'denied':
      return 'To reach devices that aren’t on your Wi-Fi, allow Basalt to find nearby devices and use location. Android needs these to look for Wi-Fi.'
    case 'unsupported':
      return 'Only devices on the same Wi-Fi can find this one.'
    default:
      return ''
  }
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
