import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { TourArt, type ArtName } from '../TourArt'

/**
 * A small thing worth knowing, said once where it happens, with a little
 * moving picture: not on a card of its own, which would cover what it is
 * about. It shows the first time its moment comes and not again; × hides it
 * at once. The once is spent when it's in view, not when it's merely drawn:
 * at the foot of a long Settings page it waits until scrolled to.
 */
export function Tip({
  id,
  art,
  title,
  line,
  compact,
  className,
}: {
  /** Kept per device: `basalt.tip.<id>`. */
  id: string
  art: ArtName
  title: string
  line: string
  /** In a computer's small corner card. */
  compact?: boolean
  className?: string
}): React.JSX.Element | null {
  const key = `basalt.tip.${id}`
  const [shown, setShown] = useState(() => !seen(key))
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!shown) return undefined
    const el = box.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      markSeen(key)
      return undefined
    }
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          markSeen(key)
          watch.disconnect()
        }
      },
      { threshold: 0.6 },
    )
    watch.observe(el)
    return () => watch.disconnect()
  }, [shown, key])
  if (!shown) return null
  const scale = (art === 'code' ? 0.9 : 0.82) * (compact ? 0.78 : 1)
  return (
    <div
      ref={box}
      className={cn(
        'flex items-center rounded-[18px] border border-white/[0.16] bg-[#151517]',
        compact ? 'gap-3 rounded-[14px] p-2.5' : 'gap-3.5 p-3.5',
        className,
      )}
    >
      <TourArt name={art} className="shrink-0" scale={scale} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-bold text-text [text-wrap:pretty]">{title}</div>
        <div className="mt-0.5 text-[12px] leading-snug text-textDim [text-wrap:pretty]">{line}</div>
      </div>
      <button type="button" aria-label="Close tip" onClick={() => setShown(false)} className="-mr-1 -mt-1 self-start p-1 text-textFaint hover:text-text">
        <X size={14} />
      </button>
    </div>
  )
}

function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return true
  }
}

function markSeen(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // Not kept: shown again next time.
  }
}
