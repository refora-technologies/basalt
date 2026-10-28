import { describe, expect, it } from 'vitest'

import { type NowPlayingInfo, claimPress, needsTelling, pressForKey } from './systemMedia'

const song: NowPlayingInfo = {
  title: 'One More Time',
  artist: 'Daft Punk',
  album: 'Discovery',
  cover: null,
  duration: 320,
  position: 10,
  playing: true,
  canPrevious: true,
  canNext: true,
}

describe('the system media controls', () => {
  it('are told once at first, and again only when something changes', () => {
    expect(needsTelling(null, song, 0)).toBe(true)
    const shown = { info: song, at: 0 }
    // Playing on: the system moves its own bar.
    expect(needsTelling(shown, { ...song, position: 15 }, 5000)).toBe(false)
    expect(needsTelling(shown, { ...song, playing: false, position: 15 }, 5000)).toBe(true)
    expect(needsTelling(shown, { ...song, title: 'Aerodynamic', position: 0 }, 5000)).toBe(true)
    // A seek: far from where playing would have taken it.
    expect(needsTelling(shown, { ...song, position: 200 }, 5000)).toBe(true)
  })

  it('hear a paused song stay where it is', () => {
    const paused = { info: { ...song, playing: false }, at: 0 }
    expect(needsTelling(paused, { ...song, playing: false }, 60_000)).toBe(false)
    expect(needsTelling(paused, { ...song, playing: false, position: 90 }, 60_000)).toBe(true)
  })

  it('act on one press once, though it arrives as a key and through the system', () => {
    expect(claimPress('toggle', 1000)).toBe(true)
    expect(claimPress('play', 1100)).toBe(false)
    expect(claimPress('next', 1100)).toBe(true)
    expect(claimPress('toggle', 2000)).toBe(true)
  })

  it('know the keyboard media keys', () => {
    expect(pressForKey('MediaPlayPause')).toBe('toggle')
    expect(pressForKey('MediaTrackNext')).toBe('next')
    expect(pressForKey('a')).toBeNull()
  })
})
