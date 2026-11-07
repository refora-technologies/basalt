import { useEffect, useState } from 'react'

/**
 * A log of how devices playing together keep in step, for testing: each
 * change of the group, the gap at each check, a speed change or a seek.
 * Off unless turned on in Settings; kept in memory only, the last few
 * hundred lines, and copied from there.
 */

const KEY = 'basalt.syncLog'
const MOST = 400

export interface SyncLine {
  /** Unix ms on this device. */
  at: number
  text: string
}

let lines: SyncLine[] = []
const listeners = new Set<() => void>()

export function syncLogOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setSyncLogOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    // Kept for this run only.
  }
  if (!on) lines = []
  listeners.forEach((l) => l())
}

/** One line, when the log is on. */
export function syncLog(text: string): void {
  if (!syncLogOn()) return
  lines = [...lines.slice(-(MOST - 1)), { at: Date.now(), text }]
  listeners.forEach((l) => l())
}

/** The lines as text, one each, with the time to the millisecond. */
export function syncLogText(list: SyncLine[] = lines): string {
  return list
    .map((l) => {
      const d = new Date(l.at)
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
      return `${time} ${l.text}`
    })
    .join('\n')
}

export function clearSyncLog(): void {
  lines = []
  listeners.forEach((l) => l())
}

/** The log and whether it is on, kept up to date. */
export function useSyncLog(): { on: boolean; lines: SyncLine[] } {
  const [state, setState] = useState(() => ({ on: syncLogOn(), lines }))
  useEffect(() => {
    const update = (): void => setState({ on: syncLogOn(), lines })
    listeners.add(update)
    return () => {
      listeners.delete(update)
    }
  }, [])
  return state
}
