import { useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
  VolumeX,
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
          {/* Paused, the bar can be put away: the music stops, and Continue
              listening keeps where it was. */}
          {player.paused && (
            <IconButton label="Close the player" onClick={player.stop}>
              <X size={20} />
            </IconButton>
          )}
          <div className="absolute inset-x-2.5 bottom-0 h-[2px] overflow-hidden rounded-full bg-white/[0.12]">
            {clock.duration > 0 ? (
              <div className="h-full bg-white" style={{ width: `${fraction * 100}%` }} />
            ) : (
              <Loading thin />
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      // `relative`, with a place in the stacking: the window's backdrop is a
      // fixed layer, and an ordinary block after it is painted underneath it.
      // Without this the title, the play button, the progress and the volume
      // were laid out but never seen; only the bar's own positioned buttons
      // showed through.
      className={cn(
        'relative z-[1] grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] items-center border-t border-line bg-[#0d0d0f] px-4',
        layout === 'tv' ? 'h-24' : 'h-[72px]',
      )}
      // Not a scope of its own for the remote: the bar is part of the page,
      // and as one it held the remote's focus, so nothing above it could be
      // reached while music played.
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
        {/* Put away: the music stops, and Continue listening keeps where it was. */}
        <IconButton label="Close the player" onClick={player.stop}>
          <X size={17} />
        </IconButton>
      </div>
    </div>
  )
}

/** The full player: the cover, the song, its place in it, and the queue. */
export function NowPlaying({
  base,
  layout,
  songOf,
  liked,
  onLike,
  belowTitleBar,
}: NowPlayingProps & {
  /** In the computer's window: the title bar stays, with its buttons, and the
   *  window can still be moved, made smaller or closed. */
  belowTitleBar?: boolean
}): React.JSX.Element | null {
  const player = useMusicPlayer()
  const [queueOpen, setQueueOpen] = useState(false)
  const open = !!player?.expanded && !!player.current
  useBack(open, () => {
    if (queueOpen) setQueueOpen(false)
    else player?.setExpanded(false)
    return true
  })
  const coming = useMemo(() => (player?.queue ? upNext(player.queue) : []), [player?.queue])
  return (
    <AnimatePresence>
      {open && player?.current && (
        <FullPlayer
          key="full"
          base={base}
          layout={layout}
          songOf={songOf}
          liked={liked}
          onLike={onLike}
          belowTitleBar={belowTitleBar}
          queueOpen={queueOpen}
          setQueueOpen={setQueueOpen}
          coming={coming}
        />
      )}
    </AnimatePresence>
  )
}

/** How the full player comes up from the bar and goes back into it. */
const SHEET = { duration: 0.42, ease: [0.32, 0.72, 0, 1] as const }

function FullPlayer({
  base,
  layout,
  songOf,
  liked,
  onLike,
  belowTitleBar,
  queueOpen,
  setQueueOpen,
  coming,
}: NowPlayingProps & {
  belowTitleBar?: boolean
  queueOpen: boolean
  setQueueOpen: React.Dispatch<React.SetStateAction<boolean>>
  coming: string[]
}): React.JSX.Element | null {
  const player = useMusicPlayer()
  if (!player?.current) return null
  const song = songOf(player.current)
  const isLiked = liked.has(song.path)
  const wide = layout !== 'phone'
  const hue = hueOf(song.album)

  return (
    <motion.div
      // Up from the bar, and back down into it.
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={SHEET}
      className={cn('fixed inset-x-0 bottom-0 z-40 flex flex-col', belowTitleBar ? 'top-9' : 'top-0')}
      style={{
        background: `linear-gradient(180deg, hsl(${hue} 18% 19%), #0B0B0C 64%)`,
        // Clear of a phone's status bar, its gesture bar and, turned on its
        // side, its cut-out: the sizes Android gives, else the page's own.
        paddingTop: 'var(--inset-top, env(safe-area-inset-top, 0px))',
        paddingLeft: 'var(--inset-left, env(safe-area-inset-left, 0px))',
        paddingRight: 'var(--inset-right, env(safe-area-inset-right, 0px))',
      }}
      data-remote-scope=""
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
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

        <div
          className={cn('shrink-0', wide ? 'w-[min(52vw,520px)]' : 'pt-4')}
          style={wide ? undefined : { paddingBottom: 'calc(var(--inset-bottom, env(safe-area-inset-bottom, 0px)) + 28px)' }}
        >
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
    </motion.div>
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
        // Where the remote starts in the full player; the bar's is not, or
        // every page would open with the focus on it.
        data-remote-first={compact ? undefined : ''}
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
  // Not known until the song has opened: a light along the line meanwhile.
  if (total <= 0) {
    return (
      <div className={cn('flex w-full items-center', compact ? 'gap-2.5' : 'flex-col gap-1.5')}>
        {compact && <Time value={null} />}
        <Loading />
        {compact ? (
          <Time value={null} />
        ) : (
          <div className="flex w-full justify-between">
            <Time value={null} />
            <Time value={null} />
          </div>
        )}
      </div>
    )
  }
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

/** A time, or a dash while it is not known yet. */
function Time({ value, minus }: { value: number | null; minus?: boolean }): React.JSX.Element {
  return (
    <span className="w-10 shrink-0 text-center font-mono text-[11px] tabular-nums text-textFaint">
      {value === null ? '\u2013:\u2013\u2013' : `${minus ? '-' : ''}${formatDuration(value * 1000) || '0:00'}`}
    </span>
  )
}

/** The line while a song is still loading. */
function Loading({ thin }: { thin?: boolean }): React.JSX.Element {
  return (
    <div
      role="progressbar"
      aria-label="Loading the song"
      className={cn('relative w-full overflow-hidden rounded-full bg-white/[0.12]', thin ? 'h-full' : 'my-[6px] h-1')}
    >
      <div className="music-loading absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  )
}

/** How much one notch of a mouse wheel turns the volume. */
const WHEEL_STEP = 5

function Volume(): React.JSX.Element {
  const clock = useMusicClock()
  // What it was before the speaker was clicked to mute, to go back to.
  const before = useRef(70)
  const set = (volume: number): void => clock.setVolume(Math.max(0, Math.min(100, Math.round(volume))))
  return (
    <div
      className="ml-1 flex items-center gap-2"
      // The wheel over the speaker or the slider: up is louder.
      onWheel={(e) => set(clock.volume + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP))}
    >
      <button
        type="button"
        aria-label={clock.volume === 0 ? 'Unmute' : 'Mute'}
        onClick={() => {
          if (clock.volume > 0) {
            before.current = clock.volume
            set(0)
          } else set(before.current || 70)
        }}
        className="text-textDim transition-colors hover:text-text"
      >
        {clock.volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
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
