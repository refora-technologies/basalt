import { useCallback, useMemo, useState } from 'react'
import { isMobileShell } from '@/lib/platform'
import { itemQuality } from '@/lib/quality'
import { QualityTag } from './QualityTag'
import { AnimatePresence, motion } from 'framer-motion'
import { Clapperboard, Loader2, Play, Tv } from 'lucide-react'
import {
  CONFIDENT,
  isFinished,
  type LibraryEpisode,
  type LibraryItem,
  type Watched,
} from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import { Poster } from './Poster'
import { subtitleBadge, subtitleTitle } from '@/lib/subtitles'
import { ContinueWatching, resumable, type Resumable } from './ContinueWatching'
import { useLongPress } from '@/lib/useLongPress'
import { SeriesPage } from './SeriesPage'

/**
 * Films and series, as a wall of posters.
 *
 * Real artwork when the host has downloaded it, and one drawn from the title
 * when it has not — see [`Poster`]. The second is the default, because
 * downloading means telling TMDb every title on the drive and that is opt-in.
 */
export function LibraryView({
  kind,
  items,
  enabled,
  known,
  error,
  onRetry,
  scanning,
  watched,
  continueWatching,
  playing,
  onPlay,
  onForget,
  onContinueMore,
  onItemMore,
  onEpisodeMore,
  mediaBase = '',
}: {
  kind: 'film' | 'series'
  items: LibraryItem[]
  enabled: boolean
  /** Whether the host has answered: until then `enabled` is only a default. */
  known: boolean
  /** Why the host's answer did not come, if it did not. */
  error: string | null
  onRetry: () => void
  scanning: boolean
  /** How far through each file, by vault path. */
  watched: Map<string, Watched>
  /** Everything part-watched, newest first, for the row at the top. */
  continueWatching: Watched[]
  /**
   * Whether the player is up.
   *
   * The episode list is a full-screen sheet, and it used to stay on screen
   * over the player — you picked an episode and then watched it from behind
   * the list you picked it from. Hidden rather than closed, so dismissing the
   * player puts you back on the same series where you left off.
   */
  playing: boolean
  onPlay: (path: string) => void
  onForget: (path: string) => void
  /** On a phone: a Continue watching card's ⋮ or long press. */
  onContinueMore?: (entry: Resumable) => void
  /**
   * On a phone: a long press on a poster, or on an episode. What a computer
   * says in tooltips over the badges (which subtitles, a match that may be
   * wrong) is said there instead, as nothing hovers on a phone.
   */
  onItemMore?: (item: LibraryItem) => void
  onEpisodeMore?: (item: LibraryItem, episode: LibraryEpisode, season: number) => void
  /** Where the host's pictures come from, for each episode's picture. */
  mediaBase?: string
}): React.JSX.Element {
  const [open, setOpen] = useState<LibraryItem | null>(null)

  /**
   * How far through an item is, for the bar across its poster.
   *
   * For a series that is whichever episode is part-watched — which is what
   * makes a show in Continue watching resume rather than start again.
   */
  const progressOf = useCallback(
    (item: LibraryItem): number => {
      if (item.kind === 'film') {
        return item.path ? (watched.get(item.path)?.fraction ?? 0) : 0
      }
      const partial = item.seasons
        .flatMap((season) => season.episodes)
        .map((episode) => watched.get(episode.path))
        .find((entry) => entry && !isFinished(entry) && entry.fraction > 0)
      return partial?.fraction ?? 0
    },
    [watched],
  )

  // Only what belongs to this section: films on Movies, series on TV Series.
  const carryOn = useMemo(
    () => resumable(items, continueWatching),
    [items, continueWatching],
  )

  // Newest first: what you just added is what you came to watch.
  const ordered = useMemo(
    () => [...items].sort((a, b) => b.added - a.added || a.title.localeCompare(b.title)),
    [items],
  )

  // "Not switched on" only once the host has said so. Before that the
  // question is still out, or did not get through, and saying it was off
  // sent people to a host where it was on.
  if (!enabled) {
    if (known) return <Unavailable kind={kind} />
    if (error) return <Unanswered kind={kind} error={error} onRetry={onRetry} />
    return (
      <Centered>
        <Loader2 size={16} className="animate-spin text-textFaint" />
        <p className="text-[12px] text-textFaint">Loading…</p>
      </Centered>
    )
  }

  if (ordered.length === 0) {
    return scanning ? (
      <Centered>
        <Loader2 size={16} className="animate-spin text-textFaint" />
        <p className="text-[12px] text-textFaint">Finding films and series on the drive…</p>
      </Centered>
    ) : (
      <Centered>
        <span className="text-textFaint">
          {kind === 'film' ? <Clapperboard size={20} /> : <Tv size={20} />}
        </span>
        <p className="text-[13px] text-textDim">
          No {kind === 'film' ? 'films' : 'series'} recognised yet.
        </p>
        <p className="max-w-[320px] text-center text-[11.5px] leading-relaxed text-textFaint">
          Everything on the drive is still in Files. Names like{' '}
          <span className="font-mono">Arrival (2016)</span> or{' '}
          <span className="font-mono">Show/Season 01/S01E01</span> are the ones it
          recognises.
        </p>
      </Centered>
    )
  }

  return (
    // A phone's own margins, and room at the foot so the last row clears the
    // edge; the desktop's roomier padding from the small breakpoint up.
    <div className="h-full overflow-y-auto px-4 pb-8 pt-3 sm:px-7 sm:py-6">
      {/* A scan running over an existing library says so without hiding it. */}
      <AnimatePresence>
        {scanning && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mb-4 flex items-center gap-2 text-[11.5px] text-textFaint">
              <Loader2 size={12} className="animate-spin" />
              Checking the drive for changes…
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ContinueWatching
        entries={carryOn}
        onPlay={onPlay}
        onForget={onForget}
        onMore={onContinueMore}
      />

      {/* Two to a row on a phone, whatever its display size: a column count
          worked out from a minimum width fell to one on phones set to show
          things larger. Wider screens fit as many as there is room for. */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))] sm:gap-x-4 sm:gap-y-6">
        {ordered.map((item, index) => (
          <Card
            key={item.id}
            item={item}
            index={index}
            progress={progressOf(item)}
            onOpen={() => {
              if (item.kind === 'series') setOpen(item)
              else if (item.path) onPlay(item.path)
            }}
            onMore={TOUCH && onItemMore ? () => onItemMore(item) : undefined}
          />
        ))}
      </div>

      <AnimatePresence>
        {open && !playing && (
          <SeriesPage
            item={open}
            watched={watched}
            mediaBase={mediaBase}
            onClose={() => setOpen(null)}
            onPlay={onPlay}
            onEpisodeMore={TOUCH ? onEpisodeMore : undefined}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">{children}</div>
  )
}

function Unavailable({ kind }: { kind: 'film' | 'series' }): React.JSX.Element {
  return (
    <Centered>
      <span className="text-textFaint">
        {kind === 'film' ? <Clapperboard size={20} /> : <Tv size={20} />}
      </span>
      <p className="text-[13px] text-textDim">This is turned off.</p>
      <p className="max-w-[340px] text-center text-[11.5px] leading-relaxed text-textFaint">
        {/* Said plainly, because it is not this app's decision to make: the
            host is the machine whose drive would be read. */}
        Turn on <span className="text-textDim">Recognise films and series</span> in
        Manage host, or in Basalt Host on the computer with the drive.
      </p>
    </Centered>
  )
}

function Unanswered({
  kind,
  error,
  onRetry,
}: {
  kind: 'film' | 'series'
  error: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <Centered>
      <span className="text-textFaint">
        {kind === 'film' ? <Clapperboard size={20} /> : <Tv size={20} />}
      </span>
      <p className="text-[13px] text-textDim">
        Could not get the {kind === 'film' ? 'films' : 'series'} from the host.
      </p>
      <p className="max-w-[340px] text-center text-[11.5px] leading-relaxed text-textFaint">
        {error.charAt(0).toUpperCase() + error.slice(1)}
      </p>
      <button
        onClick={onRetry}
        className="rounded-md px-3 py-1.5 text-[12px] text-textDim transition-colors hover:bg-white/[0.05] hover:text-text"
      >
        Try again
      </button>
    </Centered>
  )
}

function Card({
  item,
  index,
  progress,
  onOpen,
  onMore,
}: {
  item: LibraryItem
  index: number
  /** 0-1, drawn as a bar across the bottom of the poster. */
  progress: number
  onOpen: () => void
  /** A long press, on a phone: see [`LibraryView`]'s `onItemMore`. */
  onMore?: () => void
}): React.JSX.Element {
  const episodes = item.seasons.reduce((total, s) => total + s.episodes.length, 0)
  const quality = itemQuality(item)
  const press = useLongPress(() => onMore?.(), onOpen)

  return (
    <motion.button
      // Animated in over the first screenful only: a library of two thousand
      // must not start two thousand animations to show twenty cards.
      initial={index < 24 ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index, 18) * 0.02, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3 }}
      {...(onMore ? press : { onClick: onOpen })}
      className="group block select-none text-left"
      // Cards far off screen are neither laid out nor painted until they come
      // near, so a long library scrolls like a short one.
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 320px' }}
    >
      <div data-focus-ring="" className="relative overflow-hidden rounded-md">
        <Poster
          title={item.title}
          year={item.year ?? undefined}
          id={item.id}
          hasArt={item.hasArt}
        />

        {/* The play affordance appears on hover; the poster is the subject. */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-basalt text-ink">
            <Play size={15} className="ml-0.5" fill="currentColor" />
          </span>
        </div>

        {/* A hairline across the bottom of the poster, the way every
            streaming service does it. Only when there is something to say: an
            empty bar on every card would be noise. */}
        {progress > 0.01 && progress < 0.94 && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/60">
            <div
              className="h-full bg-basalt"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}

        {/* Says a subtitle file exists for this, without claiming which
            languages — the player reads that from the file when it opens it. */}
        {subtitleBadge(item) && (
          <span
            title={
              item.kind === 'film'
                ? subtitleTitle(item.subtitles)
                : 'Some episodes have subtitle files on the drive'
            }
            className="absolute right-2 top-2 rounded-[4px] bg-black/70 px-1.5 py-[2px] font-mono text-[8.5px] uppercase tracking-[0.1em] text-textDim"
          >
            {subtitleBadge(item)}
          </span>
        )}

        {/* What the picture is, then whether the match itself is a guess —
            side by side, so neither covers the other. */}
        {(quality || item.confidence < CONFIDENT) && (
          <div className="absolute left-2 top-2 flex items-center gap-1">
            <QualityTag quality={quality} />
            {item.confidence < CONFIDENT && (
              <span
                title="Matched by its file name, so it may be wrong"
                className="rounded-[4px] bg-black/70 px-1.5 py-[2px] font-mono text-[8.5px] uppercase tracking-[0.1em] text-textDim"
              >
                a guess
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 px-0.5">
        <div className="truncate text-[12.5px] font-medium text-text">{item.title}</div>
        <div className="tnum mt-0.5 font-mono text-[10px] text-textFaint">
          {item.kind === 'series'
            ? `${item.seasons.length} ${item.seasons.length === 1 ? 'season' : 'seasons'} · ${episodes} ep`
            : [item.year, formatBytes(item.size)].filter(Boolean).join(' · ')}
        </div>
      </div>
    </motion.button>
  )
}

/** On a phone, where long presses stand in for what hovering shows. */
const TOUCH = isMobileShell()

