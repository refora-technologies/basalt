import { useCallback, useEffect, useRef, useState } from 'react'

import { api, type Listening, type Playlist } from './api'

/**
 * Your playlists, and what you were listening to.
 *
 * With a profile signed in they are kept on the host, as its stars are, so
 * they are the same on every device. Without one — or with a host before
 * 1.6.3, which cannot keep them — they are kept on this device, per host.
 */
export interface MusicMineState {
  playlists: Playlist[]
  listening: Listening | null
  setPlaylists: (playlists: Playlist[]) => void
  setListening: (listening: Listening) => void
}

const KEY_PREFIX = 'basalt:music:'

interface Local {
  playlists: Playlist[]
  listening: Listening | null
}

function loadLocal(hostId: string | null | undefined): Local {
  if (!hostId) return { playlists: [], listening: null }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY_PREFIX + hostId) ?? 'null') as Partial<Local> | null
    return {
      playlists: Array.isArray(parsed?.playlists) ? parsed!.playlists : [],
      listening: parsed?.listening ?? null,
    }
  } catch {
    return { playlists: [], listening: null }
  }
}

function saveLocal(hostId: string | null | undefined, local: Local): void {
  if (!hostId) return
  try {
    window.localStorage.setItem(KEY_PREFIX + hostId, JSON.stringify(local))
  } catch {
    // Storage full or off: playlists stop persisting; nothing else breaks.
  }
}

/** `hostId` and `profileId` as the stars take them; `ready` once the host is settled. */
export function useMusicMine(
  hostId: string | null | undefined,
  profileId: string | null,
  ready: boolean,
): MusicMineState {
  const [playlists, setPlaylistsState] = useState<Playlist[]>([])
  const [listening, setListeningState] = useState<Listening | null>(null)
  /** Whether the host keeps them: a profile, and a host that knows how. */
  const onHost = useRef(false)
  const latest = useRef<Local>({ playlists: [], listening: null })

  useEffect(() => {
    let cancelled = false
    const local = loadLocal(hostId)
    latest.current = local
    setPlaylistsState(local.playlists)
    setListeningState(local.listening)
    onHost.current = false
    if (!ready || !profileId) return undefined
    void api
      .musicMine({})
      .then((mine) => {
        if (cancelled) return
        onHost.current = true
        latest.current = { playlists: mine.playlists ?? [], listening: mine.listening ?? null }
        setPlaylistsState(latest.current.playlists)
        setListeningState(latest.current.listening)
      })
      .catch(() => {
        // A host before 1.6.3: this device keeps them, as before profiles.
      })
    return () => {
      cancelled = true
    }
  }, [hostId, profileId, ready])

  const setPlaylists = useCallback(
    (next: Playlist[]) => {
      latest.current = { ...latest.current, playlists: next }
      setPlaylistsState(next)
      if (onHost.current) void api.musicMine({ playlists: next }).catch(() => {})
      else saveLocal(hostId, latest.current)
    },
    [hostId],
  )

  const setListening = useCallback(
    (next: Listening) => {
      latest.current = { ...latest.current, listening: next }
      setListeningState(next)
      if (onHost.current) void api.musicMine({ listening: next }).catch(() => {})
      else saveLocal(hostId, latest.current)
    },
    [hostId],
  )

  return { playlists, listening, setPlaylists, setListening }
}

/** A new playlist's id: unique without asking the host. */
export function newPlaylistId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `p-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
