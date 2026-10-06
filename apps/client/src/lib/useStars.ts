import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Entry } from '@/components/FileList'
import { ApiError, api } from './api'

/**
 * Starred files, kept on this device.
 *
 * Deliberately local rather than stored on the host. A star is a note about how
 * *you* use the drive, not a property of the file — two people sharing a vault
 * should not be rearranging each other's favourites, and nothing on the drive
 * should have to change because someone clicked a star.
 *
 * Keyed by host id, so pairing with a second vault does not show the first
 * one's stars against paths that may not exist there.
 */

const KEY_PREFIX = 'basalt:stars:'

/** What is remembered, so the list can be drawn before anything is fetched. */
interface StarRecord {
  path: string
  name: string
  kind: 'dir' | 'file'
}

function keyFor(hostId: string | null | undefined): string | null {
  return hostId ? `${KEY_PREFIX}${hostId}` : null
}

function load(hostId: string | null | undefined): StarRecord[] {
  const key = keyFor(hostId)
  if (!key) return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is StarRecord =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as StarRecord).path === 'string' &&
        typeof (r as StarRecord).name === 'string',
    )
  } catch {
    // Corrupt storage is not worth failing over; the worst case is a lost
    // list of favourites.
    return []
  }
}

function save(hostId: string | null | undefined, records: StarRecord[]): void {
  const key = keyFor(hostId)
  if (!key) return
  try {
    window.localStorage.setItem(key, JSON.stringify(records))
  } catch {
    // Storage full or disabled. Stars stop persisting; nothing else breaks.
  }
}

export interface Stars {
  /** Paths, for testing membership while drawing a list. */
  paths: Set<string>
  /** The starred items, with fresh metadata once it has been fetched. */
  entries: Entry[]
  loading: boolean
  isStarred: (path: string) => boolean
  toggle: (entries: Entry[]) => void
  /** Re-reads size and date from the host, dropping anything since deleted. */
  refresh: () => Promise<void>
}

/**
 * Stars are kept on the host for a profile, so they follow the person from
 * device to device, and on the device for a device on its own, as before.
 * `profileId` says which.
 *
 * A profile's list is read from the host again whenever it could have
 * changed elsewhere: when Starred is opened, and when the app comes back to
 * the front. It used to be read once, when the profile opened, so a star
 * added on the computer never reached the phone until the app restarted.
 *
 * Every change is made to the host's list as it is now, not to this
 * device's copy: read, change, write. Writing this device's whole list back
 * would quietly undo a star another device had just added.
 */
export function useStars(
  hostId: string | null | undefined,
  active: boolean,
  profileId: string | null = null,
): Stars {
  const [records, setRecords] = useState<StarRecord[]>(() => (profileId ? [] : load(hostId)))
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const latest = useRef(records)
  latest.current = records

  /** The list as it stands where it is kept: the host for a profile. */
  const read = useCallback(async (): Promise<StarRecord[]> => {
    if (!profileId) return load(hostId)
    return await api.profileStars()
  }, [hostId, profileId])

  /** Changes the list where it is kept, starting from what is there now. */
  const change = useCallback(
    async (edit: (current: StarRecord[]) => StarRecord[]): Promise<StarRecord[]> => {
      if (!profileId) {
        const next = edit(load(hostId))
        save(hostId, next)
        return next
      }
      const current = await api.profileStars().catch(() => latest.current)
      const next = edit(current)
      await api.profileStars(next.map((r) => ({ path: r.path, name: r.name, kind: r.kind })))
      return next
    },
    [hostId, profileId],
  )

  /** Reads the list again. Returns it, or null when the host did not answer. */
  const reload = useCallback(async (): Promise<StarRecord[] | null> => {
    try {
      const fresh = await read()
      setRecords(fresh)
      return fresh
    } catch {
      return null
    }
  }, [read])

  useEffect(() => {
    setEntries([])
    setRecords(profileId ? [] : load(hostId))
    void reload()
  }, [hostId, profileId, reload])

  const paths = useMemo(() => new Set(records.map((r) => r.path)), [records])

  /** Size and date for each star, from the host; a star whose file is gone is dropped. */
  const describe = useCallback(
    async (list: StarRecord[]) => {
      if (list.length === 0) {
        setEntries([])
        return
      }
      setLoading(true)
      try {
        const found: Entry[] = []
        const gone = new Set<string>()
        for (const record of list) {
          try {
            const fresh = await api.stat(record.path)
            found.push({
              id: record.path,
              name: fresh.name,
              kind: fresh.kind,
              size: fresh.size,
              modified: fresh.mtime * 1000,
            })
          } catch (e) {
            // A star pointing at something deleted is dropped rather than
            // shown as a row that fails whenever it is touched. Only when
            // the host says it is gone: a dropped connection is not that.
            if (e instanceof ApiError && e.kind === 'notfound') gone.add(record.path)
          }
        }
        setEntries(found)
        if (gone.size > 0) {
          const next = await change((current) => current.filter((r) => !gone.has(r.path))).catch(
            () => null,
          )
          if (next) setRecords(next)
        }
      } finally {
        setLoading(false)
      }
    },
    [change],
  )

  /** Starred, opened: the list as it is now, described. */
  const refresh = useCallback(async () => {
    const fresh = (await reload()) ?? latest.current
    await describe(fresh)
  }, [reload, describe])

  // Read again each time Starred is opened, not only the first time.
  useEffect(() => {
    if (active) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hostId, profileId])

  // And when the app comes back to the front: the stars marked in every
  // list are then the ones another device has just set too.
  const shown = useRef(active)
  shown.current = active
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState !== 'visible') return
      if (shown.current) void refresh()
      else void reload()
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [refresh, reload])

  const toggle = useCallback(
    (chosen: Entry[]) => {
      // If any of the chosen items is not starred, the whole group becomes
      // starred; otherwise the whole group is unstarred. Toggling each one
      // individually would leave a mixed selection half-starred, which is
      // never what anyone means.
      const known = new Set(latest.current.map((r) => r.path))
      const adding = chosen.some((e) => !known.has(e.id))
      const ids = new Set(chosen.map((e) => e.id))
      const edit = (current: StarRecord[]): StarRecord[] => applyStars(current, chosen, adding)

      // Shown at once; then made on the host's own list, and that is kept.
      const optimistic = edit(latest.current)
      setRecords(optimistic)
      if (shown.current) {
        setEntries((now) => (adding ? now : now.filter((e) => !ids.has(e.id))))
      }
      void change(edit)
        .then((next) => {
          setRecords(next)
          if (shown.current && adding) void describe(next)
        })
        .catch(() => {})
    },
    [change, describe],
  )

  return {
    paths,
    entries,
    loading,
    isStarred: (path: string) => paths.has(path),
    toggle,
    refresh,
  }
}

/**
 * The next list after a star press: the whole group starred, or the whole
 * group unstarred, decided by what this device shows.
 */
export function nextStars(
  current: { path: string }[],
  chosen: { id: string; name: string; kind: 'dir' | 'file' }[],
): { path: string }[] {
  const known = new Set(current.map((r) => r.path))
  return applyStars(current, chosen, chosen.some((e) => !known.has(e.id)))
}

/**
 * One press, made on a list that may have changed since it was decided on:
 * adds or removes only the chosen paths, and leaves whatever another device
 * did to the rest alone.
 */
export function applyStars<T extends { path: string }>(
  current: T[],
  chosen: { id: string; name: string; kind: 'dir' | 'file' }[],
  adding: boolean,
): Array<T | { path: string; name: string; kind: 'dir' | 'file' }> {
  const ids = new Set(chosen.map((e) => e.id))
  if (!adding) return current.filter((r) => !ids.has(r.path))
  const have = new Set(current.map((r) => r.path))
  return [
    ...current,
    ...chosen
      .filter((e) => !have.has(e.id))
      .map((e) => ({ path: e.id, name: e.name, kind: e.kind })),
  ]
}
