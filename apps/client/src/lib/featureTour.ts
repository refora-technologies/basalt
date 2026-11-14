import { useSyncExternalStore } from 'react'

/**
 * The tour of what a version brings, shown once after updating to it.
 *
 * Most updates fix things nobody needs telling about. 1.6.4 changes what
 * Basalt does, and two of its best parts stay off until someone turns them
 * on, so this version shows a few cards the first time it opens. A device
 * that was never used before has the setup steps instead and is not shown
 * them; one that comes from an older version is, once. Settings, About opens
 * them again.
 */

/** The version whose cards there are. A later one with none shows nothing. */
export const TOUR_VERSION = '1.6.4'

const SEEN_KEY = 'basalt.tour.seen'

/**
 * Whether the cards are due: not seen for this version, on a device that was
 * used before. `seen` is the version last shown (none before 1.6.4 kept it);
 * `usedBefore` is what this device had when it started: anything Basalt
 * keeps, or a host it was paired with.
 */
export function tourDue(seen: string | null, usedBefore: boolean, version: string = TOUR_VERSION): boolean {
  if (seen === version) return false
  return seen !== null || usedBefore
}

/**
 * What this device had as it started, read before anything this time keeps
 * something: a fresh install has none of it.
 */
const startedWith: { seen: string | null; kept: boolean } = (() => {
  try {
    const keys = Object.keys(localStorage)
    return {
      seen: localStorage.getItem(SEEN_KEY),
      kept: keys.some((k) => k.startsWith('basalt.') && k !== SEEN_KEY),
    }
  } catch {
    return { seen: TOUR_VERSION, kept: false }
  }
})()

let pairedAtStart: boolean | null = null
let open = false
let decided = false
const listeners = new Set<() => void>()

function tell(): void {
  for (const listener of listeners) listener()
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, TOUR_VERSION)
  } catch {
    // Not kept: shown again next time, which is better than never.
  }
}

/**
 * Called with the first thing known about the drive: whether this device was
 * already paired with a host as it started. Only the first call counts (a
 * fresh install pairs later, in this same run). Decides whether the cards
 * show, once: a device that isn't due is marked seen at once.
 */
export function noteStart(paired: boolean): void {
  if (decided) return
  decided = true
  pairedAtStart = paired
  if (tourDue(startedWith.seen, startedWith.kept || pairedAtStart)) {
    open = true
    tell()
  } else {
    markSeen()
  }
}

/** Opens the cards again (Settings, About). */
export function openTour(): void {
  open = true
  tell()
}

/** Closes them for good: Skip, Done, Esc, Back. */
export function closeTour(): void {
  markSeen()
  open = false
  tell()
}

export function useTourOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open,
  )
}
