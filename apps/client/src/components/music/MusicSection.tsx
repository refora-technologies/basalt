import { useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  Disc3,
  Heart,
  House,
  ListMusic,
  ListPlus,
  MicVocal,
  MoreHorizontal,
  Play,
  Shuffle,
  Volume2,
} from 'lucide-react'

import { HexMark } from '@/components/HexMark'
import { SectionTabs, useSectionLink, type Section } from '@/mobile/SectionPager'
import { useBack } from '@/mobile/useBack'
import type { Listening, Playlist } from '@/lib/api'
import {
  type Album,
  type Artist,
  type Song,
  formatDuration,
  recentAlbums,
  searchMusic,
} from '@/lib/music'
import { useMusicPlayer } from '@/lib/musicPlayer'
import type { MusicState } from '@/lib/useMusic'
import { cn } from '@/lib/utils'

import { Cover } from './Cover'
import { SongMenu, type SongMenuTarget } from './SongMenu'

/**
 * The Music section of the library: Home, Albums, Artists and Playlists,
 * and the pages they open.
 *
 * Inside the library, which already has a switch for its sections, Music has
 * its own: the same control, the same slide, one level down. It moves only
 * when tapped, so a sideways swipe still goes to the next section of the
 * library, as it does everywhere else.
 */
export type MusicLayout = 'phone' | 'wide' | 'tv'

type View = 'home' | 'albums' | 'artists' | 'playlists'

type Page =
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'songs' }
  | { kind: 'liked' }
  | { kind: 'playlist'; id: string }

const VIEWS: Section[] = [
  { key: 'home', label: 'Home', icon: House },
  { key: 'albums', label: 'Albums', icon: Disc3 },
  { key: 'artists', label: 'Artists', icon: MicVocal },
  { key: 'playlists', label: 'Playlists', icon: ListMusic },
]

export interface MusicSectionProps {
  music: MusicState
  base: string
  layout: MusicLayout
  /** What is typed in the library's search. */
  query: string
  /** Liked songs: the profile's starred files. */
  liked: Set<string>
  onLike: (song: Song, liked: boolean) => void
  playlists: Playlist[]
  /** Makes a playlist, with songs if given, and returns its id. */
  onNewPlaylist: (songs: string[]) => void
  onAddToPlaylist: (id: string, songs: string[]) => void
  onRenamePlaylist: (id: string) => void
  /** Asks first. */
  onDeletePlaylist: (id: string) => void
  onRemoveFromPlaylist: (id: string, path: string) => void
  /** What was playing last, to carry on with. */
  listening: Listening | null
  onResume: () => void
  /** Takes down an artist's photo of the wrong person. Only where this device manages the host. */
  onWrongPhoto?: (name: string) => void
}

export function MusicSection(props: MusicSectionProps): React.JSX.Element {
  const { music, layout, query } = props
  const [view, setView] = useState<View>('home')
  const [pages, setPages] = useState<Page[]>([])
  const [menu, setMenu] = useState<SongMenuTarget | null>(null)
  const link = useSectionLink()
  const scroller = useRef<HTMLDivElement | null>(null)

  const open = (page: Page): void => {
    setPages((stack) => [...stack, page])
    scroller.current?.scrollTo({ top: 0 })
  }
  const back = (): void => setPages((stack) => stack.slice(0, -1))
  useBack(pages.length > 0 || menu !== null, () => {
    if (menu) setMenu(null)
    else back()
    return true
  })

  const albumsById = useMemo(() => new Map(music.albums.map((a) => [a.id, a])), [music.albums])
  const artistsById = useMemo(() => new Map(music.artists.map((a) => [a.id, a])), [music.artists])
  const songsByPath = useMemo(() => new Map(music.songs.map((s) => [s.path, s])), [music.songs])
  const albumOf = useMemo(() => {
    const map = new Map<string, Album>()
    for (const album of music.albums) for (const song of album.songs) map.set(song.path, album)
    return map
  }, [music.albums])

  const nav: Nav = {
    openAlbum: (album) => open({ kind: 'album', id: album.id }),
    openArtist: (name) => {
      const artist = music.artists.find((a) => a.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      if (artist) open({ kind: 'artist', id: artist.id })
    },
    menu: (song, from, playlistId) =>
      setMenu({ song, from, album: albumOf.get(song.path) ?? null, playlistId }),
  }

  const page = pages[pages.length - 1]
  let body: React.ReactNode
  if (query.trim()) {
    body = <SearchResults {...props} nav={nav} />
  } else if (page?.kind === 'album' && albumsById.get(page.id)) {
    body = <AlbumPage {...props} album={albumsById.get(page.id)!} nav={nav} onBack={back} />
  } else if (page?.kind === 'artist' && artistsById.get(page.id)) {
    body = <ArtistPage {...props} artist={artistsById.get(page.id)!} nav={nav} onBack={back} />
  } else if (page?.kind === 'songs') {
    body = (
      <SongsPage
        {...props}
        title="All songs"
        songs={[...music.songs].sort((a, b) => a.title.localeCompare(b.title))}
        nav={nav}
        onBack={back}
      />
    )
  } else if (page?.kind === 'liked') {
    const songs = music.songs.filter((s) => props.liked.has(s.path))
    body = <SongsPage {...props} title="Liked Songs" songs={songs} nav={nav} onBack={back} likedPage />
  } else if (page?.kind === 'playlist') {
    const playlist = props.playlists.find((p) => p.id === page.id)
    const songs = (playlist?.songs ?? []).map((p) => songsByPath.get(p)).filter((s): s is Song => !!s)
    body = playlist ? (
      <SongsPage
        {...props}
        title={playlist.name}
        songs={songs}
        nav={nav}
        onBack={back}
        playlistId={playlist.id}
      />
    ) : null
  } else if (view === 'albums') {
    body = <AlbumGrid {...props} albums={music.albums} nav={nav} />
  } else if (view === 'artists') {
    body = <ArtistGrid {...props} artists={music.artists} nav={nav} />
  } else if (view === 'playlists') {
    body = <PlaylistsView {...props} onOpen={open} />
  } else {
    body = <Home {...props} nav={nav} onOpen={open} />
  }

  return (
    // Part of the page for the remote, as the other sections are: as a scope
    // of its own it held the focus in Music, away from the side rail, the
    // section switch above and the music bar below.
    <div className="flex h-full flex-col">
      {pages.length === 0 && !query.trim() && (
        <SectionTabs
          items={VIEWS}
          active={view}
          onChoose={(key) => {
            setView(key as View)
            scroller.current?.scrollTo({ top: 0 })
          }}
          link={link}
        />
      )}
      <div
        ref={scroller}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain',
          layout === 'phone' ? 'px-4 pb-28' : layout === 'tv' ? 'px-12 pb-24' : 'px-6 pb-28',
        )}
      >
        {music.loaded && music.songs.length === 0 ? (
          <Empty reading={music.reading} />
        ) : (
          body
        )}
      </div>
      {menu && (
        <SongMenu
          {...props}
          target={menu}
          onClose={() => setMenu(null)}
          onOpenAlbum={(album) => {
            setMenu(null)
            nav.openAlbum(album)
          }}
          onOpenArtist={(name) => {
            setMenu(null)
            nav.openArtist(name)
          }}
        />
      )}
    </div>
  )
}

interface Nav {
  openAlbum: (album: Album) => void
  openArtist: (name: string) => void
  /** The ⋮ menu for one song; `from` names what it is being played from. */
  menu: (song: Song, from: string, playlistId?: string) => void
}

function Empty({ reading }: { reading: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-[300px] items-center justify-center px-10 text-center text-[14px] text-textFaint">
      {reading ? 'Reading the songs on the drive…' : 'No music on the drive yet'}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function Home(props: MusicSectionProps & { nav: Nav; onOpen: (page: Page) => void }): React.JSX.Element {
  const { music, layout, nav, onOpen, listening, playlists, liked } = props
  const player = useMusicPlayer()
  const recent = useMemo(() => recentAlbums(music.albums).slice(0, 12), [music.albums])
  const songsByPath = useMemo(() => new Map(music.songs.map((s) => [s.path, s])), [music.songs])
  const resumeSong = listening ? songsByPath.get(listening.queue[listening.index] ?? '') : undefined

  return (
    <div className="flex flex-col gap-7 pt-2">
      <ShuffleAll
        count={music.songs.length}
        layout={layout}
        onShuffle={() =>
          player?.play(
            music.songs.map((s) => s.path),
            Math.floor(Math.random() * music.songs.length),
            'All songs',
            true,
          )
        }
        onAll={() => onOpen({ kind: 'songs' })}
      />

      {resumeSong && listening && player?.current !== resumeSong.path && (
        <Shelf title="Continue listening">
          <button
            onClick={props.onResume}
            className="flex w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.03] p-2.5 text-left transition-colors hover:bg-white/[0.05]"
          >
            <Cover
              base={props.base}
              path={resumeSong.cover ? resumeSong.path : null}
              mtime={resumeSong.mtime}
              name={resumeSong.album}
              label={false}
              className="w-14 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-text">{resumeSong.title}</div>
              <div className="truncate text-[12px] text-textFaint">
                {resumeSong.artist} · {listening.from}
              </div>
            </div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black">
              <Play size={17} className="fill-current" />
            </span>
          </button>
        </Shelf>
      )}

      <Shelf title="Yours">
        <div className={cn('grid gap-2', layout === 'phone' ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))]')}>
          <Tile
            label="Liked Songs"
            detail={`${liked.size} ${liked.size === 1 ? 'song' : 'songs'}`}
            icon={<Heart size={18} className="fill-current" />}
            onClick={() => onOpen({ kind: 'liked' })}
          />
          {playlists.slice(0, layout === 'phone' ? 2 : 6).map((playlist) => (
            <Tile
              key={playlist.id}
              label={playlist.name}
              detail={`${playlist.songs.length} ${playlist.songs.length === 1 ? 'song' : 'songs'}`}
              cover={<Cover base={props.base} path={null} name={playlist.name} label={false} className="h-full w-full rounded-none" />}
              onClick={() => onOpen({ kind: 'playlist', id: playlist.id })}
            />
          ))}
          <Tile
            label="New playlist"
            icon={<ListPlus size={18} />}
            muted
            onClick={() => props.onNewPlaylist([])}
          />
        </div>
      </Shelf>

      {recent.length > 0 && (
        <Shelf title="Recently added">
          <Row layout={layout}>
            {recent.map((album) => (
              <AlbumCard key={album.id} {...props} album={album} nav={nav} rowItem />
            ))}
          </Row>
        </Shelf>
      )}

      {music.artists.length > 0 && (
        <Shelf title="Artists">
          <Row layout={layout}>
            {music.artists.slice(0, 16).map((artist) => (
              <ArtistCard key={artist.id} {...props} artist={artist} nav={nav} rowItem />
            ))}
          </Row>
        </Shelf>
      )}
    </div>
  )
}

/** "Shuffle all" with the Basalt mark: the quickest way to start the music. */
function ShuffleAll({
  count,
  layout,
  onShuffle,
  onAll,
}: {
  count: number
  layout: MusicLayout
  onShuffle: () => void
  onAll: () => void
}): React.JSX.Element {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-[radial-gradient(120%_140%_at_0%_0%,rgba(255,255,255,0.08),rgba(255,255,255,0.015)_60%)] p-4">
      <div className="pointer-events-none absolute -right-6 -top-6 text-white opacity-[0.06]">
        <HexMark size={layout === 'phone' ? 120 : 160} />
      </div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-textFaint">On this drive</div>
      <div className="mt-1 text-[22px] font-bold tracking-[-0.02em] text-text">
        {count.toLocaleString()} {count === 1 ? 'song' : 'songs'}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          data-remote-first=""
          onClick={onShuffle}
          disabled={count === 0}
          className="flex h-10 items-center gap-2 rounded-full bg-white px-4 text-[13.5px] font-semibold text-black transition-transform active:scale-[0.97] disabled:opacity-50"
        >
          <Shuffle size={16} />
          Shuffle all
        </button>
        <button
          onClick={onAll}
          className="flex h-10 items-center rounded-full border border-line px-4 text-[13.5px] text-textDim transition-colors hover:text-text"
        >
          All songs
        </button>
      </div>
    </div>
  )
}

function Shelf({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2.5 text-[16px] font-semibold tracking-[-0.01em] text-text">{title}</h3>
      {children}
    </section>
  )
}

/** A row that scrolls sideways, as shelves do. */
function Row({ layout, children }: { layout: MusicLayout; children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        layout === 'tv' ? 'gap-6' : 'gap-3',
        layout === 'phone' && '-mx-4 px-4',
      )}
    >
      {children}
    </div>
  )
}

function Tile({
  label,
  detail,
  icon,
  cover,
  muted,
  onClick,
}: {
  label: string
  detail?: string
  icon?: React.ReactNode
  cover?: React.ReactNode
  muted?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex h-14 items-center gap-3 overflow-hidden rounded-xl bg-white/[0.045] pr-3 text-left transition-colors hover:bg-white/[0.07]"
    >
      <span
        className={cn(
          'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden',
          muted ? 'bg-white/[0.04] text-textDim' : 'bg-gradient-to-br from-[#3b3b44] to-[#17171b] text-text',
        )}
      >
        {cover ?? icon}
      </span>
      <span className="min-w-0">
        <span className={cn('block truncate text-[13px] font-semibold', muted ? 'text-textDim' : 'text-text')}>
          {label}
        </span>
        {detail && <span className="block truncate text-[11.5px] text-textFaint">{detail}</span>}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Albums and artists
// ---------------------------------------------------------------------------

const gridOf = (layout: MusicLayout): string =>
  cn(
    'grid',
    layout === 'phone'
      ? 'grid-cols-2 gap-x-3 gap-y-5'
      : layout === 'tv'
        ? 'grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-6 gap-y-8'
        : 'grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-5 gap-y-6',
  )

function AlbumGrid(props: MusicSectionProps & { albums: Album[]; nav: Nav }): React.JSX.Element {
  return (
    <div className={cn(gridOf(props.layout), 'pt-3')}>
      {props.albums.map((album) => (
        <AlbumCard key={album.id} {...props} album={album} />
      ))}
    </div>
  )
}

function AlbumCard({
  base,
  album,
  nav,
  layout,
  rowItem,
}: MusicSectionProps & { album: Album; nav: Nav; rowItem?: boolean }): React.JSX.Element {
  const first = album.songs[0]
  return (
    <button
      onClick={() => nav.openAlbum(album)}
      className={cn(
        'group text-left',
        rowItem && (layout === 'tv' ? 'w-[180px] shrink-0' : layout === 'phone' ? 'w-[132px] shrink-0' : 'w-[160px] shrink-0'),
      )}
    >
      <Cover
        base={base}
        path={album.coverPath}
        mtime={first?.mtime}
        name={album.title}
        className="w-full transition-transform duration-200 group-hover:scale-[1.02] group-focus-visible:scale-[1.04]"
      />
      <div className="mt-2 truncate text-[13px] font-semibold text-text">{album.title}</div>
      <div className="truncate text-[11.5px] text-textFaint">
        {album.artist}
        {album.year ? ` · ${album.year}` : ''}
      </div>
    </button>
  )
}

function ArtistGrid(props: MusicSectionProps & { artists: Artist[]; nav: Nav }): React.JSX.Element {
  return (
    <div className={cn(gridOf(props.layout), 'pt-3')}>
      {props.artists.map((artist) => (
        <ArtistCard key={artist.id} {...props} artist={artist} />
      ))}
    </div>
  )
}

/**
 * An artist's picture: their photo when the host has one, else their newest
 * album's cover, else one drawn from their name.
 */
function ArtistPicture({
  base,
  artist,
  size,
  className,
}: {
  base: string
  artist: Artist
  size?: number
  className?: string
}): React.JSX.Element {
  const album = artist.albums[0]
  const song = artist.songs[0] ?? album?.songs[0]
  if (artist.photo && song) {
    return (
      <Cover
        base={base}
        path={song.path}
        mtime={artist.photo.version}
        name={artist.name}
        artist={artist.name}
        round
        size={size}
        className={className}
      />
    )
  }
  return (
    <Cover
      base={base}
      path={album?.coverPath ?? null}
      mtime={album?.songs[0]?.mtime}
      name={artist.name}
      round
      size={size}
      className={className}
    />
  )
}

function ArtistCard({
  base,
  artist,
  nav,
  layout,
  rowItem,
}: MusicSectionProps & { artist: Artist; nav: Nav; rowItem?: boolean }): React.JSX.Element {
  return (
    <button
      onClick={() => nav.openArtist(artist.name)}
      className={cn(
        'group text-center',
        rowItem && (layout === 'tv' ? 'w-[150px] shrink-0' : layout === 'phone' ? 'w-[92px] shrink-0' : 'w-[130px] shrink-0'),
      )}
    >
      <ArtistPicture
        base={base}
        artist={artist}
        className="w-full transition-transform duration-200 group-hover:scale-[1.03] group-focus-visible:scale-[1.05]"
      />
      <div className="mt-2 truncate text-[12.5px] font-medium text-text">{artist.name}</div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function PageHead({ onBack, children }: { onBack: () => void; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="sticky top-0 z-[1] -mx-1 flex h-11 items-center bg-ink/90 backdrop-blur">
      <button
        onClick={onBack}
        aria-label="Back"
        className="flex h-9 w-9 items-center justify-center rounded-full text-textDim transition-colors hover:text-text"
      >
        <ChevronLeft size={22} />
      </button>
      {children}
    </div>
  )
}

function AlbumPage(
  props: MusicSectionProps & { album: Album; nav: Nav; onBack: () => void },
): React.JSX.Element {
  const { album, layout, nav, onBack } = props
  const player = useMusicPlayer()
  const paths = album.songs.map((s) => s.path)
  const discs = new Set(album.songs.map((s) => s.disc ?? 1)).size > 1
  const wide = layout !== 'phone'
  return (
    <div>
      <PageHead onBack={onBack} />
      <div className={cn('flex gap-5', wide ? 'items-end pt-2' : 'flex-col items-center pt-1')}>
        <Cover
          base={props.base}
          path={album.coverPath}
          mtime={album.songs[0]?.mtime}
          name={album.title}
          size={640}
          className={cn('shadow-[0_18px_50px_rgba(0,0,0,0.55)]', wide ? 'w-52 shrink-0' : 'w-[62%]')}
        />
        <div className={cn('min-w-0', !wide && 'w-full')}>
          {wide && <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-textFaint">Album</div>}
          <h2 className={cn('font-bold tracking-[-0.03em] text-text', wide ? 'mt-1 text-[34px] leading-tight' : 'text-[22px]')}>
            {album.title}
          </h2>
          <button onClick={() => nav.openArtist(album.artist)} className="mt-1 text-[13.5px] font-semibold text-textDim hover:text-text">
            {album.artist}
          </button>
          <div className="mt-0.5 text-[12px] text-textFaint">
            {[album.year, songCount(album.songs.length), minutes(album.durationMs)].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      <Actions
        onPlay={() => player?.play(paths, 0, album.title)}
        onShuffle={() => player?.play(paths, Math.floor(Math.random() * paths.length), album.title, true)}
        onQueue={() => player?.addToQueue(paths)}
      />
      <SongList {...props} songs={album.songs} from={album.title} numbered showDiscs={discs} showAlbum={false} />
    </div>
  )
}

function ArtistPage(
  props: MusicSectionProps & { artist: Artist; nav: Nav; onBack: () => void },
): React.JSX.Element {
  const { artist, layout, onBack } = props
  const player = useMusicPlayer()
  const [all, setAll] = useState(false)
  const paths = artist.songs.map((s) => s.path)
  const wide = layout !== 'phone'
  return (
    <div>
      <PageHead onBack={onBack} />
      <div className={cn('flex gap-5', wide ? 'items-end pt-2' : 'flex-col items-center pt-1 text-center')}>
        <ArtistPicture base={props.base} artist={artist} size={640} className={cn(wide ? 'w-44 shrink-0' : 'w-[46%]')} />
        <div className="min-w-0">
          {wide && <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-textFaint">Artist</div>}
          <h2 className={cn('font-bold tracking-[-0.03em] text-text', wide ? 'mt-1 text-[34px]' : 'text-[24px]')}>
            {artist.name}
          </h2>
          <div className="mt-0.5 text-[12px] text-textFaint">
            {[artist.albums.length ? `${artist.albums.length} ${artist.albums.length === 1 ? 'album' : 'albums'}` : '', songCount(artist.songs.length)]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {/* The photo's licence asks for its credit: who took it, and the licence. */}
          {artist.photo && (artist.photo.credit || props.onWrongPhoto) && (
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[10.5px] leading-snug text-textFaint">
              {artist.photo.credit && <span>{artist.photo.credit}</span>}
              {props.onWrongPhoto && (
                <button
                  type="button"
                  onClick={() => props.onWrongPhoto?.(artist.name)}
                  className="underline decoration-white/20 underline-offset-2 transition-colors hover:text-textDim"
                >
                  Wrong person?
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <Actions
        onPlay={() => player?.play(paths, 0, artist.name)}
        onShuffle={() => player?.play(paths, Math.floor(Math.random() * paths.length), artist.name, true)}
        onQueue={() => player?.addToQueue(paths)}
      />
      <h3 className="mb-1 mt-2 text-[15px] font-semibold text-text">Songs</h3>
      <SongList {...props} songs={all ? artist.songs : artist.songs.slice(0, 5)} from={artist.name} />
      {artist.songs.length > 5 && (
        <button onClick={() => setAll((a) => !a)} className="mt-1 text-[12.5px] font-semibold text-textDim hover:text-text">
          {all ? 'Show fewer' : `Show all ${artist.songs.length}`}
        </button>
      )}
      {artist.albums.length > 0 && (
        <>
          <h3 className="mb-3 mt-7 text-[15px] font-semibold text-text">Albums</h3>
          <div className={gridOf(layout)}>
            {artist.albums.map((a) => (
              <AlbumCard key={a.id} {...props} album={a} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SongsPage(
  props: MusicSectionProps & {
    title: string
    songs: Song[]
    nav: Nav
    onBack: () => void
    likedPage?: boolean
    /** A playlist's page: it can be renamed and deleted, and songs taken out. */
    playlistId?: string
  },
): React.JSX.Element {
  const { title, songs, onBack, playlistId } = props
  const player = useMusicPlayer()
  const paths = songs.map((s) => s.path)
  return (
    <div>
      <PageHead onBack={onBack}>
        {playlistId && (
          <span className="ml-auto mr-1 flex gap-4">
            <button
              onClick={() => props.onRenamePlaylist(playlistId)}
              className="text-[13px] font-semibold text-textDim hover:text-text"
            >
              Rename
            </button>
            <button
              onClick={() => props.onDeletePlaylist(playlistId)}
              className="text-[13px] font-semibold text-textDim hover:text-danger"
            >
              Delete
            </button>
          </span>
        )}
      </PageHead>
      <div className="flex items-center gap-4 pt-1">
        {props.likedPage ? (
          <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#3b3b44] to-[#17171b] text-text">
            <Heart size={30} className="fill-current" />
          </span>
        ) : (
          <Cover base={props.base} path={null} name={title} label={false} className="w-20 shrink-0" />
        )}
        <div className="min-w-0">
          <h2 className="truncate text-[24px] font-bold tracking-[-0.02em] text-text">{title}</h2>
          <div className="text-[12px] text-textFaint">{songCount(songs.length)}</div>
        </div>
      </div>
      {songs.length > 0 ? (
        <>
          <Actions
            onPlay={() => player?.play(paths, 0, title)}
            onShuffle={() => player?.play(paths, Math.floor(Math.random() * paths.length), title, true)}
            onQueue={() => player?.addToQueue(paths)}
          />
          <SongList {...props} songs={songs} from={title} playlistId={playlistId} />
        </>
      ) : (
        <p className="mt-8 text-center text-[13.5px] text-textFaint">
          {props.likedPage ? 'Songs you like show here. Tap ♡ on any song.' : 'No songs here yet. Add some from a song’s ⋮ menu.'}
        </p>
      )}
    </div>
  )
}

function PlaylistsView(props: MusicSectionProps & { onOpen: (page: Page) => void }): React.JSX.Element {
  const { playlists, liked, onOpen } = props
  return (
    <div className="flex flex-col gap-1.5 pt-3">
      <ListRow
        icon={<Heart size={20} className="fill-current" />}
        title="Liked Songs"
        detail={songCount(liked.size)}
        onClick={() => onOpen({ kind: 'liked' })}
      />
      {playlists.map((playlist) => (
        <ListRow
          key={playlist.id}
          cover={<Cover base={props.base} path={null} name={playlist.name} label={false} className="h-full w-full rounded-none" />}
          title={playlist.name}
          detail={songCount(playlist.songs.length)}
          onClick={() => onOpen({ kind: 'playlist', id: playlist.id })}
        />
      ))}
      <ListRow icon={<ListPlus size={20} />} title="New playlist" muted onClick={() => props.onNewPlaylist([])} />
    </div>
  )
}

function ListRow({
  icon,
  cover,
  title,
  detail,
  muted,
  onClick,
}: {
  icon?: React.ReactNode
  cover?: React.ReactNode
  title: string
  detail?: string
  muted?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button onClick={onClick} className="flex items-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-white/[0.04]">
      <span
        className={cn(
          'flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg',
          muted ? 'bg-white/[0.04] text-textDim' : 'bg-gradient-to-br from-[#3b3b44] to-[#17171b] text-text',
        )}
      >
        {cover ?? icon}
      </span>
      <span className="min-w-0">
        <span className={cn('block truncate text-[14px] font-semibold', muted ? 'text-textDim' : 'text-text')}>{title}</span>
        {detail && <span className="block text-[12px] text-textFaint">{detail}</span>}
      </span>
    </button>
  )
}

function SearchResults(props: MusicSectionProps & { nav: Nav }): React.JSX.Element {
  const { music, query, layout } = props
  const found = useMemo(() => searchMusic(query, music.albums, music.artists), [query, music.albums, music.artists])
  if (found.songs.length + found.albums.length + found.artists.length === 0) {
    return <p className="mt-16 text-center text-[14px] text-textFaint">Nothing matches “{query}”</p>
  }
  return (
    <div className="flex flex-col gap-6 pt-3">
      {found.artists.length > 0 && (
        <Shelf title="Artists">
          <Row layout={layout}>
            {found.artists.map((artist) => (
              <ArtistCard key={artist.id} {...props} artist={artist} rowItem />
            ))}
          </Row>
        </Shelf>
      )}
      {found.albums.length > 0 && (
        <Shelf title="Albums">
          <Row layout={layout}>
            {found.albums.map((album) => (
              <AlbumCard key={album.id} {...props} album={album} rowItem />
            ))}
          </Row>
        </Shelf>
      )}
      {found.songs.length > 0 && (
        <Shelf title="Songs">
          <SongList {...props} songs={found.songs.slice(0, 50)} from={`“${query}”`} />
        </Shelf>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

function Actions({
  onPlay,
  onShuffle,
  onQueue,
}: {
  onPlay: () => void
  onShuffle: () => void
  onQueue: () => void
}): React.JSX.Element {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2">
      <button
        data-remote-first=""
        onClick={onPlay}
        aria-label="Play"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black transition-transform active:scale-95"
      >
        <Play size={20} className="ml-0.5 fill-current" />
      </button>
      <button
        onClick={onShuffle}
        aria-label="Shuffle"
        className="flex h-11 w-11 items-center justify-center rounded-full text-textDim transition-colors hover:text-text"
      >
        <Shuffle size={20} />
      </button>
      <button
        onClick={onQueue}
        aria-label="Add to queue"
        className="flex h-11 w-11 items-center justify-center rounded-full text-textDim transition-colors hover:text-text"
      >
        <ListPlus size={20} />
      </button>
    </div>
  )
}

function SongList({
  songs,
  from,
  numbered,
  showDiscs,
  showAlbum = true,
  playlistId,
  liked,
  onLike,
  nav,
  layout,
}: MusicSectionProps & {
  songs: Song[]
  from: string
  numbered?: boolean
  showDiscs?: boolean
  showAlbum?: boolean
  playlistId?: string
  nav: Nav
}): React.JSX.Element {
  const player = useMusicPlayer()
  const paths = songs.map((s) => s.path)
  let disc: number | null = null
  return (
    <div className="flex flex-col">
      {songs.map((song, i) => {
        const heading = showDiscs && song.disc !== disc ? ((disc = song.disc ?? 1), disc) : null
        const now = player?.current === song.path
        const isLiked = liked.has(song.path)
        return (
          <div key={song.path}>
            {heading !== null && (
              <div className="mb-1 mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">
                Disc {heading}
              </div>
            )}
            <div
              className={cn(
                'group flex items-center gap-3 rounded-lg px-1.5 transition-colors hover:bg-white/[0.04]',
                layout === 'tv' ? 'h-14' : 'h-[52px]',
                now && 'bg-white/[0.04]',
              )}
            >
              <button
                onClick={() => player?.play(paths, i, from)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="flex w-6 shrink-0 justify-end text-[12px] tabular-nums text-textFaint">
                  {now ? <Volume2 size={14} className="text-text" /> : numbered ? (song.track ?? i + 1) : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[14px] text-text', now && 'font-bold')}>{song.title}</span>
                  <span className="block truncate text-[11.5px] text-textFaint">
                    {showAlbum ? `${song.artist} · ${song.album}` : song.artist}
                  </span>
                </span>
              </button>
              <button
                onClick={() => onLike(song, !isLiked)}
                aria-label={isLiked ? 'Unlike' : 'Like'}
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
                  isLiked ? 'text-text' : 'text-textFaint hover:text-text',
                  !isLiked && layout === 'wide' && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
              >
                <Heart size={16} className={cn(isLiked && 'fill-current')} />
              </button>
              {layout !== 'phone' && (
                <span className="w-12 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-textFaint">
                  {formatDuration(song.durationMs)}
                </span>
              )}
              <button
                onClick={() => nav.menu(song, from, playlistId)}
                aria-label={`More for ${song.title}`}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-textFaint transition-colors hover:text-text"
              >
                <MoreHorizontal size={18} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

const songCount = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'song' : 'songs'}`

function minutes(ms: number): string {
  if (ms <= 0) return ''
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}
