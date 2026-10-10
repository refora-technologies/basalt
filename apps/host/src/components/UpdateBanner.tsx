import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpCircle, Loader2 } from 'lucide-react'
import { installUpdate, moving, progressLabel, useUpdate } from '@/lib/updates'

/**
 * A newer Basalt Host, at the top of the window where it is seen, rather than
 * at the foot of Settings where nobody scrolls to look.
 *
 * One press does the whole update; "What's new" goes down to the release
 * notes in About.
 */
export function UpdateBanner(): React.JSX.Element {
  const view = useUpdate()
  const offer = view?.available ?? null
  const busy = moving(view)
  const percent = view?.stage.kind === 'downloading' ? view.stage.percent : null

  return (
    <AnimatePresence initial={false}>
      {view && offer && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-lg border border-basalt/25 bg-basalt/[0.06] px-4 py-3"
        >
          <div className="flex items-center gap-3.5">
            <ArrowUpCircle size={16} className="shrink-0 text-basalt" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-text">Basalt Host {offer.version} is available</div>
              <div className="mt-0.5 text-[11px] text-textFaint">
                {!view.canInstall
                  ? 'Update it the way you installed it.'
                  : view.automatic
                    ? 'Installs by itself when nothing is playing, or update now.'
                    : 'Basalt Host closes, updates and opens again by itself.'}
              </div>
            </div>
            <button
              onClick={() =>
                document.getElementById('host-about')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
              className="shrink-0 rounded-md px-2.5 py-1.5 text-[11.5px] text-textFaint transition-colors hover:text-text"
            >
              What’s new
            </button>
            {view.canInstall && (
              <button
                onClick={() => void installUpdate()}
                disabled={busy}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-basalt/40 bg-basalt/15 px-3 py-1.5 text-[11.5px] text-text transition-colors hover:bg-basalt/25 disabled:opacity-70"
              >
                {busy && <Loader2 size={11} className="animate-spin" />}
                {progressLabel(view) ?? 'Update now'}
              </button>
            )}
          </div>
          {percent !== null && (
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-basalt transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
