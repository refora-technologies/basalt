import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { android } from '@/lib/android'
import { cn } from '@/lib/utils'

/**
 * The sections of a tab (Movies, TV Series… or Recent and Starred) as a
 * segmented control, and their contents as pages a finger can swipe between.
 *
 * The two move together: while a page is dragged the highlight slides along
 * the control by the same fraction, so the control says where the swipe is
 * going before it lands.
 *
 * All of the movement is CSS transforms set straight on the elements, and no
 * React render happens while a finger moves. The Sheet's comment says why:
 * a library that measured the page on every frame is where its stutter came
 * from.
 */

/** Where a drag is, from -1 (one section back) to 1 (one forward). */
type Progress = (fraction: number, settle?: boolean) => void

export interface Section {
  key: string
  label: string
  icon?: React.ComponentType<{ size?: number; className?: string }>
}

/** Joins the control and the pages, so a drag can move the highlight. */
export function useSectionLink(): React.MutableRefObject<Progress | null> {
  return useRef<Progress | null>(null)
}

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function SectionTabs({
  items,
  active,
  onChoose,
  link,
}: {
  items: Section[]
  active: string
  onChoose: (key: string) => void
  link: React.MutableRefObject<Progress | null>
}): React.JSX.Element {
  const track = useRef<HTMLDivElement | null>(null)
  const highlight = useRef<HTMLDivElement | null>(null)
  /** The labels again, dark, inside the highlight: seen only where it is. */
  const inked = useRef<HTMLDivElement | null>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === active),
  )
  // Up to three share the width evenly; more scroll, each as wide as it says.
  const even = items.length <= 3

  const place = useCallback(
    (at: number, animate: boolean) => {
      const low = Math.max(0, Math.min(items.length - 1, Math.floor(at)))
      const high = Math.min(items.length - 1, low + 1)
      const a = buttons.current[low]
      const b = buttons.current[high]
      const el = highlight.current
      if (!a || !b || !el) return
      const t = Math.max(0, Math.min(1, at - low))
      const left = a.offsetLeft + (b.offsetLeft - a.offsetLeft) * t
      const width = a.offsetWidth + (b.offsetWidth - a.offsetWidth) * t
      const transition = animate ? `transform 320ms ${EASE}, width 320ms ${EASE}` : 'none'
      el.style.transition = transition
      el.style.transform = `translate3d(${left}px, 0, 0)`
      el.style.width = `${width}px`
      // The dark labels stay where the light ones are while the highlight
      // moves over them, so a label turns dark exactly as far as it is lit.
      const ink = inked.current
      const box = track.current
      if (ink && box) {
        ink.style.transition = animate ? `transform 320ms ${EASE}` : 'none'
        ink.style.transform = `translate3d(${-left}px, 0, 0)`
        ink.style.width = `${box.scrollWidth}px`
        ink.style.height = `${box.clientHeight}px`
      }
    },
    [items.length],
  )

  useLayoutEffect(() => {
    place(index, true)
    const button = buttons.current[index]
    if (!even && button && track.current) {
      button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  }, [index, place, even])

  // The first placement without a slide in from nowhere.
  useLayoutEffect(() => {
    place(index, false)
    const resize = new ResizeObserver(() => place(index, false))
    if (track.current) resize.observe(track.current)
    return () => resize.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  useEffect(() => {
    link.current = (fraction, settle) => place(index + fraction, settle ?? false)
    return () => {
      link.current = null
    }
  }, [link, place, index])

  return (
    <div className="shrink-0 px-4 pb-2.5 pt-1">
      <div
        ref={track}
        role="tablist"
        className={cn(
          'relative flex rounded-full border border-white/[0.07] bg-white/[0.04] p-1',
          !even && 'overflow-x-auto [scrollbar-width:none]',
        )}
      >
        {items.map((item, i) => {
          const on = i === index
          return (
            <button
              key={item.key}
              ref={(el) => {
                buttons.current[i] = el
              }}
              role="tab"
              aria-selected={on}
              onClick={() => {
                if (on) return
                void android.haptic('tap')
                onChoose(item.key)
              }}
              className={cn(LABEL, even ? 'flex-1' : 'shrink-0', 'text-textDim active:text-text')}
            >
              <Label item={item} />
            </button>
          )
        })}
        <div
          ref={highlight}
          aria-hidden
          className="pointer-events-none absolute bottom-1 left-0 top-1 overflow-hidden rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
        >
          <div ref={inked} className="absolute -top-1 left-0 flex p-1 text-black">
            {items.map((item) => (
              <span key={item.key} className={cn(LABEL, even ? 'flex-1' : 'shrink-0')}>
                <Label item={item} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One section's place in the control: the same in both layers, or they would not line up. */
const LABEL =
  'relative flex h-9 items-center justify-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-medium'

function Label({ item }: { item: Section }): React.JSX.Element {
  const Icon = item.icon
  return (
    <>
      {Icon && <Icon size={15} className="shrink-0" />}
      <span className="whitespace-nowrap">{item.label}</span>
    </>
  )
}

/** How far, as a share of the width, a page must be dragged to turn. */
const TURN_SHARE = 0.22
/** Or how fast a flick, in pixels a millisecond. */
const TURN_SPEED = 0.45
/** Touches this close to either edge belong to Android's back gesture. */
const EDGE_PX = 24

/**
 * The page for the active section, which a horizontal swipe turns.
 *
 * A swipe is only taken when it is clearly sideways, starts away from the
 * screen's edges (Android's back gesture lives there), and does not start on
 * something that scrolls sideways itself, like Continue watching, or inside
 * anything marked `data-no-swipe`, like a series' episode list.
 */
export function SectionPager({
  items,
  active,
  onChoose,
  link,
  disabled,
  children,
}: {
  items: Section[]
  active: string
  onChoose: (key: string) => void
  link: React.MutableRefObject<Progress | null>
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const frame = useRef<HTMLDivElement | null>(null)
  const page = useRef<HTMLDivElement | null>(null)
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === active),
  )
  const latest = useRef({ index, items, onChoose, disabled })
  latest.current = { index, items, onChoose, disabled }
  /** Which way the next page comes in from: 1 from the right, -1 the left. */
  const entering = useRef(0)
  const previous = useRef(index)

  // A page arriving, by swipe or by a tap on the control, slides in from
  // the side it lies on.
  useLayoutEffect(() => {
    const el = page.current
    const from = entering.current || Math.sign(index - previous.current)
    previous.current = index
    entering.current = 0
    if (!el || from === 0) return
    el.style.transition = 'none'
    el.style.transform = `translate3d(${from * 56}px, 0, 0)`
    el.style.opacity = '0'
    // Two frames: the first lays the page out where it starts.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.transition = `transform 300ms ${EASE}, opacity 220ms ease-out`
        el.style.transform = 'translate3d(0, 0, 0)'
        el.style.opacity = '1'
      }),
    )
    const done = setTimeout(() => {
      // No transform at rest: one on an ancestor would pin the series
      // sheet (position: fixed) to this page instead of the screen.
      el.style.transition = ''
      el.style.transform = ''
      el.style.opacity = ''
    }, 340)
    return () => clearTimeout(done)
  }, [index])

  useEffect(() => {
    const host = frame.current
    if (!host) return undefined
    let start: { x: number; y: number; t: number } | null = null
    let axis: 'x' | 'y' | null = null
    let dx = 0

    const width = (): number => host.clientWidth || window.innerWidth

    const scrollsSideways = (target: EventTarget | null): boolean => {
      for (let el = target as HTMLElement | null; el && el !== host; el = el.parentElement) {
        if (el.dataset?.noSwipe !== undefined) return true
        if (el.scrollWidth > el.clientWidth + 1) {
          const overflow = getComputedStyle(el).overflowX
          if (overflow === 'auto' || overflow === 'scroll') return true
        }
      }
      return false
    }

    const move = (offset: number): void => {
      const el = page.current
      if (!el) return
      el.style.transition = 'none'
      el.style.transform = `translate3d(${offset}px, 0, 0)`
      el.style.opacity = String(1 - Math.min(0.5, Math.abs(offset) / width()))
    }

    const settle = (): void => {
      const el = page.current
      if (!el) return
      el.style.transition = `transform 260ms ${EASE}, opacity 200ms ease-out`
      el.style.transform = 'translate3d(0, 0, 0)'
      el.style.opacity = '1'
      setTimeout(() => {
        if (start) return
        el.style.transition = ''
        el.style.transform = ''
        el.style.opacity = ''
      }, 280)
      link.current?.(0, true)
    }

    const onStart = (e: TouchEvent): void => {
      start = null
      axis = null
      dx = 0
      if (latest.current.disabled || e.touches.length !== 1) return
      const touch = e.touches[0]!
      if (touch.clientX < EDGE_PX || touch.clientX > window.innerWidth - EDGE_PX) return
      if (scrollsSideways(e.target)) return
      start = { x: touch.clientX, y: touch.clientY, t: performance.now() }
    }

    const onMove = (e: TouchEvent): void => {
      if (!start) return
      const touch = e.touches[0]!
      const x = touch.clientX - start.x
      const y = touch.clientY - start.y
      if (axis === null) {
        if (Math.abs(x) > 10 && Math.abs(x) > Math.abs(y) * 1.3) axis = 'x'
        else if (Math.abs(y) > 10) axis = 'y'
        else return
      }
      if (axis !== 'x') return
      e.preventDefault()
      const { index: at, items: all } = latest.current
      const edge = (x > 0 && at === 0) || (x < 0 && at === all.length - 1)
      // At either end the page gives a little and comes back.
      dx = edge ? x * 0.22 : x
      move(dx)
      if (!edge) link.current?.(-dx / width())
    }

    const onEnd = (): void => {
      if (!start) return
      const elapsed = Math.max(1, performance.now() - start.t)
      const swiped = axis === 'x'
      start = null
      if (!swiped) return
      const { index: at, items: all, onChoose: choose } = latest.current
      const direction = dx < 0 ? 1 : -1
      const next = at + direction
      const far = Math.abs(dx) > width() * TURN_SHARE || Math.abs(dx) / elapsed > TURN_SPEED
      if (!far || next < 0 || next >= all.length) {
        settle()
        return
      }
      void android.haptic('tap')
      entering.current = direction
      const el = page.current
      if (el) {
        el.style.transition = `transform 140ms ease-in, opacity 140ms ease-in`
        el.style.transform = `translate3d(${-direction * width() * 0.35}px, 0, 0)`
        el.style.opacity = '0'
      }
      link.current?.(direction, true)
      setTimeout(() => choose(all[next]!.key), 120)
    }

    host.addEventListener('touchstart', onStart, { passive: true })
    host.addEventListener('touchmove', onMove, { passive: false })
    host.addEventListener('touchend', onEnd, { passive: true })
    host.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
      host.removeEventListener('touchcancel', onEnd)
    }
  }, [link])

  return (
    <div ref={frame} className="relative h-full overflow-hidden">
      <div ref={page} className="h-full will-change-auto">
        {children}
      </div>
    </div>
  )
}
