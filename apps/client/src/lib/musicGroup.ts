import type { MusicGroup } from './api'

/**
 * Devices playing together, as the host keeps them (1.6.4): the host holds
 * the group's song, whether it plays, and where it is at a moment on the
 * host's clock; every member, the one that asked included, plays that. A
 * change is stamped a moment ahead so all of them act at the same instant.
 */

/** Where the group's song is at `hostMs` (the host's clock), in seconds. */
export function groupPosition(group: MusicGroup, hostMs: number): number {
  const { position } = group.listening
  if (!group.playing || hostMs <= group.at) return position
  return position + (hostMs - group.at) / 1000
}

/** The song the group plays, by its path. */
export function groupSong(group: MusicGroup): string | null {
  return group.listening.queue[group.listening.index] ?? null
}

/** A group id the host made (1.6.4), as against the 1.6.3 groups named after a device. */
export function isHostGroup(id: string | undefined | null): id is string {
  return typeof id === 'string' && /^g\d+$/.test(id)
}

/** What this device does to play the group's state. */
export type GroupStep =
  /** Another song: open it from `from`, starting at `at` (local ms) when given, paused when `paused`. */
  | { do: 'open'; from: number; at: number | null; paused: boolean }
  /** The same song, to play from `from` at `at` (local ms): a start, a seek, or a moment ahead. */
  | { do: 'playAt'; from: number; at: number }
  /** Paused, at `position`, at `at` (local ms). */
  | { do: 'pause'; position: number; at: number }
  /** Already as it should be. */
  | { do: 'nothing' }

/** Closer than this, in seconds, a device playing is left to the keeping in step. */
const CLOSE_ENOUGH_S = 0.25
/** A device that must start late does so this far ahead, to land in step. */
const START_AHEAD_MS = 300

/**
 * What to do, here, to play `group`: from the song this device plays, if
 * it plays, and where it is now; `offset` is the host's clock less this
 * device's; `nowMs` this device's clock.
 */
export function stepFor(
  group: MusicGroup,
  here: { song: string | null; playing: boolean; position: number },
  offset: number,
  nowMs: number,
): GroupStep {
  const at = group.at - offset
  const position = (local: number): number => groupPosition(group, local + offset)
  if (groupSong(group) !== here.song) {
    const when = Math.max(at, nowMs)
    return { do: 'open', from: position(when), at: group.playing && at > nowMs ? at : null, paused: !group.playing }
  }
  if (!group.playing) {
    if (!here.playing && Math.abs(here.position - group.listening.position) <= CLOSE_ENOUGH_S) return { do: 'nothing' }
    return { do: 'pause', position: group.listening.position, at: Math.max(at, nowMs) }
  }
  // A start or a seek ahead: all of them at that moment.
  if (at > nowMs) return { do: 'playAt', from: position(at), at }
  const there = position(nowMs)
  if (here.playing && Math.abs(there - here.position) <= CLOSE_ENOUGH_S) return { do: 'nothing' }
  return { do: 'playAt', from: position(nowMs + START_AHEAD_MS), at: nowMs + START_AHEAD_MS }
}
