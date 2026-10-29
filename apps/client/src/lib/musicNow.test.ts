import { describe, expect, it } from 'vitest'

import type { NowSession } from './api'
import { livePosition, songOf } from './musicNow'

const session = (playing: boolean, position = 30, at = 1_000_000): NowSession => ({
  device: 'laptop',
  name: 'Maya’s laptop',
  form: 'computer',
  at,
  report: {
    listening: { queue: ['a.mp3', 'b.mp3'], index: 1, position, shuffle: false, repeat: 'off', from: 'Lowlight', updated: 0 },
    playing,
    duration: 200,
  },
})

describe('where a song on another device is now', () => {
  it('moves on while it plays, on the host’s clock', () => {
    // This device's clock is 5 s behind the host's: offset +5000.
    expect(livePosition(session(true), 5_000, 1_000_000 - 5_000 + 10_000)).toBeCloseTo(40)
  })

  it('stays put while paused', () => {
    expect(livePosition(session(false), 0, 1_090_000)).toBe(30)
  })

  it('never runs past the end of the song', () => {
    expect(livePosition(session(true), 0, 1_000_000 + 600_000)).toBe(200)
  })

  it('names the song it plays', () => {
    expect(songOf(session(true))).toBe('b.mp3')
  })
})
