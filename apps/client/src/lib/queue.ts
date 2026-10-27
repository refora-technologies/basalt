/**
 * What plays next: the music player's queue.
 *
 * A list of songs and the order they play in. Shuffle changes the order, not
 * the list, so turning it off goes back to the album's order from the song
 * playing now. Every change returns a new queue; nothing here plays anything.
 *
 * Saved as `Listening` on the host (see `api.musicMine`), so it carries on
 * from another device: the songs in playing order, which one, and how far in.
 */

import type { Listening } from './api'

export type Repeat = 'off' | 'all' | 'one'

export interface Queue {
  /** Vault paths, in the order they were added. */
  songs: string[]
  /** Indexes into `songs`, in the order they play. */
  order: number[]
  /** Where in `order` the song playing now is. */
  at: number
  shuffle: boolean
  repeat: Repeat
  /** What it plays from: an album's name, a playlist's, Liked Songs. */
  from: string
}

/** Back within this many seconds of a song's start goes to the one before. */
export const RESTART_AFTER = 3

type Random = () => number

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

/** `items` in a random order (Fisher-Yates). */
function shuffled<T>(items: T[], random: Random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** A queue of `songs`, starting at `start`; shuffled, it starts there and the rest are mixed. */
export function queueOf(
  songs: string[],
  start: number,
  from: string,
  shuffle = false,
  random: Random = Math.random,
): Queue {
  const first = Math.min(Math.max(0, start), Math.max(0, songs.length - 1))
  const order = shuffle
    ? [first, ...shuffled(range(songs.length).filter((i) => i !== first), random)]
    : range(songs.length)
  return { songs, order, at: shuffle ? 0 : first, shuffle, repeat: 'off', from }
}

/** The song playing now, or null for an empty queue. */
export function current(queue: Queue): string | null {
  const index = queue.order[queue.at]
  return index === undefined ? null : (queue.songs[index] ?? null)
}

/** The songs still to come, in playing order. */
export function upNext(queue: Queue): string[] {
  return queue.order.slice(queue.at + 1).map((i) => queue.songs[i]!)
}

/**
 * The queue after a song ends, or after Next. Null when there is nothing
 * after it. `ended` is a song finishing by itself: only then does "repeat
 * one" play it again; Next always moves on.
 */
export function next(queue: Queue, ended = false): Queue | null {
  if (queue.order.length === 0) return null
  if (ended && queue.repeat === 'one') return { ...queue }
  if (queue.at + 1 < queue.order.length) return { ...queue, at: queue.at + 1 }
  if (queue.repeat === 'off') return null
  return { ...queue, at: 0 }
}

/**
 * The queue after Previous: the start of this song again when it is past
 * its first few seconds, as every music player does; otherwise the one
 * before (round to the end with repeat on). `restart` says which.
 */
export function previous(queue: Queue, position: number): { queue: Queue; restart: boolean } {
  if (position > RESTART_AFTER || queue.order.length === 0) return { queue, restart: true }
  if (queue.at > 0) return { queue: { ...queue, at: queue.at - 1 }, restart: false }
  if (queue.repeat !== 'off') return { queue: { ...queue, at: queue.order.length - 1 }, restart: false }
  return { queue, restart: true }
}

/** Shuffle on or off, carrying on from the song playing now either way. */
export function setShuffle(queue: Queue, on: boolean, random: Random = Math.random): Queue {
  if (on === queue.shuffle) return queue
  const playing = queue.order[queue.at]
  if (playing === undefined) return { ...queue, shuffle: on }
  if (on) {
    const played = queue.order.slice(0, queue.at)
    const rest = shuffled(queue.order.slice(queue.at + 1), random)
    return { ...queue, shuffle: true, order: [...played, playing, ...rest] }
  }
  return { ...queue, shuffle: false, order: range(queue.songs.length), at: playing }
}

/** Off, then all, then one, then off. */
export function cycleRepeat(queue: Queue): Queue {
  const repeat: Repeat = queue.repeat === 'off' ? 'all' : queue.repeat === 'all' ? 'one' : 'off'
  return { ...queue, repeat }
}

/** Songs to play straight after this one. */
export function playNext(queue: Queue, paths: string[]): Queue {
  const added = range(paths.length).map((i) => queue.songs.length + i)
  return {
    ...queue,
    songs: [...queue.songs, ...paths],
    order: [...queue.order.slice(0, queue.at + 1), ...added, ...queue.order.slice(queue.at + 1)],
  }
}

/** Songs to play after everything already queued. */
export function addToQueue(queue: Queue, paths: string[]): Queue {
  const added = range(paths.length).map((i) => queue.songs.length + i)
  return { ...queue, songs: [...queue.songs, ...paths], order: [...queue.order, ...added] }
}

/** Takes one song still to come out of the queue: `index` counts in `upNext`. */
export function removeUpNext(queue: Queue, index: number): Queue {
  const at = queue.at + 1 + index
  if (index < 0 || at >= queue.order.length) return queue
  return { ...queue, order: [...queue.order.slice(0, at), ...queue.order.slice(at + 1)] }
}

/** Moves one song still to come to another place among those to come. */
export function moveUpNext(queue: Queue, from: number, to: number): Queue {
  const coming = queue.order.slice(queue.at + 1)
  if (from < 0 || from >= coming.length || to < 0 || to >= coming.length) return queue
  const [moved] = coming.splice(from, 1)
  coming.splice(to, 0, moved!)
  return { ...queue, order: [...queue.order.slice(0, queue.at + 1), ...coming] }
}

/** The queue as the host keeps it: the songs in playing order. */
export function toListening(queue: Queue, position: number, now: number): Listening {
  return {
    queue: queue.order.map((i) => queue.songs[i]!),
    index: queue.at,
    position: Math.max(0, position),
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    from: queue.from,
    updated: now,
  }
}

/**
 * A queue from what the host kept, to carry on with, and where in the song.
 * The songs come back in the order they were playing, so a shuffled queue
 * carries on in the same shuffle.
 */
export function fromListening(listening: Listening): { queue: Queue; position: number } {
  const songs = listening.queue
  return {
    queue: {
      songs,
      order: range(songs.length),
      at: Math.min(Math.max(0, listening.index), Math.max(0, songs.length - 1)),
      shuffle: listening.shuffle,
      repeat: listening.repeat,
      from: listening.from,
    },
    position: listening.position,
  }
}
