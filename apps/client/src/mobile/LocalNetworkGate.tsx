import { useCallback, useEffect, useState } from 'react'
import { Loader2, Settings, Wifi } from 'lucide-react'
import { inTauri } from '@/lib/api'
import { android, type LocalNetworkState } from '@/lib/android'

/**
 * Whether Android lets Basalt reach the home network, asked again whenever
 * the app comes back to the screen: from Settings, say, where it may have
 * just been allowed. `null` until known.
 *
 * In the browser preview, `?localnet=ask` or `?localnet=denied` shows the
 * screen below.
 */
export function useLocalNetwork(): {
  state: LocalNetworkState | null
  request: () => Promise<void>
} {
  const [state, setState] = useState<LocalNetworkState | null>(null)
  const check = useCallback(async () => {
    if (!inTauri()) {
      const preview = new URLSearchParams(window.location.search).get('localnet')
      setState(preview === 'ask' || preview === 'denied' ? preview : 'granted')
      return
    }
    setState(await android.localNetwork().catch(() => 'granted' as const))
  }, [])
  useEffect(() => {
    void check()
    const onShow = (): void => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [check])
  const request = useCallback(async () => {
    if (!inTauri()) {
      setState('granted')
      return
    }
    setState(await android.requestLocalNetwork().catch(() => 'denied' as const))
  }, [])
  return { state, request }
}

/**
 * Asked for before anything else, on an Android that asks: without it Basalt
 * reaches nothing on the network, and every screen after this would only say
 * the drive is not answering, which would not be why.
 */
export function LocalNetworkGate({
  state,
  onRequest,
}: {
  state: 'ask' | 'denied'
  onRequest: () => Promise<void>
}): React.JSX.Element {
  const [asking, setAsking] = useState(false)
  const denied = state === 'denied'

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.1] bg-panel2 text-basalt">
        <Wifi size={26} />
      </span>
      <h1 className="mt-6 text-[21px] font-semibold tracking-tight text-text">
        {denied ? 'Basalt can’t reach your drive' : 'Let Basalt reach your drive'}
      </h1>
      <p className="mt-2 max-w-[320px] text-[13.5px] leading-relaxed text-textDim">
        {denied
          ? 'It was turned off for Basalt. In Settings, under Permissions, allow Nearby devices, then come back.'
          : 'Your files are on a computer at home. Android asks before an app connects to devices on your home network, so Basalt needs a yes to find it.'}
      </p>
      <button
        onClick={() => {
          if (denied) {
            void android.openAppSettings()
            return
          }
          setAsking(true)
          void onRequest().finally(() => setAsking(false))
        }}
        disabled={asking}
        className="mt-8 flex h-11 w-full max-w-[320px] items-center justify-center gap-2 rounded-lg bg-basalt text-[14px] font-medium text-ink transition-opacity disabled:opacity-50"
      >
        {asking ? <Loader2 size={15} className="animate-spin" /> : denied ? <Settings size={15} /> : null}
        {denied ? 'Open Settings' : 'Allow'}
      </button>
    </div>
  )
}
