import { describe, expect, it } from 'vitest'

import type { NowSession } from './api'
import { keepInStep, livePosition, songOf } from './musicNow'

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

describe('keeping two devices in step', () => {
  const step = (theirs: number, mine: number, lead = 0, landed = false) =>
    keepInStep({ theirSong: 'a.mp3', mySong: 'a.mp3', theirs, mine, lead, landed })

  it('plays the other one’s song when they differ', () => {
    expect(keepInStep({ theirSong: 'b.mp3', mySong: 'a.mp3', theirs: 10, mine: 10, lead: 0, landed: false })).toEqual({ do: 'load' })
  })

  it('leaves a quarter second or less alone: a seek is heard, that is not', () => {
    expect(step(60.2, 60)).toEqual({ do: 'nothing', lead: 0 })
    expect(step(60, 60.2)).toEqual({ do: 'nothing', lead: 0 })
  })

  it('seeks when further apart, either way', () => {
    expect(step(61, 60)).toEqual({ do: 'seek', to: 61, lead: 0 })
    expect(step(60, 61)).toEqual({ do: 'seek', to: 60, lead: 0 })
  })

  it('learns how far behind a seek lands, and aims that far ahead', () => {
    // The first seek landed 0.4 s behind: seeking again, it aims 0.4 s ahead.
    expect(step(70, 69.6, 0, true)).toMatchObject({ do: 'seek', to: expect.closeTo(70.4, 5), lead: expect.closeTo(0.4, 5) })
    // Landed close: the lead barely moves.
    expect(step(80, 80.05, 0.4, true)).toMatchObject({ do: 'nothing', lead: expect.closeTo(0.35, 5) })
    expect(step(90, 89, 0.4)).toEqual({ do: 'seek', to: 90.4, lead: 0.4 })
  })

  it('aims less far when a seek lands ahead, and never behind or wildly ahead', () => {
    expect(step(70, 70.3, 0.4, true)).toMatchObject({ lead: expect.closeTo(0.1, 5) })
    expect(step(70, 71, 0.2, true)).toMatchObject({ lead: 0 })
    expect(step(70, 60, 1, true)).toMatchObject({ lead: 1.5 })
  })
})
