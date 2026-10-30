import { useState } from 'react'
import { Disc3, Heart, ListEnd, ListMinus, ListPlus, ListStart, MicVocal, Plus } from 'lucide-react'

import type { Album, Song } from '@/lib/music'
import { useMusicPlayer } from '@/lib/musicPlayer'
import { cn } from '@/lib/utils'

import { Cover } from './Cover'
import type { MusicSectionProps } from './MusicSection'

export interface SongMenuTarget {
  song: Song
  /** What the list it was opened from plays from. */
  from: string
  album: Album | null
  /** Opened from a playlist's page: it can be taken out of it. */
  playlistId?: string
}

/**
 * What can be done with one song: from the bottom of a phone's screen, in
 * the middle of a computer's or a TV's.
 */
export function SongMenu({
  target,
  layout,
  base,
  liked,
  onLike,
  playlists,
  onNewPlaylist,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onClose,
  onOpenAlbum,
  onOpenArtist,
}: MusicSectionProps & {
  target: SongMenuTarget
  onClose: () => void
  onOpenAlbum: (album: Album) => void
  onOpenArtist: (name: string) => void
}): React.JSX.Element {
  const player = useMusicPlayer()
  const [choosing, setChoosing] = useState(false)
  const { song, album } = target
  const isLiked = liked.has(song.path)
  const phone = layout === 'phone'

  const done = (act: () => void) => () => {
    act()
    onClose()
  }

  return (
    <div
      className={cn('fixed inset-0 z-50 flex bg-black/55', phone ? 'items-end' : 'items-center justify-center')}
      onClick={onClose}
      data-remote-scope=""
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'border border-line bg-[#151517] shadow-[0_20px_60px_rgba(0,0,0,0.6)]',
          phone ? 'w-full rounded-t-3xl pb-6 pt-3' : 'w-[360px] rounded-2xl py-2',
        )}
      >
        {phone && <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/20" />}
        <div className="flex items-center gap-3 border-b border-line px-4 pb-3">
          <Cover base={base} path={song.cover ? song.path : null} mtime={song.mtime} name={song.album} label={false} className="w-12 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-text">{song.title}</div>
            <div className="truncate text-[12px] text-textFaint">
              {song.artist} · {song.album}
            </div>
          </div>
        </div>
        {choosing ? (
          <div className="max-h-[50vh] overflow-y-auto py-1">
            <Item
              icon={<Plus size={18} />}
              label="New playlist"
              first
              onClick={done(() => onNewPlaylist([song.path]))}
            />
            {playlists.map((playlist) => (
              <Item
                key={playlist.id}
                icon={<ListPlus size={18} />}
                label={playlist.name}
                onClick={done(() => onAddToPlaylist(playlist.id, [song.path]))}
              />
            ))}
          </div>
        ) : (
          <div className="py-1">
            <Item
              first
              icon={<ListStart size={18} />}
              label="Play next"
              onClick={done(() => (player?.queue ? player.playNext([song.path]) : player?.play([song.path], 0, target.from)))}
            />
            <Item
              icon={<ListEnd size={18} />}
              label="Add to queue"
              onClick={done(() => (player?.queue ? player.addToQueue([song.path]) : player?.play([song.path], 0, target.from)))}
            />
            <Item
              icon={<Heart size={18} className={cn(isLiked && 'fill-current')} />}
              label={isLiked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
              onClick={done(() => onLike(song, !isLiked))}
            />
            <Item icon={<ListPlus size={18} />} label="Add to playlist…" onClick={() => setChoosing(true)} />
            {target.playlistId && (
              <Item
                icon={<ListMinus size={18} />}
                label="Remove from this playlist"
                onClick={done(() => onRemoveFromPlaylist(target.playlistId!, song.path))}
              />
            )}
            {album && <Item icon={<Disc3 size={18} />} label="Go to album" onClick={() => onOpenAlbum(album)} />}
            <Item icon={<MicVocal size={18} />} label="Go to artist" onClick={() => onOpenArtist(song.artist)} />
          </div>
        )}
      </div>
    </div>
  )
}

function Item({
  icon,
  label,
  first,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  first?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      {...(first ? { 'data-remote-first': '' } : {})}
      onClick={onClick}
      className="flex h-12 w-full items-center gap-3.5 px-5 text-left text-[14px] text-text transition-colors hover:bg-white/[0.05] focus-visible:bg-white/[0.07]"
    >
      <span className="text-textDim">{icon}</span>
      {label}
    </button>
  )
}
