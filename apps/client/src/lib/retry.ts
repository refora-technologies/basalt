import { ApiError } from './api'

/**
 * When a request to the host failed in a way that passes.
 *
 * A host restarting (an update installing itself, the computer waking) drops
 * its connections, and requests made in that moment fail as "offline" or
 * "unavailable" though the host is back a second later. Taken as final, they
 * left Music empty, or its songs without tags and covers, until the app was
 * restarted: a failure was read as "this host is too old to answer". Those
 * are asked again a few times first. A host that is too old says so
 * ("unsupported"), or keeps hanging up, and is believed after the last try.
 */
export function worthAskingAgain(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true
  return e.kind === 'offline' || e.kind === 'unavailable' || e.kind === 'error'
}

/** How long to wait before each try again, in milliseconds. */
export const ASK_AGAIN_AFTER = [2_000, 4_000, 8_000]
