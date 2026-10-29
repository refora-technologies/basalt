import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { AppModel } from '@/App'
import { android } from '@/lib/android'
import { api, type Listening } from '@/lib/api'
import { type Song, isSong, songFromFile } from '@/lib/music'
import { useMusicClock, useMusicPlayer } from '@/lib/musicPlayer'
import { next as nextOf } from '@/lib/queue'
import {
  type NowPlayingInfo,
  claimPress,
  clearNowPlaying,
  needsTelling,
  onSystemMedia,
  showNowPlaying,
} from '@/lib/systemMedia'
import { VIEW_THUMB, thumbUrl } from '@/lib/thumbs'
import { fileToEntry } from '@/lib/useCollections'
import { newPlaylistId } from '@/lib/useMusicMine'

import type { MusicLayout, MusicSectionProps } from './MusicSection'
import type { NowPlayingProps } from './NowPlaying'

/**
 * What the music screens, the bar and the full player are given: the songs,
 * likes (a song's star), playlists, and Continue listening, from the app's
 * model. One place for phone, computer and TV.
 */
export function useMusicProps(
  model: AppModel,
  layout: MusicLayout,
  query: string,
): MusicSectionProps & NowPlayingProps {
  const { music, musicMine, stars, mediaBase, setPrompt, confirm } = model
  const player = useMusicPlayer()

  const songsByPath = useMemo(() => new Map(music.songs.map((s) => [s.path, s])), [music.songs])
  const songOf = useCallback(
    (path: string): Song => songsByPath.get(path) ?? songFromFile({ path, size: 0, mtime: 0 }),
    [songsByPath],
  )

  const onLike = useCallback(
    (song: Song, like: boolean) => {
      if (stars.isStarred(song.path) === like) return
      stars.toggle([{ ...fileToEntry({ path: song.path, size: song.size, mtime: song.mtime }) }])
    },
    [stars],
  )

  const { playlists, setPlaylists } = musicMine
  const now = (): number => Math.floor(Date.now() / 1000)

  const onNewPlaylist = useCallback(
    (songs: string[]) =>
      setPrompt({
        title: 'New playlist',
        value: `My playlist ${playlists.length + 1}`,
        confirmLabel: 'Create',
        select: 'all',
        onConfirm: (name) => {
          const named = name.trim()
          if (!named) return
          setPlaylists([...playlists, { id: newPlaylistId(), name: named, songs, created: now(), updated: now() }])
        },
      }),
    [playlists, setPlaylists, setPrompt],
  )

  const onAddToPlaylist = useCallback(
    (id: string, songs: string[]) =>
      setPlaylists(
        playlists.map((p) =>
          p.id === id ? { ...p, songs: [...p.songs, ...songs.filter((s) => !p.songs.includes(s))], updated: now() } : p,
        ),
      ),
    [playlists, setPlaylists],
  )

  const onRenamePlaylist = useCallback(
    (id: string) => {
      const playlist = playlists.find((p) => p.id === id)
      if (!playlist) return
      setPrompt({
        title: 'Rename playlist',
        value: playlist.name,
        confirmLabel: 'Rename',
        select: 'all',
        onConfirm: (name) => {
          const named = name.trim()
          if (named) setPlaylists(playlists.map((p) => (p.id === id ? { ...p, name: named, updated: now() } : p)))
        },
      })
    },
    [playlists, setPlaylists, setPrompt],
  )

  const onDeletePlaylist = useCallback(
    (id: string) => {
      const playlist = playlists.find((p) => p.id === id)
      if (!playlist) return
      void confirm({
        title: `Delete ${playlist.name}?`,
        message: 'The playlist goes from every device. The songs stay on the drive.',
        confirmLabel: 'Delete',
        danger: true,
      }).then((yes) => {
        if (yes) setPlaylists(playlists.filter((p) => p.id !== id))
      })
    },
    [playlists, setPlaylists, confirm],
  )

  const onRemoveFromPlaylist = useCallback(
    (id: string, path: string) =>
      setPlaylists(
        playlists.map((p) => (p.id === id ? { ...p, songs: p.songs.filter((s) => s !== path), updated: now() } : p)),
      ),
    [playlists, setPlaylists],
  )

  const onResume = useCallback(() => {
    if (musicMine.listening) player?.resume(musicMine.listening)
  }, [musicMine.listening, player])

  // A photo of somebody else of the same name: taken down by whoever manages
  // the host, for every device, and not looked for again.
  const canManage = model.vault.status?.canManage === true
  const refresh = music.refresh
  const onWrongPhoto = useCallback(
    (name: string) =>
      void confirm({
        title: `Remove this photo of ${name}?`,
        message: 'For when it is somebody else of the same name. Their album cover shows instead, on every device, and no photo is looked for again.',
        confirmLabel: 'Remove photo',
        danger: true,
      }).then((yes) => {
        if (yes) void api.manage({ do: 'removeArtistPhoto', name }).then(refresh, () => {})
      }),
    [confirm, refresh],
  )

  return {
    music,
    base: mediaBase,
    layout,
    query,
    liked: stars.paths,
    onLike,
    playlists,
    onNewPlaylist,
    onAddToPlaylist,
    onRenamePlaylist,
    onDeletePlaylist,
    onRemoveFromPlaylist,
    listening: musicMine.listening,
    onResume,
    onWrongPhoto: canManage ? onWrongPhoto : undefined,
    songOf,
  }
}

/**
 * Keeps the music player and the film player out of each other's way. A
 * song opened from anywhere — Files, Recent, a search — plays in the music
 * player, with the songs beside it in its folder after it; opening a film
 * stops the music.
 */
export function MusicBridge({ model }: { model: AppModel }): null {
  const player = useMusicPlayer()
  const { playing, setPlaying, collections } = model
  const files = collections.collections.music
  const latest = useRef(player)
  latest.current = player

  useEffect(() => {
    const music = latest.current
    if (!playing || !music) return
    if (isSong(playing.id)) {
      const folder = playing.id.slice(0, Math.max(0, playing.id.lastIndexOf('/')))
      const beside = files
        .filter((f) => f.path.slice(0, Math.max(0, f.path.lastIndexOf('/'))) === folder)
        .map((f) => f.path)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      const songs = beside.includes(playing.id) ? beside : [playing.id]
      setPlaying(null)
      music.play(songs, songs.indexOf(playing.id), folder.split('/').pop() || 'Files')
    } else if (music.queue) {
      music.stop()
    }
  }, [playing, setPlaying, files])

  return null
}

/** After this long paused, Android may stop keeping the app running for it. */
const PAUSED_HOLD_MS = 10 * 60 * 1000

/**
 * The song playing, told to the system: the lock screen, the notification's
 * player and the Now Bar on Android; the media controls on Windows and on a
 * Linux desktop. Their buttons move the player as its own do. On Android it
 * also keeps the app running with the screen off while music plays, so the
 * next song still starts.
 */
export function SystemMedia({ model }: { model: AppModel }): null {
  const player = useMusicPlayer()
  const clock = useMusicClock()
  const { music, mediaBase } = model
  const queue = player?.queue ?? null
  const current = player?.current ?? null
  const paused = player?.paused ?? true

  const song = useMemo((): Song | null => {
    if (!current) return null
    return music.songs.find((s) => s.path === current) ?? songFromFile({ path: current, size: 0, mtime: 0 })
  }, [current, music.songs])

  const info = useMemo((): NowPlayingInfo | null => {
    if (!song || !queue) return null
    const cover = song.cover && mediaBase ? thumbUrl(mediaBase, song.path, song.mtime, VIEW_THUMB) : ''
    return {
      title: song.title,
      artist: song.artist,
      album: song.album,
      cover: cover || null,
      duration: clock.duration || (song.durationMs ?? 0) / 1000,
      position: clock.position,
      playing: !paused,
      canPrevious: true,
      canNext: nextOf(queue) !== null,
    }
  }, [song, queue, mediaBase, clock.duration, clock.position, paused])

  // Told when something changes, not on every tick.
  const shown = useRef<{ info: NowPlayingInfo; at: number } | null>(null)
  useEffect(() => {
    if (!info) {
      if (shown.current) {
        shown.current = null
        void clearNowPlaying().catch(() => {})
      }
      return
    }
    const now = Date.now()
    if (!needsTelling(shown.current, info, now)) return
    shown.current = { info, at: now }
    void showNowPlaying(info).catch(() => {})
  }, [info])
  useEffect(() => () => void clearNowPlaying().catch(() => {}), [])

  // Android: kept running while it plays, and for a while paused.
  const title = song?.title ?? ''
  const artist = song?.artist ?? ''
  const hasQueue = queue !== null
  const playing = hasQueue && !paused
  useEffect(() => {
    if (!hasQueue) {
      void android.letGo('music')
      return undefined
    }
    void android.keepAlive('music', title, artist)
    if (playing) return undefined
    const timer = setTimeout(() => void android.letGo('music'), PAUSED_HOLD_MS)
    return () => clearTimeout(timer)
  }, [hasQueue, playing, title, artist])
  useEffect(() => () => void android.letGo('music'), [])

  // The system's buttons.
  const latest = useRef(player)
  latest.current = player
  useEffect(() => {
    if (!hasQueue) return undefined
    let stop: (() => void) | null = null
    let gone = false
    void onSystemMedia((press) => {
      const music = latest.current
      if (!music?.queue || !claimPress(press.action)) return
      switch (press.action) {
        case 'toggle':
          music.togglePause()
          break
        case 'play':
          if (music.paused) music.togglePause()
          break
        case 'pause':
          if (!music.paused) music.togglePause()
          break
        case 'next':
          music.next()
          break
        case 'previous':
          music.previous()
          break
        case 'stop':
          music.stop()
          break
        case 'seek':
          if (press.position >= 0) music.seek(press.position)
          break
      }
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [hasQueue])

  return null
}

/** Continue listening, kept as the app's model keeps it. */
export function keepListening(model: AppModel): (listening: Listening) => void {
  return model.musicMine.setListening
}
