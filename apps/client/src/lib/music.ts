/**
 * The music on the drive as albums, artists and songs.
 *
 * The host reads each song's tags (see `basalt_host::media::music`); this
 * turns the list into what the Music section shows. A song without tags, or
 * from a host before 1.6.3 that sends no tags at all, is described from its
 * place on the drive instead — `Music/Artist/Album/01 Title.flac` — as the
 * app always did.
 *
 * **Albums** are grouped by who the album is by and its name, so a
 * compilation tagged "Various Artists" is one album, and a song by "Ana feat.
 * Bo" stays on its album. Without an album artist, an album is the songs of
 * one name in one folder: a folder of a compilation with no album artist is
 * still one album, not one per singer.
 */

import type { MediaFile, MusicTrack } from './api'
import { stemOf, trackInfo } from './mediaInfo'

export interface Song {
  path: string
  title: string
  /** Who sings it: the track's artist, else the album's. */
  artist: string
  album: string
  albumArtist: string | null
  track: number | null
  disc: number | null
  year: number | null
  genre: string | null
  durationMs: number | null
  /** The host has a cover for it. */
  cover: boolean
  size: number
  /** Unix seconds. */
  mtime: number
}

export interface Album {
  id: string
  title: string
  artist: string
  year: number | null
  /** In playing order: disc, then track, then title. */
  songs: Song[]
  /** A song whose thumbnail is the cover, or null to draw one. */
  coverPath: string | null
  /** When its newest song arrived, unix seconds. */
  added: number
  durationMs: number
}

export interface Artist {
  id: string
  name: string
  /** Albums by them, newest first. */
  albums: Album[]
  /** Every song they sing, on their albums and elsewhere. */
  songs: Song[]
}

export const UNKNOWN_ARTIST = 'Unknown artist'
export const UNKNOWN_ALBUM = 'Unknown album'
export const VARIOUS_ARTISTS = 'Various artists'

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * A song from the host's tags, with the file's own name and place for what is
 * missing. A song downloaded with no tags is usually named "Artist - Title",
 * and then that is who and what it is, a single of its own; otherwise the
 * folders say, as `Music/Artist/Album/01 Title.flac`.
 */
export function songOf(track: MusicTrack): Song {
  const guessed = trackInfo(track.path)
  const named = clean(track.title) || clean(track.artist) ? null : nameParts(stemOf(track.path))
  const title = clean(track.title) ?? named?.title ?? guessed.title
  return {
    path: track.path,
    title,
    artist:
      clean(track.artist) ?? clean(track.albumArtist) ?? named?.artist ?? (guessed.artist || UNKNOWN_ARTIST),
    album: clean(track.album) ?? (named ? title : guessed.album || UNKNOWN_ALBUM),
    albumArtist: clean(track.albumArtist),
    track: track.track ?? guessed.number,
    disc: track.disc ?? null,
    year: track.year ?? null,
    genre: clean(track.genre),
    durationMs: track.durationMs ?? null,
    cover: track.cover,
    size: track.size,
    mtime: track.mtime,
  }
}

/** A song from a host that sends no tags: everything from its place. */
export function songFromFile(file: MediaFile): Song {
  return songOf({ path: file.path, size: file.size, mtime: file.mtime, cover: false })
}

/**
 * Folders whose audio is not music: a phone's call and voice recordings,
 * messengers' voice notes, a phone's ringtones and system sounds, podcasts.
 * Matched against each folder in a song's path, whole, ignoring case.
 */
const NOT_MUSIC_FOLDERS: RegExp[] = [
  /^call[ _-]?(recordings?|records?|recorder)?$/,
  /^phone ?(record|records|recordings?|calls?)$/,
  /^(recordings?|recorder|voice ?recorder|sound ?recorder|voice ?notes?|voice ?memos?|audio ?recordings?)$/,
  /^(whatsapp|telegram|signal|viber|messenger)( .*)?$/,
  /^(ringtones?|notifications?|alarms?|ui ?sounds?|system ?sounds?)$/,
  /^(podcasts?|audiobooks?)$/,
]

/**
 * Folders that hold music, by their names: wherever one is on a song's path,
 * what is under it is taken for music unless it says otherwise.
 */
const MUSIC_FOLDERS = new Set([
  'music',
  'my music',
  'songs',
  'song',
  'albums',
  'singles',
  'playlists',
  'mp3',
  'mp3s',
  'flac',
  'itunes',
  'itunes media',
  'musik',
  'musique',
  'musica',
  'música',
  'muziek',
  'sindu',
])

/**
 * Folders of programs, games and projects: their sounds are not anybody's
 * music, even in a folder of theirs named Music. Matched whole, ignoring
 * case; a hidden folder (".venv", ".cache") counts too.
 */
const PROGRAM_FOLDERS = new Set([
  'node_modules',
  'venv',
  'site-packages',
  'packagecache',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'windows',
  'steam',
  'steamapps',
  'installed softwares',
  'assets',
  'resources',
  'resource',
  'public',
  'src',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  'debug',
  'tests',
  'test',
  'data',
  'sounds',
  'sfx',
  'cache',
  'temp',
  'tmp',
])

/** An untagged song named "Artist - Title" is at least this long. */
const SHORTEST_NAMED_SONG_MS = 60_000

/** Untagged audio shorter than this is a sound, not a song. */
const SHORTEST_SONG_MS = 30_000

/** Names a recorder or a messenger gives a file, never a song's. */
const NOT_MUSIC_NAMES: RegExp[] = [
  // A phone number, perhaps with a time after it: a call recording.
  /^\+?\d{7,15}([ _-].*)?$/,
  // WhatsApp's voice notes and audio: PTT-20240101-WA0001, AUD-20240101-WA0001.
  /^(ptt|aud)-\d{8}-wa\d+$/i,
  // A recorder's own names: Voice 001, Recording_12, Call recording 2024-01-01.
  /^(voice|recording|rec|call|memo|audio)[ _-]*(recording)?[ _-]*\d/i,
]

/**
 * Whether a song belongs in Music, not just in Files.
 *
 * A drive shared whole holds far more sound than music: programs' and games'
 * sounds, a project's voice takes, a phone's recordings. On one real drive
 * nine of 537 sound files were songs. So music needs something saying it is:
 * tags naming who it is by; a folder for music on its path (not inside a
 * program's); or a name like "Artist - Title" on something song-length. All
 * the rest stays in Files, and plays there as before.
 */
export function isMusic(song: Song, tagged: boolean): boolean {
  if (tagged) return true
  // Shorter than any song: a ringtone, a notification, a voice note.
  if (song.durationMs !== null && song.durationMs < SHORTEST_SONG_MS) return false
  const parts = song.path.split('/')
  const folders = parts.slice(0, -1).map((p) => p.trim().toLowerCase())
  if (folders.some((f) => NOT_MUSIC_FOLDERS.some((re) => re.test(f)))) return false
  const name = parts[parts.length - 1]!
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  if (NOT_MUSIC_NAMES.some((re) => re.test(stem.trim()))) return false
  if (folders.some((f) => PROGRAM_FOLDERS.has(f) || f.startsWith('.'))) return false
  if (folders.some((f) => MUSIC_FOLDERS.has(f))) return true
  return nameParts(stem) !== null && song.durationMs !== null && song.durationMs >= SHORTEST_NAMED_SONG_MS
}

/** Words that say how a song was posted, not what it is called. */
const POSTED =
  /\b(official|music video|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|8k|mv|m\/v|full song|ncs( release)?|no copyright|copyright free( music)?|free download|out now|explicit|audio only|remaster(ed)?( \d{4})?)\b/i

/** Such words left trailing after a title. */
const POSTED_WORDS = new Set([
  'official',
  'audio',
  'video',
  'music',
  'lyrics',
  'lyric',
  'visualizer',
  'visualiser',
  'hd',
  'hq',
  '4k',
  'mv',
  'album',
  'song',
  'full',
  'ncs',
  'release',
  'copyright',
  'free',
])

/** Kinds of music a channel names before "NCS" in its titles. */
const STYLE_WORDS = new Set([
  'melodic',
  'dubstep',
  'house',
  'trap',
  'edm',
  'electronic',
  'dnb',
  'drum',
  'bass',
  'future',
  'chill',
  'lofi',
  'hip',
  'hop',
  'pop',
  'progressive',
  'deep',
])

/**
 * Who and what a song is, from a name like "Artist - Title (Official Video)",
 * the way songs downloaded from video sites are named. Null when the name is
 * not of that shape: "01 Opening", "full-take1".
 */
export function nameParts(stem: string): { artist: string; title: string } | null {
  let name = stem.includes(' ') ? stem : stem.replace(/_/g, ' ')
  // A track number before it all: "01 - Ana - Lanterns", "07. Ana - Lanterns".
  name = name.replace(/^\s*\d{1,3}\s*[-.)]\s+/, '')
  const split = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(name)
  if (!split) return null
  const artist = tidy(split[1]!)
  // More " - " parts after the title: kept unless they only say how it was posted.
  const rest = split[2]!
    .split(/\s+[-\u2013\u2014]\s+/)
    .filter((part, i) => i === 0 || !POSTED.test(part))
    .join(' - ')
  // Trailing words that say how it was posted, and the kinds of music a
  // channel names with them: "Where We Started Melodic Dubstep NCS".
  const words = tidy(rest).split(' ')
  let dropped = false
  while (words.length > 1) {
    const last = words[words.length - 1]!.toLowerCase()
    if (POSTED_WORDS.has(last) || (dropped && STYLE_WORDS.has(last))) {
      dropped ||= last === 'ncs'
      words.pop()
    } else break
  }
  const title = words.join(' ').replace(/[\s\-|:,]+$/, '').trim()
  if (!/\p{L}/u.test(artist) || !/\p{L}/u.test(title) || artist.length > 60) return null
  return { artist, title }
}

/** Brackets saying how it was posted taken out, and the spaces closed up. */
function tidy(text: string): string {
  return text
    .replace(/\s*[([{]([^)\]}]*)[)\]}]/g, (whole, inside: string) => (POSTED.test(inside) ? '' : whole))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Who sings it first: "Ana feat. Bo" is Ana's. */
export function leadArtist(name: string): string {
  return name.split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0]!.trim() || name
}

const key = (value: string): string => value.trim().toLocaleLowerCase()

const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

export function bySongOrder(a: Song, b: Song): number {
  return (
    (a.disc ?? 1) - (b.disc ?? 1) ||
    (a.track ?? 1e9) - (b.track ?? 1e9) ||
    a.title.localeCompare(b.title, undefined, { numeric: true })
  )
}

/** The songs, as albums, by artist and then by year. */
export function albumsOf(songs: Song[]): Album[] {
  const groups = new Map<string, Song[]>()
  for (const song of songs) {
    const id = song.albumArtist
      ? `a:${key(song.albumArtist)}\u0000${key(song.album)}`
      : `f:${key(folderOf(song.path))}\u0000${key(song.album)}`
    const group = groups.get(id)
    if (group) group.push(song)
    else groups.set(id, [song])
  }
  const albums: Album[] = []
  for (const [id, group] of groups) {
    const ordered = [...group].sort(bySongOrder)
    const first = ordered[0]!
    const leads = new Set(ordered.map((s) => key(leadArtist(s.artist))))
    const artist =
      first.albumArtist ?? (leads.size === 1 ? leadArtist(first.artist) : VARIOUS_ARTISTS)
    const years = ordered.map((s) => s.year).filter((y): y is number => y !== null)
    albums.push({
      id,
      title: first.album,
      artist,
      year: years.length ? Math.min(...years) : null,
      songs: ordered,
      coverPath: ordered.find((s) => s.cover)?.path ?? null,
      added: Math.max(...ordered.map((s) => s.mtime)),
      durationMs: ordered.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
    })
  }
  return albums.sort(
    (a, b) =>
      a.artist.localeCompare(b.artist) ||
      (a.year ?? 1e9) - (b.year ?? 1e9) ||
      a.title.localeCompare(b.title),
  )
}

/** Albums, newest arrival first, for "Recently added". */
export function recentAlbums(albums: Album[]): Album[] {
  return [...albums].sort((a, b) => b.added - a.added)
}

/**
 * The artists: everyone an album is by, and everyone who sings a song,
 * so a singer heard only on a compilation still has a page. "Various
 * artists" is not a person and has none.
 */
export function artistsOf(albums: Album[]): Artist[] {
  const artists = new Map<string, Artist>()
  const artistNamed = (name: string): Artist => {
    const id = key(name)
    let artist = artists.get(id)
    if (!artist) {
      artist = { id, name, albums: [], songs: [] }
      artists.set(id, artist)
    }
    return artist
  }
  for (const album of albums) {
    if (album.artist !== VARIOUS_ARTISTS) artistNamed(album.artist).albums.push(album)
    for (const song of album.songs) artistNamed(leadArtist(song.artist)).songs.push(song)
  }
  for (const artist of artists.values()) {
    artist.albums.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title))
  }
  return [...artists.values()]
    .filter((a) => a.name !== UNKNOWN_ARTIST || a.songs.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface MusicSearch {
  songs: Song[]
  albums: Album[]
  artists: Artist[]
}

/** Everything matching every word typed, in title, artist or album. */
export function searchMusic(query: string, albums: Album[], artists: Artist[]): MusicSearch {
  const words = key(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return { songs: [], albums: [], artists: [] }
  const matches = (...fields: (string | null)[]): boolean => {
    const text = key(fields.filter(Boolean).join(' '))
    return words.every((w) => text.includes(w))
  }
  return {
    artists: artists.filter((a) => matches(a.name)),
    albums: albums.filter((a) => matches(a.title, a.artist)),
    songs: albums.flatMap((a) => a.songs).filter((s) => matches(s.title, s.artist, s.album)),
  }
}

/** Kinds of file the music player plays. */
const SONG_EXTENSIONS = new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'alac', 'aiff', 'aif', 'ape', 'wv', 'mka'])

/** Whether a file is a song, by its name, as the host sorts Music. */
export function isSong(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot > 0 && SONG_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** 3:05, or 1:02:09 for something over an hour. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
