import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { AppModel } from '@/App'
import type { Listening } from '@/lib/api'
import { type Song, isSong, songFromFile } from '@/lib/music'
import { useMusicPlayer } from '@/lib/musicPlayer'
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

/** Continue listening, kept as the app's model keeps it. */
export function keepListening(model: AppModel): (listening: Listening) => void {
  return model.musicMine.setListening
}
