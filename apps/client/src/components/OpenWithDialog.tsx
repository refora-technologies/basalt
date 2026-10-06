import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Download, FolderOpen, PlayCircle } from 'lucide-react'
import { useBack } from '@/mobile/useBack'
import { api, type ExternalPlayer } from '@/lib/api'
import { pickProgram } from '@/lib/dialogs'
import { preferredPlayer, type PlayerChoice } from '@/lib/playerChoice'
import { cn } from '@/lib/utils'

export interface OpenWithRequest {
  /** The file on the drive. */
  path: string
  name: string
  /** Why the app is asking rather than just playing, when it is not the person's own question. */
  reason?: string
}

/**
 * Which player a film goes to, on Windows: Basalt's own "Open with".
 *
 * Not Windows' dialog. That one hands a program a file, and there is no file
 * here, only a stream from the media proxy; Windows' list for a playlist
 * pointing at the stream would include its own apps, which cannot open one,
 * and fail with nothing said. So this lists the players on the computer that
 * are known to stream, with the one Windows uses for this type marked, and
 * lets any other program be picked by hand.
 *
 * Copying the film out is offered only when there is no player to give it
 * to, and only as a button that says what it does.
 */
export function OpenWithDialog({
  request,
  onClose,
  onPlay,
  onCopy,
}: {
  request: OpenWithRequest | null
  onClose: () => void
  onPlay: (path: string, player: PlayerChoice, always: boolean) => void
  onCopy: (path: string) => void
}): React.JSX.Element {
  return createPortal(
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
          onMouseDown={onClose}
        >
          <Card request={request} onClose={onClose} onPlay={onPlay} onCopy={onCopy} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Card({
  request,
  onClose,
  onPlay,
  onCopy,
}: {
  request: OpenWithRequest
  onClose: () => void
  onPlay: (path: string, player: PlayerChoice, always: boolean) => void
  onCopy: (path: string) => void
}): React.JSX.Element {
  useBack(true, () => {
    onClose()
    return true
  })
  const [players, setPlayers] = useState<ExternalPlayer[] | null>(null)
  const [always, setAlways] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const preferred = preferredPlayer()
  const type = request.name.includes('.') ? request.name.slice(request.name.lastIndexOf('.')) : ''

  useEffect(() => {
    void api
      .externalPlayers(request.name)
      .then((found) => {
        // A program picked by hand before is offered again, after the rest.
        const known = found.some((p) => p.path.toLowerCase() === preferred?.path.toLowerCase())
        setPlayers(
          preferred && !known ? [...found, { ...preferred, isDefault: false }] : found,
        )
      })
      .catch(() => setPlayers([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.name])

  const play = (player: PlayerChoice): void => onPlay(request.path, player, always)

  const another = async (): Promise<void> => {
    setProblem(null)
    const path = await pickProgram()
    if (!path) return
    const name = await api.playerName(path).catch(() => null)
    if (!name) {
      setProblem('That is not a program Basalt can start.')
      return
    }
    play({ name, path })
  }

  const none = players !== null && players.length === 0

  return (
    <motion.div
      role="dialog"
      aria-modal
      aria-label="Open with"
      initial={{ opacity: 0, scale: 0.97, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 6 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-[420px] rounded-lg border border-white/10 bg-panel2 p-4 shadow-lift"
    >
      <h2 className="text-[13px] font-semibold text-text">Open with</h2>
      <p className="mt-1 truncate text-[12px] text-textFaint" title={request.name}>
        {request.name}
      </p>
      {(request.reason || none) && (
        <p className="mt-3 text-[12px] leading-relaxed text-textDim">
          {request.reason ??
            'No player that can stream was found on this computer. Pick one you have, or install VLC.'}
        </p>
      )}

      <div className="mt-3 overflow-hidden rounded-md border border-line">
        {players === null && (
          <div className="px-3 py-3 text-[12px] text-textFaint">Looking for players…</div>
        )}
        {players?.map((player) => (
          <button
            key={player.path}
            onClick={() => play(player)}
            className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-white/[0.04]"
          >
            <PlayCircle size={15} className="shrink-0 text-textDim" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[12.5px] text-text">
                {player.name}
                {player.isDefault && <Tag>Default for {type || 'this type'}</Tag>}
                {preferred?.path.toLowerCase() === player.path.toLowerCase() && <Tag>Your choice</Tag>}
              </span>
              <span className="block truncate font-mono text-[10px] text-textFaint" title={player.path}>
                {player.path}
              </span>
            </span>
          </button>
        ))}
        <button
          onClick={() => void another()}
          className={cn(
            'flex w-full items-center gap-3 px-3 py-2.5 text-left text-[12.5px] text-textDim transition-colors hover:bg-white/[0.04] hover:text-text',
            players && players.length > 0 && 'border-t border-line',
          )}
        >
          <FolderOpen size={15} className="shrink-0" />
          Choose another program…
        </button>
      </div>
      {problem && <p className="mt-2 text-[11.5px] text-danger">{problem}</p>}

      <button
        onClick={() => setAlways((a) => !a)}
        className="mt-3 flex items-center gap-2 text-[12px] text-textDim transition-colors hover:text-text"
      >
        <span
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded border',
            always ? 'border-white/60 bg-white text-black' : 'border-white/25',
          )}
        >
          {always && <Check size={11} strokeWidth={3} />}
        </span>
        Always use this player
      </button>

      <div className="mt-4 flex items-center justify-between gap-2">
        {none || request.reason ? (
          <button
            onClick={() => onCopy(request.path)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] text-textFaint transition-colors hover:bg-white/[0.05] hover:text-textDim"
          >
            <Download size={12} />
            Download it and open the copy
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-[12px] text-textDim transition-colors hover:bg-white/[0.05] hover:text-text"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  )
}

function Tag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded border border-white/[0.1] px-1.5 py-px font-mono text-[9.5px] text-textFaint">
      {children}
    </span>
  )
}
