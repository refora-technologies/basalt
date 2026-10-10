import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

/**
 * Managing the host from this device: the host as its own window shows it,
 * and the same things done to it, by a device the host lets manage it.
 *
 * The shapes are the host window's own (`apps/host/src/lib/api.ts`), passed
 * through unchanged: one host, one set of words for it, whichever screen.
 */

export type KeyKind = 'chip' | 'system' | 'file'

export interface ManagedDevice {
  id: string
  name: string
  /** Unix seconds. */
  pairedAt: number
  lastSeen: number
  /** May change files on the drive. */
  writable: boolean
  online: boolean
  connections: number
  sent: number
  received: number
  /** Signs in with a key of its own, rather than a pairing code. */
  keyed: boolean
  keyKind: KeyKind | null
  /** Manages the host (shown as such; stored as `owner`). */
  owner: boolean
}

export interface PairingRequest {
  id: string
  deviceName: string
  /** The number to type on that device; null when no PIN is asked for. */
  pin: string | null
  secondsLeft: number
}

export interface HostDrive {
  path: string
  name: string
  label: string
  kind: 'fixed' | 'removable' | 'network' | 'cdrom' | 'other'
  free: number
  total: number
  ready: boolean
}

export interface ManagedProfile {
  id: string
  name: string
  color: number
  /** False after the PIN was reset, until its person chooses a new one. */
  hasPin: boolean
  createdAt: number
  lastUsed: number
  devices: { name: string; remembered: boolean; lastUsed: number }[]
  /** A profile from another drive: that drive's name. No PIN here. */
  home?: string | null
}

/** A profile from another drive asking to be let in. */
export interface ProfileLinkRequest {
  id: string
  deviceName: string
  name: string
  color: number
  /** Its home drive's name. */
  home: string
  secondsLeft: number
}

export interface LibrarySections {
  movies: boolean
  series: boolean
  videos: boolean
  music: boolean
  photos: boolean
}

export interface ManagedHostStatus {
  hostId: string
  hostName: string
  port: number
  requirePin: boolean
  vault: {
    path: string
    name: string
    free: number
    total: number
    /** False while the drive is unplugged. */
    available: boolean
  } | null
  addresses: string[]
  deviceCount: number
  library: {
    enabled: boolean
    scanning: boolean
    films: number
    series: number
    uncertain: number
    withArt: number
    posters: boolean
    hasKey: boolean
    videos: number
    music: number
    photos: number
    scannedAt: number
  }
  profiles: ManagedProfile[]
  profileRules: { requireProfile: boolean; ownerAddsProfiles: boolean }
  sections: LibrarySections
  serving: boolean
  problem: string | null
  conversion: {
    enabled: boolean
    available: boolean
    detected: boolean
    measured: {
      by: string
      atOnce: number
      speed: number
      at: number
      memory?: boolean
    } | null
    measuring: boolean
    note: string | null
    byHand: number | null
    limit: number
    active: { device: string; file: string; since: number }[]
  }
  endorsement: { by: string; until: number } | null
  platform: 'windows' | 'linux' | 'macos' | 'other'
  /** Running with no screen: a service, or in Docker. Absent from older hosts. */
  headless?: boolean
}

/** The host after an action: the window's views, and which device is this one. */
export interface ManageView {
  status: ManagedHostStatus
  devices: ManagedDevice[]
  pairings: PairingRequest[]
  /** Only when asked for: the drives the host's computer could share. */
  drives: HostDrive[] | null
  /** Only when asked for: the folders in one place on the host's computer. */
  folders?: HostFolders | null
  /** This device's id in `devices`. */
  you: string
  /** Profiles from other drives waiting to be let in. Absent from older hosts. */
  profileLinks?: ProfileLinkRequest[]
}

/** What can be asked of the host. Mirrors `ManageAction` in basalt-proto. */
export type ManageAction =
  | { do: 'view' }
  | { do: 'renameDevice'; id: string; name: string }
  | { do: 'setWritable'; id: string; writable: boolean }
  | { do: 'setManages'; id: string; manages: boolean }
  | { do: 'removeDevice'; id: string }
  | { do: 'denyPairing'; id: string }
  | { do: 'setRequirePin'; require: boolean }
  | { do: 'setHostName'; name: string }
  | { do: 'setLibrary'; enabled: boolean }
  | { do: 'rescan' }
  | { do: 'setPosters'; enabled: boolean }
  | { do: 'setTmdbKey'; key: string }
  | { do: 'setConversion'; enabled: boolean }
  | { do: 'setConversionAtOnce'; atOnce: number | null }
  | { do: 'measureConversion' }
  | { do: 'setSections'; sections: LibrarySections }
  | { do: 'addProfile'; name: string; color: number }
  | { do: 'removeProfile'; id: string }
  | { do: 'resetProfilePin'; id: string }
  | { do: 'setRequireProfile'; require: boolean }
  | { do: 'setOwnerAddsProfiles'; ownerOnly: boolean }
  | { do: 'listDrives' }
  | { do: 'chooseDrive'; path: string; name: string }
  | { do: 'renameDrive'; name: string }
  | { do: 'listFolders'; path: string }
  | { do: 'approveProfileLink'; id: string }
  | { do: 'denyProfileLink'; id: string }

/** The folders in one place on the host's computer, to choose one to share. */
export interface HostFolders {
  /** Where this is; empty for the list of drives. */
  path: string
  /** One level up: null at the top, empty for the list of drives. */
  parent: string | null
  folders: Array<{ name: string; path: string }>
}

/** The host's answer, with what it only says when asked kept from before. */
function keepAsked(next: ManageView, old: ManageView | null): ManageView {
  return { ...next, drives: next.drives ?? old?.drives ?? null, folders: next.folders ?? old?.folders ?? null }
}

/** How often the screen asks again while it is open: the window's own pace. */
const REFRESH_MS = 3000

export interface Manage {
  view: ManageView | null
  /** Why the last request failed, said as the host said it. */
  error: string | null
  clearError: () => void
  /** The action under way, so its control can show it. */
  busy: ManageAction['do'] | null
  /** Does it, and keeps the host's answer. Resolves true when it worked. */
  act: (action: ManageAction) => Promise<boolean>
}

/**
 * The host, kept current while the screen is open: asked again every few
 * seconds, and after every change with the host's own answer, so nothing on
 * screen is ever a guess about what the host did.
 */
export function useManage(): Manage {
  const [view, setView] = useState<ManageView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ManageAction['do'] | null>(null)
  const live = useRef(true)
  // A change under way is not overtaken by a refresh that started before it.
  const changing = useRef(0)

  useEffect(() => {
    live.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const before = changing.current
      try {
        const next = await api.manage({ do: 'view' })
        if (live.current && changing.current === before) {
          // Drives and folders are asked for only now and then; kept until
          // asked again.
          setView((old) => keepAsked(next, old))
        }
      } catch (e) {
        if (live.current) setError(said(e))
      }
      if (live.current) timer = setTimeout(() => void refresh(), REFRESH_MS)
    }
    void refresh()
    return () => {
      live.current = false
      if (timer) clearTimeout(timer)
    }
  }, [])

  const act = useCallback(async (action: ManageAction): Promise<boolean> => {
    changing.current += 1
    setBusy(action.do)
    try {
      const next = await api.manage(action)
      if (live.current) {
        setView((old) => keepAsked(next, old))
        setError(null)
      }
      return true
    } catch (e) {
      if (live.current) setError(said(e))
      return false
    } finally {
      if (live.current) setBusy(null)
    }
  }, [])

  return { view, error, clearError: useCallback(() => setError(null), []), busy, act }
}

function said(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.charAt(0).toUpperCase() + message.slice(1) + (message.endsWith('.') ? '' : '.')
}

/** How a device signs in, in a few words. */
export function signsIn(device: ManagedDevice): string {
  if (!device.keyed) return 'pairing code'
  switch (device.keyKind) {
    case 'chip':
      return 'chip key'
    case 'system':
      return 'system key'
    default:
      return 'key'
  }
}

/** The number to type, said in two halves: "482 915". */
export function spacedPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin
}
