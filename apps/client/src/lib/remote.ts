/**
 * The television's remote: moving between things on screen with its arrows.
 *
 * A remote has no pointer. Its arrows move the focus to the nearest thing that
 * can be pressed in that direction, judged by where things are on screen, as
 * every TV app does; its OK presses what has the focus (the WebView turns it
 * into Enter), and its Back goes back as the phone's does.
 *
 * Only within what is in front: an open sheet, dialog or menu, or the player,
 * whatever was opened last. Anything that handles an arrow itself (a text
 * field, a slider, the player's own keys) does so first.
 */

/** Things the remote can land on. */
const PRESSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="tab"]',
  '[role="radio"]',
].join(',')

/** What can be in front of the rest: the last one open is where the remote moves. */
const SCOPES = '[role="dialog"], [aria-modal="true"], [data-remote-scope]'

export type Direction = 'up' | 'down' | 'left' | 'right'

const KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * How far `to` is from `from` going `direction`, or null when it is not that
 * way at all. Along the way counts once; off to the side counts double, so a
 * thing straight ahead wins over a nearer one off the line.
 */
export function distance(from: Box, to: Box, direction: Direction): number | null {
  const fromX = (from.left + from.right) / 2
  const fromY = (from.top + from.bottom) / 2
  const toX = (to.left + to.right) / 2
  const toY = (to.top + to.bottom) / 2
  // A little overlap is allowed, as rows of slightly different heights have.
  const slack = 2
  let along: number
  let aside: number
  switch (direction) {
    case 'right':
      if (to.left < from.right - slack) return null
      along = to.left - from.right
      aside = Math.max(0, Math.abs(toY - fromY) - (to.bottom - to.top) / 2)
      break
    case 'left':
      if (to.right > from.left + slack) return null
      along = from.left - to.right
      aside = Math.max(0, Math.abs(toY - fromY) - (to.bottom - to.top) / 2)
      break
    case 'down':
      if (to.top < from.bottom - slack) return null
      along = to.top - from.bottom
      aside = Math.max(0, Math.abs(toX - fromX) - (to.right - to.left) / 2)
      break
    case 'up':
      if (to.bottom > from.top + slack) return null
      along = from.top - to.bottom
      aside = Math.max(0, Math.abs(toX - fromX) - (to.right - to.left) / 2)
      break
  }
  return Math.max(0, along) + 2 * aside
}

/** The nearest of `candidates` from `from` going `direction`, if any. */
export function nearest<T>(
  from: Box,
  candidates: Array<{ item: T; box: Box }>,
  direction: Direction,
): T | null {
  let best: T | null = null
  let bestDistance = Infinity
  for (const { item, box } of candidates) {
    const d = distance(from, box, direction)
    if (d !== null && d < bestDistance) {
      best = item
      bestDistance = d
    }
  }
  return best
}

/** What the remote moves within now: the front-most open scope, or the page. */
function scope(): Element {
  const open = [...document.querySelectorAll(SCOPES)].filter(visible)
  return open[open.length - 1] ?? document.body
}

function visible(el: Element): boolean {
  const box = el.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
}

/** Every pressable thing in `within` that can be seen. */
function pressables(within: Element): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>(PRESSABLE)].filter(
    (el) => visible(el) && !el.closest('[aria-hidden="true"], [inert]'),
  )
}

/** Moves the focus one step `direction`. Whether it moved. */
export function move(direction: Direction): boolean {
  const within = scope()
  const all = pressables(within)
  if (all.length === 0) return false
  const current = document.activeElement as HTMLElement | null
  const lost = !current || current === document.body || !within.contains(current)
  // Nothing in front has had the focus yet, or what had it went away with
  // the screen it was on: where the screen says to start; on a whole screen
  // the first thing in its content (past the side rail and the bar above);
  // in a menu or sheet what is chosen in it; else the first thing, top left.
  if (lost) {
    const topLeft = (els: HTMLElement[]): HTMLElement | undefined =>
      [...els].sort((a, b) => {
        const ba = a.getBoundingClientRect()
        const bb = b.getBoundingClientRect()
        return ba.top - bb.top || ba.left - bb.left
      })[0]
    const start =
      all.find((el) => el.matches('[data-remote-first]')) ??
      (within === document.body ? topLeft(all.filter((el) => el.closest('main'))) : undefined) ??
      all.find((el) =>
        el.matches('[aria-current="page"], [aria-current="true"], [aria-selected="true"], [aria-checked="true"]'),
      ) ??
      topLeft(all)
    focus(start!)
    return true
  }
  const from = current.getBoundingClientRect()
  const next = nearest(
    from,
    all
      .filter((el) => el !== current)
      .map((el) => ({ item: el, box: seenFrom(el, current, from, direction) })),
    direction,
  )
  if (!next) return false
  focus(next)
  return true
}

/**
 * Where `el` counts as being, seen from the focused `current` at `from`. A
 * button inside a row (its menu) is reached going right from the row as if
 * the row were only its left edge, and going left from that button the row
 * is the very next thing.
 */
export function seenFrom(el: Element, current: Element, from: Box, direction: Direction): Box {
  const box = el.getBoundingClientRect()
  if (direction === 'right' && current.contains(el)) {
    // As far right of the row's left edge as it is.
    const shift = box.left - from.left
    return { left: from.right + shift, right: from.right + shift + (box.right - box.left), top: box.top, bottom: box.bottom }
  }
  if (direction === 'left' && el.contains(current)) {
    return { left: from.left - 1, right: from.left, top: from.top, bottom: from.bottom }
  }
  return box
}

function focus(el: HTMLElement): void {
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** Keys a focused thing keeps for itself, rather than moving on. */
function keepsArrows(el: Element | null, direction: Direction): boolean {
  if (!el) return false
  if (el.matches('textarea, [contenteditable="true"]')) return true
  if (el instanceof HTMLInputElement) {
    // Along a text field the arrows move the cursor; a slider takes them all.
    if (el.type === 'range') return true
    const text = !['checkbox', 'radio', 'button', 'submit'].includes(el.type)
    return text && (direction === 'left' || direction === 'right')
  }
  return el instanceof HTMLSelectElement
}

let started = false

/** Listens to the remote's arrows, once, on a television. */
export function startRemote(): void {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const direction = KEYS[e.key]
    if (!direction) return
    if (keepsArrows(document.activeElement, direction)) return
    if (move(direction)) e.preventDefault()
  })
}
