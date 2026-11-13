import { useEffect, useState } from 'react'

/**
 * Whether Basalt is on screen: false while a phone's app is in the background
 * or a computer's window is minimised or hidden in the tray. What only matters
 * to someone looking (devices nearby looked for) stops meanwhile.
 */
export function usePageShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const changed = (): void => setShown(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return shown
}
