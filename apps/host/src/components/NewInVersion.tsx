import { useSyncExternalStore } from 'react'
import { Share } from 'lucide-react'

/**
 * What 1.6.4 brings to the host, said once after updating to it: a note, not
 * cards, since the one new thing here is what it keeps for devices. A host
 * set up fresh has nothing to compare with and is not shown it. Approved as
 * plans/mockups/1.6.4-whats-new.html, part 04.
 */

const VERSION = '1.6.4'
const SEEN_KEY = 'basalt.host.new.seen'

let decided = false
let shown = false
const listeners = new Set<() => void>()

function tell(): void {
  for (const listener of listeners) listener()
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, VERSION)
  } catch {
    // Not kept: shown again next time.
  }
}

/** Whether the note is due: not seen for this version, on a host that was sharing a drive as it started. */
export function noteDue(seen: string | null, hadDrive: boolean): boolean {
  return seen !== VERSION && hadDrive
}

/**
 * Called with the first status: whether this host already shared a drive as
 * it started. Only the first call counts (a fresh one chooses its drive
 * later, in this same run).
 */
export function noteHostStart(hadDrive: boolean): void {
  if (decided) return
  decided = true
  let seen: string | null = VERSION
  try {
    seen = localStorage.getItem(SEEN_KEY)
  } catch {
    // Nothing kept: as if seen.
  }
  if (noteDue(seen, hadDrive)) {
    shown = true
    tell()
  } else {
    markSeen()
  }
}

function close(): void {
  markSeen()
  shown = false
  tell()
}

export function NewInVersion(): React.JSX.Element | null {
  const open = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown,
  )
  if (!open) return null
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-white/[0.14] bg-[#151517] px-[18px] py-4">
      <Share size={18} className="mt-px shrink-0 self-start text-text" />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-text">New in {VERSION}: sharing between devices</div>
        <div className="mt-1 text-[12.5px] leading-relaxed text-textDim [text-wrap:pretty]">
          Your devices can now send each other files. When one is off, this host keeps them, locked and apart from your
          drive, until it’s back.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <button type="button" onClick={close} className="px-1.5 py-1 text-[12.5px] font-semibold text-textFaint hover:text-text">
          Close
        </button>
        <button
          type="button"
          onClick={() => {
            close()
            document.getElementById('sharing-between-devices')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
          className="rounded-full bg-text px-3.5 py-2 text-[12.5px] font-bold text-black hover:bg-white"
        >
          See settings
        </button>
      </div>
    </div>
  )
}
