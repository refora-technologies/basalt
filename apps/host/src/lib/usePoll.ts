import { useCallback, useEffect, useRef, useState } from 'react'
import { Poller } from './poll'

/**
 * Keeps a ref pointing at the latest value without re-running anything.
 *
 * The reason this exists is the eight-uploads bug in the client: a callback
 * recreated on every render was in an effect's dependency list, so the effect
 * tore down and set up again constantly. Reading the current value through a
 * ref means the poller is created once and lives for the component's life,
 * whatever the caller passes.
 */
function useLatest<T>(value: T): React.RefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}

export interface Polled<T> {
  data: T | null
  /** The last error, cleared by the next success. */
  error: string | null
  /** True until the first answer of any kind arrives. */
  loading: boolean
  /** Ask again now, after an action that changed something. */
  refresh: () => void
  /** Replace the value locally, for a command that already returned one. */
  set: (value: T) => void
}

/**
 * Polls a command and keeps the last good answer on screen.
 *
 * Deliberately **not** clearing `data` on error: a momentary failure should not
 * blank the dashboard and make the app look broken. The error is reported
 * alongside the stale value, and the interface decides how loudly to say so.
 */
export function usePoll<T>(fetcher: () => Promise<T>, interval: number): Polled<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const latestFetcher = useLatest(fetcher)
  const poller = useRef<Poller<T> | null>(null)
  const last = useRef<string | null>(null)

  useEffect(() => {
    const instance = new Poller<T>({
      fetch: () => latestFetcher.current(),
      interval,
      onData: (value) => {
        // The same answer again (most of them) draws nothing.
        const said = JSON.stringify(value)
        if (said !== last.current) {
          last.current = said
          setData(value)
        }
        setError(null)
        setLoading(false)
      },
      onError: (e) => {
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    })
    poller.current = instance
    instance.start()
    // Hidden in the tray: nothing asked until it's shown again.
    const shown = (): void => {
      if (document.visibilityState === 'hidden') instance.pause()
      else instance.resume()
    }
    shown()
    document.addEventListener('visibilitychange', shown)
    return () => {
      document.removeEventListener('visibilitychange', shown)
      instance.stop()
      poller.current = null
    }
    // `interval` only. The fetcher is read through a ref precisely so that an
    // inline arrow function in the caller does not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval])

  const refresh = useCallback(() => poller.current?.refresh(), [])

  const set = useCallback((value: T) => {
    last.current = JSON.stringify(value)
    setData(value)
  }, [])

  return { data, error, loading, refresh, set }
}
