import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, ShieldAlert } from 'lucide-react'
import { api, ApiError, type Firewall } from '@/lib/api'

/** How soon coming back to the window looks again. */
const LOOK_AGAIN_MS = 20_000

/**
 * The computer's firewall turning other devices away, and the fix.
 *
 * Windows usually asks, the first time the host listens, whether to let it
 * through; with that question turned off for a network, it says nothing and
 * blocks. Phones then see the host in their list and cannot open it, and
 * nothing on this screen would say why. So it is said here, at the top, with
 * the one button that fixes it: Windows asks for an administrator, and a rule
 * letting Basalt Host in is added.
 *
 * Looked at when the window opens, and again when it is come back to, since
 * joining another network can change the answer.
 */
export function FirewallNotice(): React.JSX.Element {
  const [state, setState] = useState<Firewall>('unknown')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastLook = useRef(0)

  const look = useCallback(() => {
    lastLook.current = Date.now()
    void api
      .firewall()
      .then(setState)
      .catch(() => setState('unknown'))
  }, [])

  useEffect(() => {
    look()
    const onFocus = (): void => {
      if (Date.now() - lastLook.current > LOOK_AGAIN_MS) look()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [look])

  const allow = async (): Promise<void> => {
    setAsking(true)
    setError(null)
    try {
      const now = await api.allowThroughFirewall()
      setState(now)
      if (now === 'blocked') {
        setError('Basalt Host was allowed through Windows Firewall, but something else is still blocking devices.')
      }
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e))
    } finally {
      setAsking(false)
    }
  }

  return (
    <AnimatePresence initial={false}>
      {state === 'blocked' && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden rounded-lg border border-danger/25 bg-dangerBg px-4 py-3.5"
        >
          <div className="flex items-start gap-3.5">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-text">
                Your other devices can’t reach this computer
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-textDim">
                Windows Firewall is blocking Basalt Host on this network, so phones and computers
                can see this host but can’t open the drive. Allow it once to fix this. Windows asks
                for an administrator.
              </p>
              {error && <p className="mt-1.5 text-[11.5px] leading-relaxed text-danger">{error}</p>}
            </div>
            <button
              onClick={() => void allow()}
              disabled={asking}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-basalt/40 bg-basalt/15 px-3 py-1.5 text-[11.5px] text-text transition-colors hover:bg-basalt/25 disabled:opacity-70"
            >
              {asking && <Loader2 size={11} className="animate-spin" />}
              {asking ? 'Waiting for Windows…' : 'Allow'}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
