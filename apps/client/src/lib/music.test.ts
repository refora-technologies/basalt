import { describe, expect, it } from 'vitest'

import type { MusicTrack } from './api'
import {
  VARIOUS_ARTISTS,
  albumsOf,
  artistsOf,
  formatDuration,
  isMusic,
  leadArtist,
  nameParts,
  recentAlbums,
  searchMusic,
  songFromFile,
  songOf,
} from './music'

const track = (path: string, tags: Partial<MusicTrack> = {}): MusicTrack => ({
  path,
  size: 1,
  mtime: 100,
  cover: false,
  ...tags,
})

describe('songOf', () => {
  it('takes the tags', () => {
    const song = songOf(
      track('x/01.mp3', { title: 'Lanterns', artist: 'Juniper Vale', album: 'Lowlight', track: 2, year: 2024 }),
    )
    expect([song.title, song.artist, song.album, song.track, song.year]).toEqual([
      'Lanterns',
      'Juniper Vale',
      'Lowlight',
      2,
      2024,
    ])
  })

  it('describes an untagged song from where it is on the drive', () => {
    const song = songFromFile({ path: 'Music/Juniper Vale/Lowlight/03 Harbour Wall.flac', size: 1, mtime: 1 })
    expect([song.title, song.artist, song.album, song.track]).toEqual([
      'Harbour Wall',
      'Juniper Vale',
      'Lowlight',
      3,
    ])
  })

  it('fills only the tags that are missing', () => {
    const song = songOf(track('Music/Ana/Debut/05 Five.mp3', { title: '  ', artist: 'Ana Ray' }))
    expect([song.title, song.artist, song.album, song.track]).toEqual(['Five', 'Ana Ray', 'Debut', 5])
  })
})

describe('albumsOf', () => {
  it('keeps a compilation as one album, in track order', () => {
    const albums = albumsOf(
      [
        track('C/02.mp3', { title: 'Two', artist: 'Bo', album: 'Hits', albumArtist: 'Various Artists', track: 2 }),
        track('C/01.mp3', { title: 'One', artist: 'Ana', album: 'Hits', albumArtist: 'Various Artists', track: 1 }),
      ].map(songOf),
    )
    expect(albums).toHaveLength(1)
    expect(albums[0]!.artist).toBe('Various Artists')
    expect(albums[0]!.songs.map((s) => s.title)).toEqual(['One', 'Two'])
  })

  it('without an album artist, one folder of different singers is one album by various artists', () => {
    const albums = albumsOf(
      [
        track('Party/1.mp3', { title: 'A', artist: 'Ana', album: 'Party' }),
        track('Party/2.mp3', { title: 'B', artist: 'Bo', album: 'Party' }),
      ].map(songOf),
    )
    expect(albums).toHaveLength(1)
    expect(albums[0]!.artist).toBe(VARIOUS_ARTISTS)
  })

  it('keeps a song with a guest on its album, by its artist', () => {
    const albums = albumsOf(
      [
        track('A/1.mp3', { title: 'Solo', artist: 'Ana', album: 'Debut' }),
        track('A/2.mp3', { title: 'Duet', artist: 'Ana feat. Bo', album: 'Debut' }),
      ].map(songOf),
    )
    expect(albums).toHaveLength(1)
    expect(albums[0]!.artist).toBe('Ana')
  })

  it('orders discs before tracks, and takes the first cover', () => {
    const [album] = albumsOf(
      [
        track('D/a.flac', { title: 'Late', album: 'Set', albumArtist: 'X', disc: 2, track: 1 }),
        track('D/b.flac', { title: 'Early', album: 'Set', albumArtist: 'X', disc: 1, track: 9, cover: true }),
      ].map(songOf),
    )
    expect(album!.songs.map((s) => s.title)).toEqual(['Early', 'Late'])
    expect(album!.coverPath).toBe('D/b.flac')
  })

  it('lists recently added albums newest first', () => {
    const albums = albumsOf(
      [
        track('Old/1.mp3', { album: 'Old', albumArtist: 'A', mtime: 10 }),
        track('New/1.mp3', { album: 'New', albumArtist: 'B', mtime: 99 }),
      ].map(songOf),
    )
    expect(recentAlbums(albums).map((a) => a.title)).toEqual(['New', 'Old'])
  })
})

describe('artistsOf', () => {
  it('gives singers heard only on a compilation a page, but not "various artists"', () => {
    const albums = albumsOf(
      [
        track('C/1.mp3', { title: 'One', artist: 'Ana', album: 'Hits', albumArtist: 'Various artists' }),
        track('A/1.mp3', { title: 'Solo', artist: 'Bo', album: 'Debut' }),
      ].map(songOf),
    )
    const artists = artistsOf(albums)
    expect(artists.map((a) => a.name)).toEqual(['Ana', 'Bo'])
    expect(artists[0]!.albums).toHaveLength(0)
    expect(artists[0]!.songs.map((s) => s.title)).toEqual(['One'])
    expect(artists[1]!.albums.map((a) => a.title)).toEqual(['Debut'])
  })
})

describe('searchMusic', () => {
  it('finds every word in title, artist or album', () => {
    const albums = albumsOf(
      [
        track('A/1.mp3', { title: 'Slow Tide', artist: 'Juniper Vale', album: 'Lowlight' }),
        track('A/2.mp3', { title: 'Lanterns', artist: 'Juniper Vale', album: 'Lowlight' }),
      ].map(songOf),
    )
    const found = searchMusic('juniper tide', albums, artistsOf(albums))
    expect(found.songs.map((s) => s.title)).toEqual(['Slow Tide'])
    expect(searchMusic('lowlight', albums, artistsOf(albums)).albums).toHaveLength(1)
    expect(searchMusic('  ', albums, artistsOf(albums)).songs).toHaveLength(0)
  })
})

describe('little helpers', () => {
  it('names the lead artist', () => {
    expect(leadArtist('Ana feat. Bo')).toBe('Ana')
    expect(leadArtist('Ana ft Bo')).toBe('Ana')
    expect(leadArtist('Simon & Garfunkel')).toBe('Simon & Garfunkel')
  })

  it('says how long', () => {
    expect(formatDuration(185_000)).toBe('3:05')
    expect(formatDuration(3_729_000)).toBe('1:02:09')
    expect(formatDuration(null)).toBe('')
  })
})

describe('isMusic', () => {
  const song = (path: string) => songFromFile({ path, size: 1, mtime: 1 })
  it('leaves out call recordings, voice notes and phone sounds', () => {
    for (const path of [
      'PhoneRecord/94711812918.mp3',
      'Music/94711812918_20240101.m4a',
      'Recordings/Call recordings/Ana.m4a',
      'WhatsApp/Media/WhatsApp Voice Notes/202401/PTT-20240101-WA0001.opus',
      'Downloads/AUD-20231231-WA0042.mp3',
      'Recorder/Voice 001.m4a',
      'Sounds/Recording_12.wav',
      'Ringtones/Bell.ogg',
      'Podcasts/Episode 4.mp3',
    ]) {
      expect(isMusic(song(path), false), path).toBe(false)
    }
  })

  it('leaves out untagged sounds too short to be songs', () => {
    const short = { ...song('Music/Ding.mp3'), durationMs: 4_000 }
    expect(isMusic(short, false)).toBe(false)
    expect(isMusic({ ...short, durationMs: 200_000 }, false)).toBe(true)
  })

  it('keeps songs, and anything tagged as music wherever it is', () => {
    expect(isMusic(song('Music/Juniper Vale/Lowlight/01 Slow Tide.flac'), false)).toBe(true)
    expect(isMusic(song('Music/Records/Blue Hour.mp3'), false)).toBe(true)
    expect(isMusic(song('Basalt Test/Music/The Quiet Coast/Harbour Lights/01 Opening.flac'), false)).toBe(true)
    expect(isMusic(song('WhatsApp/Media/Audio/Lanterns.mp3'), true)).toBe(true)
  })

  it('needs something saying it is music: sounds of programs, games and projects stay in Files', () => {
    // From a real drive shared whole: 9 of its 537 sound files were songs.
    const long = (path: string) => ({ ...song(path), durationMs: 200_000 })
    for (const path of [
      '1999.mp3',
      'Program Files/Steam/steamui/sounds/deck_ui_launch_game.wav',
      'Program Files/Recorder/data/start.wav',
      'Code/analysis/.venv/Lib/site-packages/scipy/io/tests/data/test-44100Hz-le-1ch-4bytes.wav',
      'Coursework/Projects/voice-test/assist/espeak-ng-1.52.0/phsource/ustop/p',
      'Coursework/Projects/game/My project 1/Library/PackageCache/com.unity.timeline@1.6.5/Samples~/GameplaySequenceDemo/Audio/Music.wav',
      'Code/podcast/build/voice/episode-09/full-take1.mp3',
      'Code/video/remotion/public/voice/line-03.mp3',
      'Code/app/target/test/ep1.mka',
      'New folder (3)/Coursework/Assignments/Web/Game/frontback.mp3',
      'Games/Some Game/Music/theme.ogg'.replace('Games/', 'Steam/'),
    ]) {
      expect(isMusic(long(path), false), path).toBe(false)
    }
  })

  it('takes "Artist - Title" names for songs when they are song-length', () => {
    const named = (path: string, durationMs: number | null) => ({ ...song(path), durationMs })
    expect(isMusic(named('Downloads/Ana Marlow - Slow Tide (Lyrics).mp3', 201_000), false)).toBe(true)
    expect(isMusic(named('Downloads/Ana - Hi.mp3', 40_000), false)).toBe(false)
    expect(isMusic(named('Downloads/Ana - Hi.mp3', null), false)).toBe(false)
  })
})

describe('nameParts', () => {
  it('reads who and what from names of downloaded songs', () => {
    const cases: [string, string, string][] = [
      ['Northline - Paper Lanterns (feat. Ada Moss with The Night Office)', 'Northline', 'Paper Lanterns (feat. Ada Moss with The Night Office)'],
      ['Glass Arcade - Come Back Home feat. Ines Hale (NORTHBOUND Remix)', 'Glass Arcade', 'Come Back Home feat. Ines Hale (NORTHBOUND Remix)'],
      ['Kavee - Sanda Eliya ft Mihi Sanda Eliya Album Official Audio', 'Kavee', 'Sanda Eliya ft Mihi Sanda Eliya'],
      ['Dilan Perera - Nil Akasa (Official Music Video)', 'Dilan Perera', 'Nil Akasa'],
      ['Far Coast - Where We Began (feat. Rue) Melodic Dubstep NCS - Copyright Free Music', 'Far Coast', 'Where We Began (feat. Rue)'],
      ['Ana Marlow - Slow Tide (Lyrics)', 'Ana Marlow', 'Slow Tide'],
      ['AC-DC - Back in Black [Official Video]', 'AC-DC', 'Back in Black'],
      ['07. Juniper Vale - Lanterns', 'Juniper Vale', 'Lanterns'],
      ['Juniper_Vale_-_Lanterns', 'Juniper Vale', 'Lanterns'],
    ]
    for (const [stem, artist, title] of cases) expect(nameParts(stem), stem).toEqual({ artist, title })
  })

  it('leaves other names alone', () => {
    for (const stem of ['01 Opening', 'full-take1', 'ep1', 'Track 05', '2024 - 01']) {
      expect(nameParts(stem), stem).toBeNull()
    }
  })

  it('makes an untagged downloaded song a single of its own', () => {
    const song = songFromFile({ path: 'Downloads/Music/Ana Marlow - Slow Tide (Lyrics).mp3', size: 1, mtime: 1 })
    expect([song.title, song.artist, song.album]).toEqual(['Slow Tide', 'Ana Marlow', 'Slow Tide'])
    const tagged = songOf(track('x/Ana - Hi.mp3', { title: 'Hello', artist: 'Ana' }))
    expect([tagged.title, tagged.artist]).toEqual(['Hello', 'Ana'])
  })
})
