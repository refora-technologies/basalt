import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { api, type MediaFile, type MusicTrack } from './api'
import { type Album, type Artist, type Song, albumsOf, artistsOf, songFromFile, songOf } from './music'

/**
 * The music on the drive, as albums, artists and songs.
 *
 * The host reads the songs' tags and says when they change, the way it does
 * for the collections; this fetches them then. A host before 1.6.3 has no
 * tags to give, and refuses: the songs are then the collections' Music list,
 * described from where each file is, as the app always did.
 */
export interface MusicState {
  songs: Song[]
  albums: Album[]
  artists: Artist[]
  /** The host is still reading tags: more may come. */
  reading: boolean
  loaded: boolean
  /** A host before 1.6.3: songs come from the file list, without tags. */
  untagged: boolean
  refresh: () => void
}

/**
 * `host` is the id of the host connected to, or null. `files` is the
 * collections' Music list, used when the host cannot send tags.
 */
export function useMusic(host: string | null, files: MediaFile[]): MusicState {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null)
  const [reading, setReading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [untagged, setUntagged] = useState(false)
  const revision = useRef(0)
  const inFlight = useRef<string | null>(null)
  const live = useRef(true)
  const current = useRef(host)
  current.current = host

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const asked = current.current
    if (!asked || inFlight.current === asked) return
    inFlight.current = asked
    try {
      const response = await api.music(revision.current)
      if (!live.current || current.current !== asked) return
      revision.current = response.revision
      setReading(response.reading)
      // Nothing back means "you already have them", not "there are none".
      if (response.tracks) setTracks(response.tracks)
      setUntagged(false)
      setLoaded(true)
    } catch {
      if (!live.current || current.current !== asked) return
      setUntagged(true)
      setLoaded(true)
    } finally {
      if (inFlight.current === asked) inFlight.current = null
    }
  }, [])

  useEffect(() => {
    // Another host, or none: the last drive's songs go.
    revision.current = 0
    inFlight.current = null
    setTracks(null)
    setLoaded(false)
    setReading(false)
    setUntagged(false)
    if (host) void load()
  }, [host, load])

  // The collections changing is the host's word that the songs may have:
  // the same announcement brings both.
  useEffect(() => {
    if (host) void load()
  }, [files, host, load])

  // While the host reads tags it has nothing to announce until it is done.
  useEffect(() => {
    if (!reading) return undefined
    const timer = setInterval(() => void load(), 2_000)
    return () => clearInterval(timer)
  }, [reading, load])

  const songs = useMemo(
    () => (untagged || tracks === null ? files.map(songFromFile) : tracks.map(songOf)),
    [untagged, tracks, files],
  )
  const albums = useMemo(() => albumsOf(songs), [songs])
  const artists = useMemo(() => artistsOf(albums), [albums])

  return {
    songs,
    albums,
    artists,
    reading,
    loaded,
    untagged,
    refresh: useCallback(() => void load(), [load]),
  }
}
