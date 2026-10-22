import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronDown, ChevronLeft, Play, RotateCcw } from 'lucide-react'
import {
  isFinished,
  type LibraryEpisode,
  type LibraryItem,
  type LibrarySeason,
  type Watched,
} from '@/lib/api'
import { episodeName } from '@/lib/episodeName'
import { isTv } from '@/lib/platform'
import { qualityOf } from '@/lib/quality'
import { seasonToShow } from '@/lib/seasonToShow'
import { subtitleTitle } from '@/lib/subtitles'
import { thumbUrl, VIEW_THUMB } from '@/lib/thumbs'
import { useLongPress } from '@/lib/useLongPress'
import { cn, formatBytes } from '@/lib/utils'
import { useBack } from '@/mobile/useBack'
import { Poster } from './Poster'
import { QualityTag } from './QualityTag'

/**
 * A series opened up: where you are, its seasons, and their episodes.
 *
 * A frame of the episode Continue plays runs across the top, with the
 * poster over it. Continue comes first, because carrying on is why most
 * people open a series. The season is a heading that opens a list of every
 * season, each saying how far through it you are, and the episodes are
 * pictures: a grid where there's room (a computer, a tablet, a TV, a phone
 * on its side), rows on a phone held upright.
 */
export interface SeriesProps {
  item: LibraryItem
  watched: Map<string, Watched>
  /** Where the host's pictures come from: see `useMediaBase`. Empty for none. */
  mediaBase: string
  onClose: () => void
  onPlay: (path: string) => void
  onEpisodeMore?: (item: LibraryItem, episode: LibraryEpisode, season: number) => void
}

export function SeriesPage(props: SeriesProps): React.JSX.Element {
  useBack(true, () => {
    props.onClose()
    return true
  })
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      className="fixed inset-0 z-50 bg-ink"
      data-no-swipe
      data-remote-scope=""
      onMouseDown={props.onClose}
    >
      <SeriesBody {...props} />
    </motion.div>
  )
}

/** The page's contents, filling what it is put in. */
function SeriesBody(props: SeriesProps): React.JSX.Element {
  const { item, watched, mediaBase } = props
  const [season, setSeason] = useState<LibrarySeason | undefined>(() => seasonToShow(item, watched))
  const wide = useWide()
  const tv = isTv()
  const next = useMemo(() => nextUp(item, watched), [item, watched])
  // The picture across the top: a frame of the episode Continue plays.
  const backdrop = next ? thumbUrl(mediaBase, next.episode.path, next.episode.added, VIEW_THUMB) : ''
  const p: Shared = { ...props, season, setSeason, wide, tv, next, backdrop }
  const several = item.seasons.length > 1

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden pb-16" onMouseDown={(e) => e.stopPropagation()}>
      {/* Tall enough on a phone that Back sits clear above the poster. */}
      <div className={cn('relative', wide ? 'h-[210px]' : 'h-[190px]')}>
        <Picture src={backdrop} className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink to-ink/20" />
        <Page p={p} className="relative">
          <Back onClose={props.onClose} />
        </Page>
      </div>

      <Page p={p} flush>
        <div className={cn('relative flex items-end gap-5', wide ? '-mt-[110px]' : '-mt-[80px]')}>
          <div
            className={cn(
              'shrink-0 overflow-hidden rounded-lg shadow-lift ring-1 ring-white/10',
              wide ? 'w-[150px]' : 'w-[100px]',
            )}
          >
            <Poster title={item.title} year={item.year ?? undefined} id={item.id} hasArt={item.hasArt} />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <Kicker item={item} wide={wide} />
            <h2
              className={cn(
                'mt-1.5 font-semibold leading-tight tracking-tighter text-text',
                wide ? 'text-[34px]' : 'text-[24px]',
              )}
            >
              {item.title}
            </h2>
          </div>
          {wide && !tv && next && (
            <div className="w-[320px] shrink-0 pb-1">
              <ContinueButton next={next} onPlay={props.onPlay} />
            </div>
          )}
        </div>
        {/* On a TV, under the title, so the remote goes down the page in
            order: Continue, the season, the episodes. */}
        {(!wide || tv) && next && (
          <div className={cn('mt-4', tv && 'w-[380px]')}>
            <ContinueButton next={next} onPlay={props.onPlay} />
          </div>
        )}

        {several ? <SeasonMenu {...p} /> : <SeasonTitle {...p} className="mt-8" />}
        {wide ? (
          <div
            className={cn(
              'mt-3 grid gap-x-4 gap-y-6',
              tv ? 'grid-cols-3' : 'grid-cols-[repeat(auto-fill,minmax(230px,1fr))]',
            )}
          >
            {season?.episodes.map((e) => <Card key={e.path} p={p} episode={e} />)}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-1">
            {season?.episodes.map((e) => <Row key={e.path} p={p} episode={e} />)}
          </div>
        )}
      </Page>
    </div>
  )
}

interface Shared extends SeriesProps {
  season: LibrarySeason | undefined
  setSeason: (s: LibrarySeason) => void
  wide: boolean
  tv: boolean
  next: Next | null
  backdrop: string
}

/**
 * The season as a heading that opens a list of every season: one line
 * where the seasons were a row of their own.
 */
function SeasonMenu(p: Shared): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const heading = useRef<HTMLButtonElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const close = (): void => {
    setOpen(false)
    heading.current?.focus()
  }
  useBack(open, () => {
    close()
    return true
  })
  // Opened, the highlight goes to the season showing, so a remote's OK and
  // arrows carry on from there.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }, [open])
  // The arrows stay in the list while it is open, rather than reaching the
  // episodes it covers.
  const arrows = (e: React.KeyboardEvent): void => {
    const options = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const at = options.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      options[Math.min(Math.max(at + step, 0), options.length - 1)]?.focus()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
    }
  }
  useEffect(() => {
    if (!open) return undefined
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  if (!p.season) return null
  return (
    <div ref={box} className="relative mt-8 w-fit">
      <button
        ref={heading}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="-ml-2 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.05]"
      >
        <ChevronDown size={18} className={cn('text-text transition-transform', open && 'rotate-180')} />
        <span className="text-[19px] font-semibold tracking-tight text-text">{seasonName(p.season)}</span>
        <span className="ml-1 font-mono text-[11px] text-textFaint">{progressLine(p.season, p.watched)}</span>
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          onKeyDown={arrows}
          className="absolute left-0 top-full z-20 mt-1.5 min-w-[280px] overflow-hidden rounded-xl border border-white/10 bg-panel2 py-1.5 shadow-lift"
        >
          {p.item.seasons.map((s) => {
            const chosen = s.number === p.season?.number
            const { done, total } = counts(s, p.watched)
            return (
              <button
                key={s.number}
                role="option"
                aria-selected={chosen}
                onClick={() => {
                  p.setSeason(s)
                  close()
                }}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.06]',
                  chosen && 'bg-white/[0.05]',
                )}
              >
                <span className="w-9 font-mono text-[12px] text-textFaint">
                  {s.number === 0 ? 'SP' : `S${pad(s.number)}`}
                </span>
                <span className={cn('flex-1 text-[14px]', chosen ? 'font-semibold text-text' : 'text-textDim')}>
                  {seasonName(s)}
                </span>
                <span className="font-mono text-[10.5px] text-textFaint">
                  {done === total && total > 0 ? 'Watched' : done > 0 ? `${done}/${total}` : `${total} ep`}
                </span>
                <span className="w-4">{chosen && <Check size={14} className="text-text" />}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Shared parts ───────────────────────────────────────────────────────────

function pagePad(p: Shared): string {
  return `calc(var(--inset-left, 0px) + ${p.tv ? 48 : p.wide ? 40 : 20}px)`
}

/**
 * The page's margins, clear of a phone's notch and a TV's edge. `flush`
 * for a part below the top, which needs no room for the status bar.
 */
function Page({
  p,
  flush,
  className,
  children,
}: {
  p: Shared
  flush?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn('mx-auto w-full', p.wide ? 'max-w-[1240px]' : 'max-w-[640px]', className)}
      style={{
        paddingTop: flush ? undefined : `calc(var(--inset-top, 0px) + ${p.wide ? 18 : 10}px)`,
        paddingLeft: pagePad(p),
        paddingRight: `calc(var(--inset-right, 0px) + ${p.tv ? 48 : p.wide ? 40 : 20}px)`,
      }}
    >
      {children}
    </div>
  )
}

function Back({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClose}
      className="-ml-2 flex w-fit items-center gap-1.5 rounded-md bg-black/25 px-2 py-1 text-[12px] text-textDim transition-colors hover:text-text"
    >
      <ChevronLeft size={14} />
      Back
    </button>
  )
}

/** The small line above a title: what it is, its year, its seasons, and on a wide screen its size. */
function Kicker({ item, wide }: { item: LibraryItem; wide: boolean }): React.JSX.Element {
  const seasons = item.seasons.filter((s) => s.number > 0).length
  return (
    <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-textDim">
      {['Series', item.year, `${seasons} ${seasons === 1 ? 'season' : 'seasons'}`, wide && formatBytes(item.size)]
        .filter(Boolean)
        .join(' · ')}
    </div>
  )
}

function SeasonTitle(p: Shared & { className?: string }): React.JSX.Element | null {
  if (!p.season) return null
  return (
    <div className={cn('flex items-baseline gap-3', p.className)}>
      <h3 className="text-[18px] font-semibold tracking-tight text-text">{seasonName(p.season)}</h3>
      <span className="font-mono text-[11px] text-textFaint">{progressLine(p.season, p.watched)}</span>
    </div>
  )
}

/** A picture that may not exist: `fallback`, or nothing, rather than a broken one. */
function Picture({
  src,
  className,
  fallback = null,
}: {
  src: string
  className?: string
  fallback?: React.ReactNode
}): React.JSX.Element | null {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  if (!src || broken) return <>{fallback}</>
  return <img src={src} alt="" draggable={false} onError={() => setBroken(true)} className={className} />
}

function ContinueButton({ next, onPlay }: { next: Next; onPlay: (path: string) => void }): React.JSX.Element {
  return (
    <button
      onClick={() => onPlay(next.episode.path)}
      data-remote-first=""
      className="relative flex w-full items-center gap-3 overflow-hidden rounded-xl bg-white px-4 py-3 text-left text-black transition-opacity hover:opacity-90"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-white">
        {next.kind === 'again' ? <RotateCcw size={15} /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-[14px] font-semibold">
          {next.kind === 'resume' ? 'Continue' : next.kind === 'again' ? 'Watch again' : 'Play'}
          <span className="font-mono text-[11.5px] font-normal text-black/55">{code(next.season, next.episode)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-black/60">{title(next.episode)}</span>
      </span>
      {next.kind === 'resume' && next.fraction > 0 && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/10">
          <span className="block h-full bg-black/70" style={{ width: `${Math.round(next.fraction * 100)}%` }} />
        </span>
      )}
    </button>
  )
}

/** An episode's picture, with how far through it is drawn along its foot. */
function Still({
  p,
  episode,
  className,
  small,
}: {
  p: Shared
  episode: LibraryEpisode
  className?: string
  /** In a phone's row rather than the grid: a smaller picture and sign. */
  small?: boolean
}): React.JSX.Element {
  const w = p.watched.get(episode.path)
  const done = w ? isFinished(w) : false
  const part = w && !done ? w.fraction : 0
  const src = thumbUrl(p.mediaBase, episode.path, episode.added, small ? undefined : 640)
  return (
    <span className={cn('relative block aspect-video shrink-0 overflow-hidden rounded-lg bg-panel2', className)}>
      <Picture
        src={src}
        className="h-full w-full object-cover"
        fallback={
          <span className="absolute inset-0 flex items-center justify-center font-mono text-[15px] text-textFaint">
            E{pad(episode.number)}
          </span>
        }
      />
      {done ? (
        // Seen to the end: darker, with watching it again in the middle.
        <>
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 transition-colors group-hover:bg-black/30">
            <RotateCcw size={small ? 18 : 30} strokeWidth={2.25} className="text-white drop-shadow" />
          </span>
          <span
            className={cn(
              'absolute rounded-[3px] bg-black/80 font-semibold text-white',
              small ? 'bottom-1 right-1 px-1 py-px text-[9px]' : 'bottom-1.5 right-1.5 px-1.5 py-0.5 text-[10.5px]',
            )}
          >
            Watched
          </span>
        </>
      ) : (
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black">
            <Play size={16} fill="currentColor" className="ml-0.5" />
          </span>
        </span>
      )}
      {part > 0 && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
          <span className="block h-full bg-white" style={{ width: `${Math.round(part * 100)}%` }} />
        </span>
      )}
    </span>
  )
}

function Meta({ p, episode }: { p: Shared; episode: LibraryEpisode }): React.JSX.Element {
  const w = p.watched.get(episode.path)
  const done = w ? isFinished(w) : false
  const part = w && !done ? w.fraction : 0
  const subs = (episode.subtitles?.length ?? 0) > 0
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-textFaint">
      <QualityTag quality={qualityOf(episode.resolution)} size="sm" />
      {subs && (
        <span title={subtitleTitle(episode.subtitles)} className="rounded-[3px] border border-line px-1 uppercase">
          sub
        </span>
      )}
      <span className="tnum">{formatBytes(episode.size)}</span>
      {part > 0 && <span className="tnum text-textDim">{Math.round(part * 100)}% watched</span>}
    </span>
  )
}

/** An episode as a row, on a phone held upright: its picture, number and name. */
function Row({ p, episode }: { p: Shared; episode: LibraryEpisode }): React.JSX.Element {
  const season = p.season
  const press = useLongPress(
    () => {
      if (season) p.onEpisodeMore?.(p.item, episode, season.number)
    },
    () => p.onPlay(episode.path),
  )
  const w = p.watched.get(episode.path)
  const done = w ? isFinished(w) : false
  return (
    <button
      {...(p.onEpisodeMore ? press : { onClick: () => p.onPlay(episode.path) })}
      className="group flex select-none items-center gap-4 rounded-xl border border-transparent p-2 text-left transition-colors hover:border-white/[0.08] hover:bg-white/[0.035]"
    >
      <Still p={p} episode={episode} className="w-[124px]" small />
      <span className="min-w-0 flex-1">
        <span className={cn('line-clamp-2 text-[14px] font-medium leading-snug', done ? 'text-textDim' : 'text-text')}>
          <span className="tnum mr-1.5 font-mono text-textFaint">{pad(episode.number)}</span>
          {title(episode)}
        </span>
        <Meta p={p} episode={episode} />
      </span>
    </button>
  )
}

/** An episode as a picture with its name under it, in the grid. */
function Card({ p, episode }: { p: Shared; episode: LibraryEpisode }): React.JSX.Element {
  const season = p.season
  const press = useLongPress(
    () => {
      if (season) p.onEpisodeMore?.(p.item, episode, season.number)
    },
    () => p.onPlay(episode.path),
  )
  const w = p.watched.get(episode.path)
  const done = w ? isFinished(w) : false
  return (
    <button
      {...(p.onEpisodeMore ? press : { onClick: () => p.onPlay(episode.path) })}
      className="group flex select-none flex-col rounded-xl text-left"
    >
      <Still p={p} episode={episode} className="w-full ring-1 ring-white/[0.06]" />
      <span className="mt-2.5 block px-0.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-textFaint">
          {season ? code(season.number, episode) : ''}
        </span>
        <span
          className={cn(
            'mt-0.5 line-clamp-1 block font-medium',
            p.tv ? 'text-[16px]' : 'text-[14px]',
            done ? 'text-textDim' : 'text-text',
          )}
        >
          {title(episode)}
        </span>
        <Meta p={p} episode={episode} />
      </span>
    </button>
  )
}

// ───────────────────────────────────────────────────────────────────────────

export type Next = {
  kind: 'resume' | 'next' | 'start' | 'again'
  season: number
  episode: LibraryEpisode
  fraction: number
}

/** What Continue plays: where the person is up to in the whole series. */
export function nextUp(item: Pick<LibraryItem, 'seasons'>, watched: Map<string, Watched>): Next | null {
  const order = item.seasons.flatMap((s) => s.episodes.map((episode) => ({ season: s.number, episode })))
  if (order.length === 0) return null
  let latest = -1
  let at = -Infinity
  order.forEach(({ episode }, index) => {
    const entry = watched.get(episode.path)
    if (entry && entry.updatedAt > at) {
      at = entry.updatedAt
      latest = index
    }
  })
  const first = order[0]!
  if (latest < 0) return { kind: 'start', ...first, fraction: 0 }
  const last = order[latest]!
  const entry = watched.get(last.episode.path)!
  if (!isFinished(entry)) return { kind: 'resume', ...last, fraction: entry.fraction }
  const after = order[latest + 1]
  if (after) return { kind: 'next', ...after, fraction: 0 }
  return { kind: 'again', ...first, fraction: 0 }
}

function counts(season: LibrarySeason, watched: Map<string, Watched>): { done: number; total: number } {
  const done = season.episodes.filter((e) => {
    const w = watched.get(e.path)
    return w !== undefined && isFinished(w)
  }).length
  return { done, total: season.episodes.length }
}

function progressLine(season: LibrarySeason, watched: Map<string, Watched>): string {
  const { done, total } = counts(season, watched)
  if (done === total && total > 0) return 'Watched'
  if (done > 0) return `${done} of ${total} watched`
  return `${total} ${total === 1 ? 'episode' : 'episodes'}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

function seasonName(season: LibrarySeason): string {
  return season.number === 0 ? 'Specials' : `Season ${season.number}`
}

function code(season: number, episode: LibraryEpisode): string {
  return season === 0 ? `SP · E${pad(episode.number)}` : `S${pad(season)} · E${pad(episode.number)}`
}

function title(episode: LibraryEpisode): string {
  return episode.title ?? episodeName(episode.path, episode.number)
}

/**
 * Room for the wide layout: a window or a tablet wide enough, a TV, or a
 * phone on its side, which is short rather than narrow.
 */
function useWide(): boolean {
  const query = '(min-width: 820px), (orientation: landscape) and (max-height: 560px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const changed = (): void => setWide(list.matches)
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [])
  return wide || isTv()
}
