import type { NowSession } from './api'

/**
 * Where a song playing on another device is now, in seconds: where it was
 * when that device last told the host, plus the time since, on the host's
 * clock. `offset` is the host's clock less this device's, so a device whose
 * own clock is wrong still shows the right second. Paused, it stays put.
 */
export function livePosition(session: NowSession, offset: number, nowMs: number): number {
  const { listening, playing, duration } = session.report
  const since = playing ? Math.max(0, (nowMs + offset - session.at) / 1000) : 0
  const at = listening.position + since
  return duration > 0 ? Math.min(at, duration) : at
}

/** The song that device plays, by its path. */
export function songOf(session: NowSession): string | null {
  const { queue, index } = session.report.listening
  return queue[index] ?? null
}

/** Further apart than this, devices in sync are brought back together, in seconds. */
export const IN_STEP_SECONDS = 0.25
/** The most a seek is aimed ahead to make up for its own time. */
export const MAX_LEAD_SECONDS = 1.5

/** What a device playing in sync does to keep to the one it joined. */
export type InStep =
  /** Another song there: play what it plays. */
  | { do: 'load' }
  | { do: 'nothing'; lead: number }
  /** Too far apart: seek here, aimed ahead by the time a seek takes. */
  | { do: 'seek'; to: number; lead: number }

/**
 * The step for a device in sync, from the song and second each plays.
 *
 * A seek over the network takes a moment to play again, and lands that much
 * behind; `lead` is how far ahead to aim, learnt from where the last seek
 * landed (`landed`: this is the first check since it).
 */
export function keepInStep(step: {
  theirSong: string | null
  mySong: string | null
  /** Where the other is now, and this one, in seconds. */
  theirs: number
  mine: number
  lead: number
  landed: boolean
}): InStep {
  if (step.theirSong !== step.mySong) return { do: 'load' }
  const behind = step.theirs - step.mine
  const lead = step.landed ? Math.max(0, Math.min(MAX_LEAD_SECONDS, step.lead + behind)) : step.lead
  if (Math.abs(behind) > IN_STEP_SECONDS) return { do: 'seek', to: step.theirs + lead, lead }
  return { do: 'nothing', lead }
}
