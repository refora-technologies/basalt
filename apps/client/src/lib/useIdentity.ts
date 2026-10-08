import { useCallback, useEffect, useRef, useState } from 'react'
import { api, onProfilesChanged, type IdentityState, type ProfileView } from './api'

/**
 * Who is using this device: a profile, or the device on its own.
 *
 * Asked after connecting, and again the moment the host says its profiles or
 * its owner's rules changed, so a drive made private, or a profile removed or
 * signed out on the host, shows here at once rather than on the next click.
 * Nothing polls: the host tells the device, over the connection it already
 * keeps open for changes to the drive, and asks again when that reconnects.
 *
 * A host from before profiles cannot list any, and then there is nothing to
 * choose: the device simply carries on as itself, as it always did.
 */
export interface Identity {
  state: IdentityState | null
  /** Profiles on the host, once asked. */
  profiles: ProfileView[]
  /** False for a host that has no profiles to offer at all. */
  supported: boolean
  loaded: boolean
  refresh: () => Promise<void>
  /** Loads the host's list again, for the chooser. */
  reloadProfiles: () => Promise<void>
}

/** `host` is the id of the host connected to, or null: see `useMediaLibrary`. */
export function useIdentity(host: string | null): Identity {
  const [state, setState] = useState<IdentityState | null>(null)
  const [profiles, setProfiles] = useState<ProfileView[]>([])
  const [supported, setSupported] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const live = useRef(true)
  const current = useRef(host)
  current.current = host

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const reloadProfiles = useCallback(async () => {
    const asked = current.current
    try {
      const list = await api.profiles()
      // The last host's profiles are never offered on this one.
      if (!live.current || current.current !== asked) return
      setProfiles(list)
      setSupported(true)
    } catch {
      if (live.current && current.current === asked) setSupported(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    const asked = current.current
    try {
      const next = await api.identity()
      // About to ask who is using the device: with the host's list as it is
      // now, not as it was — a profile removed on the host must not be
      // offered.
      if (next.choose) await reloadProfiles()
      if (live.current && current.current === asked) setState(next)
    } catch {
      // Not connected: asked again when it is.
    }
  }, [reloadProfiles])

  useEffect(() => {
    // Another host has other profiles: nothing of the last one's carries over.
    setState(null)
    setProfiles([])
    setSupported(true)
    setLoaded(false)
    if (!host) return undefined
    let cancelled = false
    void Promise.all([refresh(), reloadProfiles()]).then(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [host, refresh, reloadProfiles])

  // Told by the host, or by a request it refused: the list and the rules are
  // both read again, since either may be what changed.
  useEffect(() => {
    if (!host) return undefined
    let stop: (() => void) | undefined
    let cancelled = false
    const again = (): void => {
      void refresh()
      void reloadProfiles()
    }
    // Back to the front: a phone's connection does not last in the
    // background, and what changed while it was away was told to nobody.
    const shown = (): void => {
      if (document.visibilityState === 'visible') again()
    }
    document.addEventListener('visibilitychange', shown)
    void onProfilesChanged(again).then((fn) => {
      if (cancelled) fn()
      else stop = fn
    })
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', shown)
      stop?.()
    }
  }, [host, refresh, reloadProfiles])

  return { state, profiles, supported, loaded, refresh, reloadProfiles }
}

/** Avatar colours, muted to sit in a graphite interface. Mirrors the host. */
export const PROFILE_COLORS = [
  '#7384D8',
  '#4E9EA0',
  '#6BA674',
  '#C4A157',
  '#CC7E68',
  '#C27391',
  '#957AC9',
  '#8A8F98',
]

export function profileColor(index: number): string {
  const n = PROFILE_COLORS.length
  return PROFILE_COLORS[((index % n) + n) % n]!
}

/** Four to eight digits. Mirrors the host. */
export function validPin(pin: string): boolean {
  return /^[0-9]{4,8}$/.test(pin)
}
