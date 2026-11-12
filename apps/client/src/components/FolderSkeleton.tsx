import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * Rows shaped like files, with nothing in them yet: shown while a folder that
 * was clicked is still on its way from the host.
 *
 * The breadcrumb moved at once, but the old folder's files stayed under it
 * until the new list came, which on a slow line read as the click not having
 * worked. A spinner says "busy"; rows say "your folder is coming, here". They
 * pulse gently, or sit still where the system asks for less motion.
 */
export function FolderSkeleton({ view }: { view: 'details' | 'list' | 'tiles' | 'phone' }): React.JSX.Element {
  const rows = Array.from({ length: view === 'tiles' ? 12 : 9 }, (_, i) => i)
  const pulse = 'animate-pulse motion-reduce:animate-none'
  if (view === 'tiles') {
    return (
      <div aria-busy="true" aria-label="Loading the folder" className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 p-3">
        {rows.map((i) => (
          <div key={i} className={cn('flex flex-col items-center gap-2 rounded-xl p-3', pulse)} style={{ animationDelay: `${i * 60}ms` }}>
            <div className="h-16 w-16 rounded-lg bg-white/[0.06]" />
            <div className="h-2.5 rounded-full bg-white/[0.06]" style={{ width: `${widthOf(i, 45, 85)}%` }} />
          </div>
        ))}
      </div>
    )
  }
  if (view === 'phone') {
    return (
      <div aria-busy="true" aria-label="Loading the folder">
        {rows.map((i) => (
          <div key={i} className={cn('flex h-16 items-center gap-3.5 px-4', pulse)} style={{ animationDelay: `${i * 60}ms` }}>
            <div className="h-11 w-11 shrink-0 rounded-[10px] bg-white/[0.06]" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 rounded-full bg-white/[0.07]" style={{ width: `${widthOf(i, 35, 75)}%` }} />
              <div className="h-2.5 rounded-full bg-white/[0.04]" style={{ width: `${widthOf(i + 5, 20, 40)}%` }} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  const height = view === 'list' ? 28 : 34
  return (
    <div aria-busy="true" aria-label="Loading the folder" className="px-2 pt-9">
      {rows.map((i) => (
        <div key={i} className={cn('flex items-center gap-3 px-3', pulse)} style={{ height, animationDelay: `${i * 60}ms` }}>
          <div className="h-4 w-4 shrink-0 rounded bg-white/[0.07]" />
          <div className="h-2.5 rounded-full bg-white/[0.06]" style={{ width: `${widthOf(i, 18, 42)}%` }} />
          {view === 'details' && (
            <>
              <div className="ml-auto h-2.5 w-14 rounded-full bg-white/[0.04]" />
              <div className="h-2.5 w-20 rounded-full bg-white/[0.04]" />
            </>
          )}
        </div>
      ))}
    </div>
  )
}

/** A width that looks like a name's, the same for a row every time. */
function widthOf(i: number, least: number, most: number): number {
  return least + (((i * 37 + 11) % 100) / 100) * (most - least)
}

/**
 * `on`, once it has stayed on for `ms`. A folder that answers at once never
 * flashes its placeholder; one that takes a moment shows it.
 */
export function useAfter(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) {
      setLate(false)
      return undefined
    }
    const timer = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return on && late
}
