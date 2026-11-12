import { useState } from 'react'

import { Switch } from '@/components/Switch'
import { clearSyncLog, setSyncLogOn, syncLogText, useSyncLog } from '@/lib/syncLog'
import { cn } from '@/lib/utils'

/**
 * The sync log, for testing music on several devices: off unless turned
 * on; the last lines shown, newest last, and copied whole.
 */
export function SyncLogPanel({ phone }: { phone?: boolean }): React.JSX.Element {
  const { on, lines } = useSyncLog()
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(syncLogText(lines))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1_500)
      })
      .catch(() => {})
  }
  return (
    <div className={phone ? undefined : 'px-4 py-1'}>
      <Switch
        label="Sync log"
        description="For testing devices playing together: each change, how far apart they are and what this one does about it. Kept only until the app closes."
        checked={on}
        onChange={setSyncLogOn}
        className={phone ? 'px-4' : undefined}
      />
      {on && (
        <div className={cn('pb-2', phone ? 'px-4' : '')}>
          <pre
            className={cn(
              'max-h-[220px] overflow-auto rounded-lg bg-black/40 p-2.5 font-mono leading-snug text-textDim',
              phone ? 'text-[10.5px]' : 'text-[11px]',
            )}
          >
            {lines.length === 0 ? 'Nothing yet. Play music together with another device.' : syncLogText(lines.slice(-80))}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={copy}
              disabled={lines.length === 0}
              className="rounded-full border border-white/[0.12] px-3 py-1.5 text-[12px] text-text disabled:opacity-50"
            >
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              type="button"
              onClick={clearSyncLog}
              disabled={lines.length === 0}
              className="rounded-full px-3 py-1.5 text-[12px] text-textDim disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
