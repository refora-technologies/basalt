import { useCallback, useEffect, useState } from 'react'

import { ApiError, api, onPresence, type PresentDevice } from './api'

export interface Presence {
  /** Every device of the host, online first. */
  devices: PresentDevice[]
  /** This device's id in the list. */
  you: string
  /** False on a host from before 1.6.4, which can't say who is online. */
  supported: boolean
}

const NONE: Presence = { devices: [], you: '', supported: true }

/**
 * Who of the host's devices is online, kept up to date: asked when a device
 * comes or goes (the host says so down the watch), when the app is shown
 * again, and now and then for the "last seen" times. `who` is the host and
 * profile this device acts as: another one starts over.
 */
export function usePresence(who: string | null): Presence {
  const [presence, setPresence] = useState<Presence>(NONE)
  const ask = useCallback(async () => {
    try {
      const answer = await api.presence()
      setPresence({ devices: answer.devices, you: answer.you, supported: true })
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')) {
        setPresence({ ...NONE, supported: false })
      }
    }
  }, [])

  useEffect(() => {
    setPresence(NONE)
    if (!who) return undefined
    void ask()
    let stop: (() => void) | null = null
    let gone = false
    void onPresence(() => void ask()).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    const shown = (): void => {
      if (document.visibilityState === 'visible') void ask()
    }
    document.addEventListener('visibilitychange', shown)
    const timer = setInterval(() => void ask(), REFRESH_MS)
    return () => {
      gone = true
      stop?.()
      document.removeEventListener('visibilitychange', shown)
      clearInterval(timer)
    }
  }, [who, ask])

  return presence
}

/** How often "last seen" is asked again with nothing else happening. */
const REFRESH_MS = 60_000

/**
 * This device's own devices: those of the profile it is signed in to, this
 * one first, then online, then by name. Signed in to none, only this one.
 */
export function ownDevices(presence: Presence): PresentDevice[] {
  const me = presence.devices.find((d) => d.device === presence.you)
  if (!me) return []
  const mine = me.profile
    ? presence.devices.filter((d) => d.profile === me.profile)
    : [me]
  return [...mine].sort(
    (a, b) =>
      Number(b.device === presence.you) - Number(a.device === presence.you) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
  )
}

/** "Online", or when it was last seen, in a few words. */
export function seenLine(device: PresentDevice, nowMs: number): string {
  if (device.online) return 'Online'
  if (device.lastSeen <= 0) return 'Not online'
  const minutes = Math.max(0, Math.round((nowMs - device.lastSeen) / 60_000))
  if (minutes < 2) return 'Last seen just now'
  if (minutes < 60) return `Last seen ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Last seen ${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'Last seen yesterday' : `Last seen ${days} days ago`
}
