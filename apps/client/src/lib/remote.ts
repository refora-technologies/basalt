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
 *
 * Off to the side is the gap between their edges, nothing when one is in
 * line with the other: a button under the right end of a wide one is
 * straight below it. Measured from the middle of the wide one, the speed
 * test's button under the end of Change drive lost to one two rows further
 * down, and the remote could never reach it. Between two in line, the one
 * nearer the middle is taken.
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
      aside = Math.max(0, to.top - from.bottom, from.top - to.bottom) + Math.abs(toY - fromY) / 100
      break
    case 'left':
      if (to.right > from.left + slack) return null
      along = from.left - to.right
      aside = Math.max(0, to.top - from.bottom, from.top - to.bottom) + Math.abs(toY - fromY) / 100
      break
    case 'down':
      if (to.top < from.bottom - slack) return null
      along = to.top - from.bottom
      aside = Math.max(0, to.left - from.right, from.left - to.right) + Math.abs(toX - fromX) / 100
      break
    case 'up':
      if (to.bottom > from.top + slack) return null
      along = from.top - to.bottom
      aside = Math.max(0, to.left - from.right, from.left - to.right) + Math.abs(toX - fromX) / 100
      break
  }
  return Math.max(0, along) + 2 * aside
}

/**
 * The nearest of `candidates` from `from` going `direction`, if any.
 *
 * Left and right stay in the row: past the last button of the player's row,
 * right used to jump to the close button in the far corner. Only what is
 * reachable from `anywhere` (the side rail, a series' seasons) is found
 * outside the row.
 */
export function nearest<T>(
  from: Box,
  candidates: Array<{ item: T; box: Box; anywhere?: boolean }>,
  direction: Direction,
): T | null {
  const across = direction === 'left' || direction === 'right'
  let best: T | null = null
  let bestDistance = Infinity
  for (const { item, box, anywhere } of candidates) {
    if (across && !anywhere && !(box.top < from.bottom && box.bottom > from.top)) continue
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
  if (lost) {
    focus(startOf(within, all))
    return true
  }
  // From the middle of something that fills most of the screen (a photo),
  // as what sits over it (the bar above it, the strip below) is neither
  // above nor below its edges.
  const whole = current.getBoundingClientRect()
  const big = whole.width * whole.height > 0.4 * window.innerWidth * window.innerHeight
  const middle = { x: (whole.left + whole.right) / 2, y: (whole.top + whole.bottom) / 2 }
  const from = big ? { left: middle.x, right: middle.x, top: middle.y, bottom: middle.y } : whole
  const next = nearest(
    from,
    all
      .filter((el) => el !== current)
      .map((el) => ({
        item: el,
        box: seenFrom(el, current, from, direction),
        anywhere: el.closest('nav, [data-remote-anywhere]') !== null,
      })),
    direction,
  )
  if (!next) return false
  focus(next)
  return true
}

/**
 * Where the focus starts in `within`, when nothing there has it: where the
 * screen says to start; on a whole screen the first thing in its content
 * (past the side rail and the bar above); in a menu or sheet what is chosen
 * in it; else the first thing, top left.
 */
function startOf(within: Element, all: HTMLElement[]): HTMLElement {
  const topLeft = (els: HTMLElement[]): HTMLElement | undefined =>
    [...els].sort((a, b) => {
      const ba = a.getBoundingClientRect()
      const bb = b.getBoundingClientRect()
      return ba.top - bb.top || ba.left - bb.left
    })[0]
  return (
    all.find((el) => el.matches('[data-remote-first]')) ??
    (within === document.body ? topLeft(all.filter((el) => el.closest('main'))) : undefined) ??
    all.find((el) =>
      el.matches('[aria-current="page"], [aria-current="true"], [aria-selected="true"], [aria-checked="true"]'),
    ) ??
    topLeft(all)!
  )
}

/**
 * Puts the focus in front when it is not: a menu or sheet just opened, or the
 * screen changed under it. TV apps show where the remote is at once; waiting
 * for a press left the ring on what was behind a menu.
 */
function settle(): void {
  const within = scope()
  const current = document.activeElement
  if (current && current !== document.body && within.contains(current)) return
  // Lost from a part of the screen that changed under it (the music bar
  // turning from another device's music to this one's): found again there,
  // not back at the top of the page.
  const region = lastRegion
  lastRegion = null
  if (region && region.isConnected && within.contains(region)) {
    const there = pressables(region)
    const back = there.find((el) => el.matches('[data-remote-region-first]')) ?? there[0]
    if (back) {
      placed = back
      focus(back)
      return
    }
  }
  const all = pressables(within)
  // A screen still loading its content waits for it, rather than starting
  // on the side rail; a press before then starts wherever it can.
  const content = within === document.body && document.querySelector('main') !== null
  if (content && !all.some((el) => el.closest('main'))) return
  if (all.length > 0) {
    placed = startOf(within, all)
    focus(placed)
  }
}

/**
 * The part of the screen marked `data-remote-region` the focus was last in:
 * where it is found again if what it was on goes.
 */
let lastRegion: Element | null = null

/**
 * Where `settle` put the focus, until a key moves it. A screen whose start
 * comes in late (a list still loading) gets it there when it does, rather
 * than leaving the person on whatever was in front first.
 */
let placed: HTMLElement | null = null

function startCameLate(): void {
  if (!placed || document.activeElement !== placed) return
  const within = scope()
  const start = pressables(within).find((el) => el.matches('[data-remote-first]'))
  if (start && start !== placed) {
    placed = start
    focus(start)
  }
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
    // Along a text field the arrows move the cursor; a slider takes left and
    // right. Up and down leave it: taking them too, the music bar's progress
    // held the remote, and nothing above or below it could be reached.
    if (el.type === 'range') return direction === 'left' || direction === 'right'
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
  // Checked a few times a second rather than on every change: a layer that
  // opens animates in, and is settled into once it has.
  let unsettled = 0
  setInterval(() => {
    const within = scope()
    const current = document.activeElement
    const lost = !current || current === document.body || !within.contains(current)
    // Twice in a row, so a screen half-way through changing is left alone.
    unsettled = lost ? unsettled + 1 : 0
    if (unsettled >= 2) {
      unsettled = 0
      settle()
    }
    startCameLate()
  }, 150)
  document.addEventListener('focusin', (e) => {
    lastRegion = e.target instanceof Element ? e.target.closest('[data-remote-region]') : null
  })
  window.addEventListener('keydown', (e) => {
    placed = null
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
    const direction = KEYS[e.key]
    if (!direction) return
    if (keepsArrows(document.activeElement, direction)) return
    if (move(direction)) e.preventDefault()
  })
}
