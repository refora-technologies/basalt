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
