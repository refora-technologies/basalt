import { android } from './android'
import { PLAY_STORE } from './channel'

/**
 * Asking for a rating on Google Play, once, when it is earned.
 *
 * Only in the Play build, only after a third film watched to the end, and
 * not before a week has passed since Basalt first opened: by then the person
 * knows whether it works for them. The request is made when a film ends with
 * nothing after it, a pause in the evening rather than the middle of one.
 *
 * Google decides whether its sheet actually appears and never says whether a
 * rating was left, so this asks once and never again, whatever came of it.
 */

const KEY = 'basalt.review'
const FILMS = 3
const WAIT_MS = 7 * 24 * 60 * 60 * 1000
/** Long enough for the end of the film to have settled on screen. */
const DELAY_MS = 2500

export interface ReviewRecord {
  /** When Basalt first opened, in milliseconds since 1970. */
  first: number
  /** Films watched to the end. */
  watched: number
  asked: boolean
}

/** Whether this is the moment to ask. */
export function shouldAsk(record: ReviewRecord, now: number): boolean {
  return !record.asked && record.watched >= FILMS && now - record.first >= WAIT_MS
}

function read(): ReviewRecord | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ReviewRecord) : null
  } catch {
    return null
  }
}

function write(record: ReviewRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(record))
  } catch {
    // Storage full or refused: the worst outcome is not asking.
  }
}

/** Remembers when Basalt first opened. Called once per launch. */
export function noteLaunch(now = Date.now()): void {
  if (!PLAY_STORE || read()) return
  write({ first: now, watched: 0, asked: false })
}

/**
 * A film watched to the end. `more` is whether another episode follows, in
 * which case it counts but the asking waits for a film that ends the evening.
 */
export function noteFilmFinished(more: boolean, now = Date.now()): void {
  if (!PLAY_STORE) return
  const record = read() ?? { first: now, watched: 0, asked: false }
  record.watched += 1
  const ask = !more && shouldAsk(record, now)
  if (ask) record.asked = true
  write(record)
  if (ask) setTimeout(() => void android.playReview().catch(() => {}), DELAY_MS)
}
