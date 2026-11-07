import { useCallback, useEffect, useState } from 'react'
import { FolderInput, HardDrive, Trash2 } from 'lucide-react'

import { api, type HeldShare } from '@/lib/api'
import { formatBytes } from '@/lib/utils'

/**
 * Shared through host: what this person sent that the host keeps, locked,
 * for a device that was away, or kept after its answer. Each can be moved
 * onto the drive (unlocked in place, nothing downloaded) or deleted.
 */
export function HeldList({ onChanged }: { onChanged?: (count: number) => void }): React.JSX.Element {
  const [held, setHeld] = useState<HeldShare[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const answer = await api.shareHeld()
      setHeld(answer.held)
      onChanged?.(answer.held.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setHeld([])
    }
  }, [onChanged])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'delete' | 'move', share: HeldShare): Promise<void> => {
    setBusy(share.id)
    setError(null)
    try {
      await api.shareManage(action, share.id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (held === null) return <p className="px-4 py-3 text-[12.5px] text-textFaint">Asking the host…</p>
  if (held.length === 0) {
    return <p className="px-4 py-3 text-[12.5px] leading-relaxed text-textFaint">Nothing you sent is kept on the host.</p>
  }
  return (
    <div className="py-1">
      <p className="px-4 pb-1 pt-1 text-[12px] leading-relaxed text-textFaint">
        Kept on the host, locked. Only you and the device it’s for can read it.
      </p>
      {held.map((share) => {
        const size = share.files.reduce((sum, f) => sum + f.size, 0)
        const title = share.files.length === 1 ? share.files[0]!.name : `${share.files[0]?.name ?? ''} and ${share.files.length - 1} more`
        const state = share.state === 'waiting' ? `For ${share.toName} · waiting` : `${share.toName} ${share.state} · kept`
        return (
          <div key={share.id} className="flex items-center gap-3 px-4 py-2.5">
            <HardDrive size={16} className="shrink-0 text-textDim" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] text-text">{title}</span>
              <span className="block truncate text-[11.5px] text-textFaint">
                {state} · {formatBytes(size)}
              </span>
            </span>
            <button
              disabled={busy !== null}
              onClick={() => void act('move', share)}
              title="Move it onto the drive, where everyone who uses the drive sees it"
              className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1.5 text-[12px] text-text disabled:opacity-50"
            >
              <FolderInput size={13} />
              To the drive
            </button>
            <button
              disabled={busy !== null}
              onClick={() => void act('delete', share)}
              aria-label="Delete it from the host"
              title="Delete it from the host"
              className="flex h-8 w-8 items-center justify-center rounded-full text-danger hover:bg-danger/[0.1] disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
      {error && <p className="px-4 pb-2 text-[12px] text-danger">{error}</p>}
    </div>
  )
}
