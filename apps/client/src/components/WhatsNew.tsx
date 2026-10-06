import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, ArrowUpCircle, ExternalLink, Loader2, X } from 'lucide-react'
import { Sheet } from '@/mobile/Sheet'
import { useBack } from '@/mobile/useBack'
import { PLAY_STORE } from '@/lib/channel'
import { openExternal } from '@/lib/links'
import { isMobileShell } from '@/lib/platform'
import {
  checkForUpdate,
  closeWhatsNew,
  downloadUpdate,
  installUpdate,
  offered,
  useUpdate,
  useWhatsNewOpen,
  type UpdateState,
} from '@/lib/updates'
import { cn, formatBytes } from '@/lib/utils'
import { ReleaseNotes } from './ReleaseNotes'

/**
 * What a new version brings, and the one button that gets it.
 *
 * Every place that announces an update opens this: the phone's banner and its
 * notification, the dot on More, the Windows sidebar, the line in Settings.
 * The notes are the release's own, from GitHub; in the Play build Play says
 * which version is waiting and the notes are read from the GitHub release of
 * that version.
 *
 * GitHub copies download and install here as they always have. The Play
 * copy hands the download to Google Play, which fetches it while Basalt stays
 * open, and then restarts into it.
 */
export function WhatsNew(): React.JSX.Element | null {
  const open = useWhatsNewOpen()
  const state = useUpdate()
  const shown = open && (offered(state) || state.kind === 'failed')

  if (isMobileShell()) {
    return (
      <Sheet open={shown} onClose={closeWhatsNew} tall>
        {shown && <Body state={state} />}
      </Sheet>
    )
  }

  return createPortal(
    <AnimatePresence>
      {shown && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={closeWhatsNew}
        >
          <Card state={state} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Card({ state }: { state: UpdateState }): React.JSX.Element {
  useBack(true, () => {
    closeWhatsNew()
    return true
  })
  return (
    <motion.div
      role="dialog"
      aria-modal
      aria-label="What's new"
      initial={{ opacity: 0, scale: 0.97, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 6 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      onMouseDown={(e) => e.stopPropagation()}
      className="relative flex max-h-[min(640px,86vh)] w-[480px] flex-col rounded-xl border border-white/10 bg-panel2 shadow-lift"
    >
      <button
        onClick={closeWhatsNew}
        aria-label="Close"
        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-textFaint transition-colors hover:bg-white/[0.07] hover:text-text"
      >
        <X size={14} />
      </button>
      <Body state={state} />
    </motion.div>
  )
}

/** The popup's contents, the same in the phone's sheet and the desktop card. */
function Body({ state }: { state: UpdateState }): React.JSX.Element {
  const release = offered(state) ? state.release : null
  const ready = state.kind === 'ready'
  const downloading = state.kind === 'downloading'
  const percent =
    downloading && state.total > 0 ? Math.round((state.had / state.total) * 100) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-5">
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-basalt">
        <ArrowUpCircle size={13} />
        {ready ? 'Ready to install' : state.kind === 'failed' ? 'Update' : 'Update available'}
      </div>
      <div className="mt-2 text-[22px] font-semibold tracking-tight text-text">
        {release ? `Basalt ${release.version}` : 'Basalt'}
      </div>
      {release && (
        <div className="mt-1 font-mono text-[11px] text-textFaint">
          {PLAY_STORE ? 'From Google Play' : 'From GitHub, verified before installing'}
        </div>
      )}

      {release && (
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-white/[0.07] pt-4">
          {release.notes ? (
            <ReleaseNotes notes={release.notes} />
          ) : (
            <p className="text-[12.5px] leading-relaxed text-textDim">
              This version brings fixes and improvements.
            </p>
          )}
          {!PLAY_STORE && release.pageUrl && (
            <button
              onClick={() => void openExternal(release.pageUrl)}
              className="mt-4 flex items-center gap-1.5 text-[11.5px] text-textFaint transition-colors hover:text-text"
            >
              <ExternalLink size={11} />
              Read it on GitHub
            </button>
          )}
        </div>
      )}

      {state.kind === 'failed' && (
        <div className="mt-4 flex items-start gap-2 text-[12.5px] text-danger">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{state.why}</span>
        </div>
      )}

      {downloading && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={cn(
                'h-full rounded-full bg-basalt transition-[width] duration-200',
                percent === null && 'w-1/3 animate-pulse',
              )}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          <div className="tnum mt-1.5 font-mono text-[11px] text-textFaint">
            {percent !== null
              ? `${percent}% · ${formatBytes(state.had)} of ${formatBytes(state.total)}`
              : PLAY_STORE
                ? 'Waiting for Google Play…'
                : 'Starting…'}
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center gap-2">
        {state.kind === 'failed' ? (
          <Primary onClick={() => void checkForUpdate(false)}>Try again</Primary>
        ) : ready ? (
          <Primary onClick={() => void installUpdate()}>
            {PLAY_STORE ? 'Restart to update' : 'Install and restart'}
          </Primary>
        ) : (
          <Primary onClick={() => void downloadUpdate()} disabled={downloading}>
            {downloading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Downloading
              </>
            ) : PLAY_STORE ? (
              'Update now'
            ) : (
              `Download${release && release.installerBytes > 0 ? ` · ${formatBytes(release.installerBytes)}` : ''}`
            )}
          </Primary>
        )}
        <button
          onClick={closeWhatsNew}
          className="rounded-lg px-4 py-2.5 text-[13px] text-textDim transition-colors hover:bg-white/[0.05] hover:text-text"
        >
          {downloading ? 'Hide' : 'Later'}
        </button>
      </div>
    </div>
  )
}

function Primary({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {children}
    </button>
  )
}
