import { useMemo, useState } from 'react'
import {
  ChevronDown,
  Heart,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react'

import { useBack } from '@/mobile/useBack'
import { type Song, formatDuration } from '@/lib/music'
import { useMusicClock, useMusicPlayer } from '@/lib/musicPlayer'
import { upNext } from '@/lib/queue'
import { cn } from '@/lib/utils'

import { Cover } from './Cover'
import type { MusicLayout } from './MusicSection'

/** What the bar and the full player need to know about the songs. */
export interface NowPlayingProps {
  base: string
  layout: MusicLayout
  /** Tags for a path; a song played from Files may not be in the library. */
  songOf: (path: string) => Song
  liked: Set<string>
  onLike: (song: Song, liked: boolean) => void
}

/**
 * The bar at the bottom while music plays: on a phone just above the tabs,
 * on a computer and a TV along the bottom of the window. Tap it for the full
 * player.
 */
export function MusicBar({ base, layout, songOf, liked, onLike }: NowPlayingProps): React.JSX.Element | null {
  const player = useMusicPlayer()
  const clock = useMusicClock()
  if (!player?.current) return null
  const song = songOf(player.current)
  const isLiked = liked.has(song.path)
  const fraction = clock.duration > 0 ? Math.min(1, clock.position / clock.duration) : 0

  if (layout === 'phone') {
    return (
      <div className="relative mx-2 mb-1.5 shrink-0">
        <div
          role="button"
          tabIndex={0}
          onClick={() => player.setExpanded(true)}
          className="relative flex h-14 items-center gap-2.5 overflow-hidden rounded-xl bg-[#1d1d21] pl-2 pr-1 shadow-[0_8px_26px_rgba(0,0,0,0.5)]"
        >
          <Cover base={base} path={song.cover ? song.path : null} mtime={song.mtime} name={song.album} label={false} className="w-10 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-text">{song.title}</div>
            <div className="truncate text-[11.5px] text-textFaint">{song.artist}</div>
          </div>
          <IconButton label={isLiked ? 'Unlike' : 'Like'} onClick={() => onLike(song, !isLiked)}>
            <Heart size={20} className={cn(isLiked && 'fill-current text-text')} />
          </IconButton>
          <IconButton label={player.paused ? 'Play' : 'Pause'} onClick={player.togglePause}>
            {player.paused ? <Play size={22} className="fill-current text-text" /> : <Pause size={22} className="fill-current text-text" />}
          </IconButton>
          <div className="absolute inset-x-2.5 bottom-0 h-[2px] overflow-hidden rounded-full bg-white/[0.12]">
            <div className="h-full bg-white" style={{ width: `${fraction * 100}%` }} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] items-center border-t border-line bg-[#0d0d0f] px-4',
        layout === 'tv' ? 'h-24' : 'h-[72px]',
      )}
      data-remote-scope=""
    >
      <button onClick={() => player.setExpanded(true)} className="flex min-w-0 items-center gap-3 text-left">
        <Cover base={base} path={song.cover ? song.path : null} mtime={song.mtime} name={song.album} label={false} className={cn('shrink-0 rounded-md', layout === 'tv' ? 'w-16' : 'w-12')} />
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-text">{song.title}</span>
          <span className="block truncate text-[12px] text-textFaint">{song.artist}</span>
        </span>
      </button>
      <div className="flex flex-col items-center gap-1.5">
        <Controls compact />
        <Scrubber compact />
      </div>
      <div className="flex items-center justify-end gap-1 text-textDim">
        <IconButton label={isLiked ? 'Unlike' : 'Like'} onClick={() => onLike(song, !isLiked)}>
          <Heart size={17} className={cn(isLiked && 'fill-current text-text')} />
        </IconButton>
        <IconButton label="Queue" onClick={() => player.setExpanded(true)}>
          <ListMusic size={17} />
        </IconButton>
        {layout === 'wide' && <Volume />}
      </div>
    </div>
  )
}

/** The full player: the cover, the song, its place in it, and the queue. */
export function NowPlaying({ base, layout, songOf, liked, onLike }: NowPlayingProps): React.JSX.Element | null {
  const player = useMusicPlayer()
  const [queueOpen, setQueueOpen] = useState(false)
  const open = !!player?.expanded && !!player.current
  useBack(open, () => {
    if (queueOpen) setQueueOpen(false)
    else player?.setExpanded(false)
    return true
  })
  const coming = useMemo(() => (player?.queue ? upNext(player.queue) : []), [player?.queue])
  if (!open || !player?.current) return null
  const song = songOf(player.current)
  const isLiked = liked.has(song.path)
  const wide = layout !== 'phone'
  const hue = hueOf(song.album)

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col"
      style={{ background: `linear-gradient(180deg, hsl(${hue} 18% 19%), #0B0B0C 64%)` }}
      data-remote-scope=""
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-3 pt-[env(safe-area-inset-top)]">
        <IconButton label="Close the player" onClick={() => player.setExpanded(false)}>
          <ChevronDown size={26} />
        </IconButton>
        <div className="min-w-0 text-center">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-textFaint">Playing from</div>
          <div className="truncate text-[13px] font-semibold text-text">{player.queue?.from}</div>
        </div>
        <IconButton label="Queue" onClick={() => setQueueOpen((q) => !q)}>
          <ListMusic size={22} className={cn(queueOpen && 'text-text')} />
        </IconButton>
      </div>

      <div className={cn('flex min-h-0 flex-1', wide ? 'items-center justify-center gap-14 px-14' : 'flex-col px-7')}>
        {(!queueOpen || wide) && (
          <div className={cn('flex justify-center', wide ? 'w-[min(44vh,420px)]' : 'min-h-0 flex-1 items-center')}>
            <Cover
              base={base}
              path={song.cover ? song.path : null}
              mtime={song.mtime}
              name={song.album}
              size={800}
              className={cn('shadow-[0_24px_70px_rgba(0,0,0,0.6)]', wide ? 'w-full' : 'w-full max-w-[360px]')}
            />
          </div>
        )}
        {queueOpen && (
          <div className={cn('min-h-0 overflow-y-auto', wide ? 'h-[60vh] w-[380px]' : 'mt-2 flex-1')}>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-textFaint">Next up</div>
            {coming.length === 0 && <p className="text-[13px] text-textFaint">Nothing after this song.</p>}
            {coming.map((path, i) => {
              const next = songOf(path)
              return (
                <div key={`${i}-${path}`} className="flex h-12 items-center gap-3">
                  <Cover base={base} path={next.cover ? next.path : null} mtime={next.mtime} name={next.album} label={false} className="w-9 shrink-0 rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] text-text">{next.title}</div>
                    <div className="truncate text-[11.5px] text-textFaint">{next.artist}</div>
                  </div>
                  <IconButton label={`Remove ${next.title} from the queue`} onClick={() => player.removeUpNext(i)}>
                    <X size={16} />
                  </IconButton>
                </div>
              )
            })}
          </div>
        )}

        <div className={cn('shrink-0', wide ? 'w-[min(52vw,520px)]' : 'pb-[max(28px,env(safe-area-inset-bottom))] pt-4')}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-[22px] font-bold tracking-[-0.02em] text-text">{song.title}</div>
              <div className="truncate text-[14px] text-textDim">{song.artist}</div>
            </div>
            <IconButton label={isLiked ? 'Unlike' : 'Like'} onClick={() => onLike(song, !isLiked)}>
              <Heart size={24} className={cn(isLiked && 'fill-current text-text')} />
            </IconButton>
          </div>
          <div className="mt-5">
            <Scrubber />
          </div>
          <div className="mt-3">
            <Controls />
          </div>
        </div>
      </div>
    </div>
  )
}

function Controls({ compact }: { compact?: boolean }): React.JSX.Element | null {
  const player = useMusicPlayer()
  if (!player?.queue) return null
  const { queue } = player
  const size = compact ? 18 : 28
  return (
    <div className={cn('flex items-center', compact ? 'gap-3' : 'justify-between')}>
      <IconButton label={queue.shuffle ? 'Shuffle off' : 'Shuffle on'} onClick={() => player.setShuffle(!queue.shuffle)}>
        <Shuffle size={compact ? 16 : 22} className={cn(queue.shuffle ? 'text-text' : 'text-textFaint')} />
        {queue.shuffle && <Dot />}
      </IconButton>
      <IconButton label="Previous" onClick={player.previous}>
        <SkipBack size={size} className="fill-current text-text" />
      </IconButton>
      <button
        data-remote-first=""
        onClick={player.togglePause}
        aria-label={player.paused ? 'Play' : 'Pause'}
        className={cn(
          'flex items-center justify-center rounded-full bg-white text-black transition-transform active:scale-95',
          compact ? 'h-9 w-9' : 'h-[68px] w-[68px]',
        )}
      >
        {player.paused ? (
          <Play size={compact ? 16 : 30} className="ml-0.5 fill-current" />
        ) : (
          <Pause size={compact ? 16 : 30} className="fill-current" />
        )}
      </button>
      <IconButton label="Next" onClick={player.next}>
        <SkipForward size={size} className="fill-current text-text" />
      </IconButton>
      <IconButton label={`Repeat: ${queue.repeat}`} onClick={player.cycleRepeat}>
        {queue.repeat === 'one' ? (
          <Repeat1 size={compact ? 16 : 22} className="text-text" />
        ) : (
          <Repeat size={compact ? 16 : 22} className={cn(queue.repeat === 'all' ? 'text-text' : 'text-textFaint')} />
        )}
        {queue.repeat !== 'off' && <Dot />}
      </IconButton>
    </div>
  )
}

/** A small dot under a control that is on. */
function Dot(): React.JSX.Element {
  return <span className="absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-text" />
}

/** Where the song is: drag or click to move, with the times either side. */
function Scrubber({ compact }: { compact?: boolean }): React.JSX.Element {
  const player = useMusicPlayer()
  const clock = useMusicClock()
  const [held, setHeld] = useState<number | null>(null)
  const at = held ?? clock.position
  const total = clock.duration
  return (
    <div className={cn('flex w-full items-center', compact ? 'gap-2.5' : 'flex-col gap-1.5')}>
      {compact && <Time value={at} />}
      <input
        type="range"
        min={0}
        max={Math.max(1, total)}
        step={0.5}
        value={Math.min(at, total || 1)}
        aria-label="Position in the song"
        onChange={(e) => setHeld(Number(e.target.value))}
        onPointerUp={() => {
          if (held !== null) player?.seek(held)
          setHeld(null)
        }}
        onKeyUp={() => {
          if (held !== null) player?.seek(held)
          setHeld(null)
        }}
        className="music-range w-full"
        style={{ ['--fill' as string]: `${total > 0 ? (at / total) * 100 : 0}%` }}
      />
      {compact ? (
        <Time value={total} />
      ) : (
        <div className="flex w-full justify-between">
          <Time value={at} />
          <Time value={Math.max(0, total - at)} minus />
        </div>
      )}
    </div>
  )
}

function Time({ value, minus }: { value: number; minus?: boolean }): React.JSX.Element {
  return (
    <span className="w-10 shrink-0 text-center font-mono text-[11px] tabular-nums text-textFaint">
      {minus ? '-' : ''}
      {formatDuration(value * 1000) || '0:00'}
    </span>
  )
}

function Volume(): React.JSX.Element {
  const clock = useMusicClock()
  return (
    <div className="ml-1 flex items-center gap-2">
      <Volume2 size={16} />
      <input
        type="range"
        min={0}
        max={100}
        value={clock.volume}
        aria-label="Volume"
        onChange={(e) => clock.setVolume(Number(e.target.value))}
        className="music-range w-24"
        style={{ ['--fill' as string]: `${clock.volume}%` }}
      />
    </div>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-textDim transition-colors hover:text-text focus-visible:bg-white/[0.08]"
    >
      {children}
    </button>
  )
}

function hueOf(name: string): number {
  let h = 2166136261
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0) % 360
}
