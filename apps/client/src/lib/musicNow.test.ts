import { describe, expect, it } from 'vitest'

import type { NowSession } from './api'
import { bestOffset, keepInStep, livePosition, smoothed, songOf, startOf } from './musicNow'

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
  const step = (theirs: number, mine: number, lead = 0, landed = false, rate = 1) =>
    keepInStep({ theirSong: 'a.mp3', mySong: 'a.mp3', theirs, mine, lead, landed, rate })

  it('plays the other one’s song when they differ', () => {
    expect(keepInStep({ theirSong: 'b.mp3', mySong: 'a.mp3', theirs: 10, mine: 10, lead: 0, landed: false, rate: 1 })).toEqual({ do: 'load' })
  })

  it('leaves a few milliseconds alone', () => {
    expect(step(60.01, 60)).toEqual({ do: 'rate', rate: 1, lead: 0 })
    expect(step(60, 60.01)).toEqual({ do: 'rate', rate: 1, lead: 0 })
  })

  it('makes up a small gap by playing a hair faster or slower, not by a seek that is heard', () => {
    // 40 ms behind: a hair faster. 40 ms ahead: a hair slower.
    expect(step(60.04, 60)).toEqual({ do: 'rate', rate: 1.01, lead: 0 })
    expect(step(60, 60.04)).toEqual({ do: 'rate', rate: 0.99, lead: 0 })
    // Never more than a little over 1% for a small gap; 2% for a wider one.
    expect(step(60.045, 60)).toEqual({ do: 'rate', rate: 1.0113, lead: 0 })
    expect(step(60.2, 60)).toEqual({ do: 'rate', rate: 1.02, lead: 0 })
  })

  it('keeps making it up until within a few milliseconds, then plays at its own speed', () => {
    expect(step(60.008, 60, 0, false, 1.002)).toEqual({ do: 'rate', rate: 1.002, lead: 0 })
    expect(step(60.003, 60, 0, false, 1.002)).toEqual({ do: 'rate', rate: 1, lead: 0 })
    // Not started for under 12 ms.
    expect(step(60.008, 60)).toEqual({ do: 'rate', rate: 1, lead: 0 })
  })

  it('follows the average of the last few gaps, not every wobble in reading them', () => {
    // 20 ms ahead now, but behind and level just before: on average in step.
    expect(keepInStep({ theirSong: 'a', mySong: 'a', theirs: 60, mine: 60.02, lead: 0, landed: false, rate: 1, before: [0.02, 0] })).toEqual({
      do: 'rate',
      rate: 1,
      lead: 0,
    })
    // Behind each time: made up.
    expect(keepInStep({ theirSong: 'a', mySong: 'a', theirs: 60.04, mine: 60, lead: 0, landed: false, rate: 1, before: [0.04, 0.04] })).toEqual({
      do: 'rate',
      rate: 1.01,
      lead: 0,
    })
  })

  it('seeks when further apart, either way', () => {
    expect(step(61, 60)).toEqual({ do: 'seek', to: 61, lead: 0 })
    expect(step(60, 61)).toEqual({ do: 'seek', to: 60, lead: 0 })
  })

  it('learns how far behind a seek lands, and aims that far ahead', () => {
    // The first seek landed 0.4 s behind: seeking again, it aims 0.4 s ahead.
    expect(step(70, 69.6, 0, true)).toMatchObject({ do: 'seek', to: expect.closeTo(70.4, 5), lead: expect.closeTo(0.4, 5) })
    // Landed close: the lead barely moves.
    expect(step(80, 80.05, 0.4, true)).toMatchObject({ do: 'rate', lead: expect.closeTo(0.35, 5) })
    expect(step(90, 89, 0.4)).toEqual({ do: 'seek', to: 90.4, lead: 0.4 })
  })

  it('aims less far when a seek lands ahead, and never behind or wildly ahead', () => {
    expect(step(70, 70.3, 0.4, true)).toMatchObject({ lead: expect.closeTo(0.1, 5) })
    expect(step(70, 71, 0.2, true)).toMatchObject({ lead: 0 })
    expect(step(70, 60, 1, true)).toMatchObject({ lead: 1.5 })
  })
})

describe('reading the player’s clock to the millisecond', () => {
  it('takes the freshest of the quick reads: a read is up to a step behind', () => {
    // Playing from 10 s at Unix ms 0; the clock moves on every 30 ms, so the
    // reads lag 0 to 30 ms behind.
    const readings = [0, 13, 26, 39, 52, 65, 78, 91, 104, 117].map((t) => ({
      position: 10 + (Math.floor(t / 30) * 30) / 1000,
      at: t,
      took: 2,
    }))
    const start = startOf(readings)!
    expect(start).toBeGreaterThan(10 - 0.015)
    expect(start).toBeLessThanOrEqual(10)
  })

  it('leaves out reads that took long, whose moment is unsure', () => {
    const readings = [
      { position: 10, at: 0, took: 2 },
      { position: 10.02, at: 20, took: 2 },
      { position: 10.04, at: 40, took: 2 },
      // Took 60 ms: its middle may be 30 ms off.
      { position: 10.2, at: 60, took: 60 },
    ]
    expect(startOf(readings)).toBeCloseTo(10, 5)
  })

  it('counts the speed it plays at', () => {
    const readings = [0, 100, 200].map((t) => ({ position: 10 + (1.01 * t) / 1000, at: t, took: 1 }))
    expect(startOf(readings, 1.01)).toBeCloseTo(10, 5)
    expect(startOf([])).toBeNull()
  })
})

describe('smoothing the readings over time', () => {
  it('moves only part of the way toward a reading that is a little off', () => {
    const last = { position: 10, at: 0 }
    // Two seconds on it should be at 12; read at 12.04, it takes 12.01.
    expect(smoothed(last, { position: 12.04, at: 2_000 }, 1).position).toBeCloseTo(12.01, 5)
    // Playing a hair faster, it should be further on.
    expect(smoothed(last, { position: 12.02, at: 2_000 }, 1.01).position).toBeCloseTo(12.02, 5)
  })

  it('takes a reading far off as it is: a seek or a new song', () => {
    expect(smoothed({ position: 10, at: 0 }, { position: 40, at: 1_000 }, 1)).toEqual({ position: 40, at: 1_000 })
    expect(smoothed(null, { position: 5, at: 1 }, 1)).toEqual({ position: 5, at: 1 })
  })

  it('wobbling readings settle near the truth', () => {
    let estimate: { position: number; at: number } | null = null
    const wobble = [0.03, -0.03, 0.025, -0.02, 0.03, -0.03, 0.02, -0.025]
    wobble.forEach((off, i) => {
      estimate = smoothed(estimate, { position: 10 + i + off, at: i * 1_000 }, 1)
    })
    expect(Math.abs(estimate!.position - 17)).toBeLessThan(0.015)
  })
})

describe('the host’s clock', () => {
  it('trusts the answer with the quickest round trip, of the last minute', () => {
    const samples = [
      { offset: 5_040, took: 80, at: 100_000 },
      { offset: 5_002, took: 4, at: 110_000 },
      { offset: 5_020, took: 30, at: 120_000 },
    ]
    expect(bestOffset(samples, 125_000)).toBe(5_002)
    // A minute on, the quick one is let go.
    expect(bestOffset(samples, 171_000)).toBe(5_020)
    expect(bestOffset([], 0)).toBeNull()
  })
})
