import { createContext, useContext } from 'react'

import type { Listening } from './api'
import type { Queue } from './queue'

/**
 * The music player, as the screens see it.
 *
 * Music plays in a player of its own, not the full-screen one films open:
 * it keeps playing while you browse, under a bar at the bottom, and opens
 * full screen only when asked. Provided once for the whole app by
 * `MusicPlayer`; null where there is none (the browser preview of a film).
 */
export interface MusicPlayerApi {
  queue: Queue | null
  /** The song playing or paused now, by path. */
  current: string | null
  paused: boolean
  /** Plays `paths` from `index`, named after what they came from. */
  play: (paths: string[], index: number, from: string, shuffle?: boolean) => void
  /** Carries on with what was playing: the same queue, from the same second. */
  resume: (listening: Listening) => void
  playNext: (paths: string[]) => void
  addToQueue: (paths: string[]) => void
  togglePause: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  setShuffle: (on: boolean) => void
  cycleRepeat: () => void
  removeUpNext: (index: number) => void
  moveUpNext: (from: number, to: number) => void
  /** Opens or closes the full-screen player. */
  setExpanded: (open: boolean) => void
  expanded: boolean
  /** Stops and forgets the queue. */
  stop: () => void
}

export const MusicPlayerContext = createContext<MusicPlayerApi | null>(null)

export function useMusicPlayer(): MusicPlayerApi | null {
  return useContext(MusicPlayerContext)
}

/**
 * Where the song is, apart from the rest: it changes several times a second,
 * and only the bar and the full player show it. In the player's own context,
 * every screen would draw again on every tick.
 */
export interface MusicClock {
  /** Seconds into the song, and its length. */
  position: number
  duration: number
  /** 0 to 100. */
  volume: number
  setVolume: (volume: number) => void
}

export const MusicClockContext = createContext<MusicClock>({
  position: 0,
  duration: 0,
  volume: 100,
  setVolume: () => {},
})

export function useMusicClock(): MusicClock {
  return useContext(MusicClockContext)
}
