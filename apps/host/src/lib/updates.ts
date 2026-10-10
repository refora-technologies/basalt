import { useSyncExternalStore } from 'react'
import { api, type UpdateView } from '@/lib/api'

/**
 * Updates, as the host itself keeps them, shared by everything that shows
 * them: the banner at the top of the window and About read the same state,
 * and so does a device that manages this host, in Manage host.
 *
 * The host looks for a new version by itself (a minute after starting, then
 * every twelve hours) and, with automatic updates on, puts it in when nothing
 * is being watched or copied. This only asks where things stand: often while
 * something is under way, so a download's progress moves; rarely otherwise.
 */

let view: UpdateView | null = null
const listeners = new Set<() => void>()

function set(next: UpdateView): void {
  view = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Where updates stand, or null before the host has said. */
export function useUpdate(): UpdateView | null {
  return useSyncExternalStore(subscribe, () => view)
}

/** Something is happening that the screen should follow closely. */
export function moving(v: UpdateView | null): boolean {
  return v?.stage.kind === 'checking' || v?.stage.kind === 'downloading' || v?.stage.kind === 'installing'
}

async function refresh(): Promise<void> {
  try {
    set(await api.updateStatus())
  } catch {
    // The host answers again in a moment.
  }
}

let started = false

/** Follows the host's update state for as long as the window is open. */
export function startUpdateChecks(): void {
  if (started) return
  started = true
  const tick = (): void => {
    void refresh().finally(() => setTimeout(tick, moving(view) ? 700 : 5000))
  }
  tick()
}

/** Looks for a newer release now. */
export async function checkForUpdate(): Promise<void> {
  if (view) set({ ...view, stage: { kind: 'checking' } })
  try {
    set(await api.checkUpdate())
  } catch {
    await refresh()
  }
}

/** Downloads, checks and puts the newest release in; the host restarts. */
export async function installUpdate(): Promise<void> {
  try {
    set(await api.installUpdate())
  } catch {
    await refresh()
  }
}

export async function setAutomaticUpdates(enabled: boolean): Promise<void> {
  try {
    set(await api.setAutomaticUpdates(enabled))
  } catch {
    await refresh()
  }
}

/** What the update button says while it works. */
export function progressLabel(v: UpdateView): string | null {
  switch (v.stage.kind) {
    case 'checking':
      return 'Checking…'
    case 'downloading':
      return `Downloading ${v.stage.percent}%`
    case 'installing':
      return 'Installing…'
    default:
      return null
  }
}
