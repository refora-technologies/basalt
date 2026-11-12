import { useCallback, useEffect, useState } from 'react'

/**
 * "Always ready to receive": on, Basalt keeps a small part running when it
 * is closed (a computer's tray, a phone's quiet notification), so shares
 * reach it and it can say so. Off, it receives only while open. On unless
 * turned off; the same on every device, kept per device.
 */
export function useAlwaysReady(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(read)
  useEffect(() => {
    const changed = (): void => setOn(read())
    window.addEventListener(EVENT, changed)
    return () => window.removeEventListener(EVENT, changed)
  }, [])
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      // Not kept: on again next time.
    }
    setOn(next)
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return [on, set]
}

const KEY = 'basalt.share.alwaysReady'
const EVENT = 'basalt-always-ready'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}
