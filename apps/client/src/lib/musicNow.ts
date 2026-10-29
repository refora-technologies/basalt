import type { NowSession } from './api'

/**
 * Where a song playing on another device is now, in seconds: where it was
 * when that device last told the host, plus the time since, on the host's
 * clock. `offset` is the host's clock less this device's, so a device whose
 * own clock is wrong still shows the right second. Paused, it stays put.
 */
export function livePosition(session: NowSession, offset: number, nowMs: number): number {
  const { listening, playing, duration } = session.report
  const said = session.report.clock ?? session.at
  const since = playing ? Math.max(0, (nowMs + offset - said) / 1000) : 0
  const at = listening.position + since
  return duration > 0 ? Math.min(at, duration) : at
}

/** The song that device plays, by its path. */
export function songOf(session: NowSession): string | null {
  const { queue, index } = session.report.listening
  return queue[index] ?? null
}

/**
 * Further apart than this, in seconds, devices in sync seek back together. A
 * seek is heard, so closer than this they are brought together by playing
 * a little faster or slower instead.
 */
export const SEEK_ABOVE_SECONDS = 0.25
/** Further apart than this, the one behind or ahead starts to make it up. */
export const NUDGE_ABOVE_SECONDS = 0.012
/** Closer than this, it is in step: two speakers in one room sound as one. */
export const IN_STEP_SECONDS = 0.004
/** The most it plays faster or slower to make it up: a little over 1%, not heard. */
export const MAX_RATE_CHANGE = 0.012
/** How quickly it makes it up: the gap shrinks by about this many seconds' worth. */
const CATCH_UP_SECONDS = 4
/** The most a seek is aimed ahead to make up for its own time. */
export const MAX_LEAD_SECONDS = 1.5
/** How many checks' gaps the speed follows. */
const SMOOTHED = 3

/** What a device playing in sync does to keep to the one it joined. */
export type InStep =
  /** Another song there: play what it plays. */
  | { do: 'load' }
  /** Play at this speed: 1, or a hair faster or slower to make up a gap. */
  | { do: 'rate'; rate: number; lead: number }
  /** Too far apart: seek here, aimed ahead by the time a seek takes. */
  | { do: 'seek'; to: number; lead: number }

/**
 * The step for a device in sync, from the song and second each plays at the
 * same moment.
 *
 * A seek over the network takes a moment to play again, and lands that much
 * behind; `lead` is how far ahead to aim, learnt from where the last seek
 * landed (`landed`: this is the first check since it). A small gap is made
 * up by speed, `rate` being the speed it plays at now: started past
 * [`NUDGE_ABOVE_SECONDS`], kept on until within [`IN_STEP_SECONDS`].
 */
export function keepInStep(step: {
  theirSong: string | null
  mySong: string | null
  /** Where the other is, and this one, at the same moment, in seconds. */
  theirs: number
  mine: number
  lead: number
  landed: boolean
  rate: number
  /**
   * The gaps found at the last few checks, since the last seek. Each is a
   * little off, by how exactly each device could read its own clock; the
   * speed follows their average, not every wobble.
   */
  before?: number[]
}): InStep {
  if (step.theirSong !== step.mySong) return { do: 'load' }
  const behind = step.theirs - step.mine
  const lead = step.landed ? Math.max(0, Math.min(MAX_LEAD_SECONDS, step.lead + behind)) : step.lead
  if (Math.abs(behind) > SEEK_ABOVE_SECONDS) return { do: 'seek', to: step.theirs + lead, lead }
  const gaps = [...(step.before ?? []).slice(-(SMOOTHED - 1)), behind]
  const gap = gaps.reduce((a, b) => a + b, 0) / gaps.length
  const making = step.rate !== 1
  if (Math.abs(gap) > (making ? IN_STEP_SECONDS : NUDGE_ABOVE_SECONDS)) {
    const change = Math.max(-MAX_RATE_CHANGE, Math.min(MAX_RATE_CHANGE, gap / CATCH_UP_SECONDS))
    return { do: 'rate', rate: Math.round((1 + change) * 10_000) / 10_000, lead }
  }
  return { do: 'rate', rate: 1, lead }
}

/** One read of the player's clock: the song's second, when (Unix ms), and how long the read took. */
export interface Reading {
  position: number
  at: number
  took: number
}

/**
 * Where the song is, to the millisecond, from quick reads of the player's
 * clock: the second it would show at Unix time 0 at this speed, so the
 * second at a moment `t` is `start + rate * t / 1000`. Null without reads.
 *
 * A read is only as exact as its round trip, so the slowest third are left
 * out. The player moves its clock on in small steps (on a computer, every
 * 30 ms or so), so a read is up to a step behind: the freshest reads, near
 * the top, are the truest.
 */
export function startOf(readings: Reading[], rate = 1): number | null {
  if (readings.length === 0) return null
  const quick = [...readings].sort((a, b) => a.took - b.took).slice(0, Math.max(1, Math.ceil((readings.length * 2) / 3)))
  const starts = quick.map((r) => r.position - (rate * r.at) / 1000).sort((a, b) => a - b)
  return starts[Math.min(starts.length - 1, Math.floor(starts.length * 0.8))]!
}

/** Where the song was, by the reads, and when (Unix ms). */
export interface Estimate {
  position: number
  at: number
}

/** How far each new reading moves the estimate: a quarter, so its wobble is mostly smoothed away. */
const TRUST_NEW = 0.25
/** A reading this far from where the song should be is a seek or a new song: taken as it is. */
const JUMPED_SECONDS = 0.15

/**
 * Where the song is, from the last estimate and a new reading of it. A song
 * plays on at a steady speed, so where it should be is known; each reading
 * is a little off (on a phone, by up to a few hundredths of a second), so it
 * only moves the estimate part of the way. A reading far from it, after a
 * seek or a new song, starts again from there.
 */
export function smoothed(last: Estimate | null, reading: Estimate, rate: number): Estimate {
  if (!last || reading.at < last.at) return reading
  const expected = last.position + (rate * (reading.at - last.at)) / 1000
  const off = reading.position - expected
  if (Math.abs(off) > JUMPED_SECONDS) return reading
  return { position: expected + TRUST_NEW * off, at: reading.at }
}

/** One answer from the host: its clock less this device's, and the round trip it took. */
export interface ClockSample {
  offset: number
  took: number
  at: number
}

/**
 * The host's clock less this device's, from recent answers: the one with
 * the quickest round trip, whose middle is surest to be when the host
 * answered. Older than a minute, they are let go, as the clocks drift.
 */
export function bestOffset(samples: ClockSample[], nowMs: number): number | null {
  const recent = samples.filter((s) => nowMs - s.at < 60_000)
  if (recent.length === 0) return null
  return recent.reduce((best, s) => (s.took < best.took ? s : best)).offset
}
