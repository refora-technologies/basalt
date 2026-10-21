/**
 * The remote's highlight on a television: one ring, drawn above everything,
 * that goes to whatever has the focus.
 *
 * Drawn as an outline on each thing, the ring was cut wherever a list, menu
 * or row of tabs clips what is in it, and hidden under whatever was drawn
 * after. Drawn once, above the page, nothing covers or cuts it, and it glides
 * from one thing to the next as a television's highlight does. It takes the
 * shape of what it rings (round for a round button, a pill for a tab), and
 * fades while what it rings is faded out, as the player's controls are while
 * a film plays.
 *
 * A thing can name the part of it to ring with `data-focus-ring` (a poster,
 * rather than the poster and its caption).
 */

/** The ring's width, and its gap from what it rings, in pixels. */
const RING = 3
const GAP = 3

let started = false

export function startHalo(): void {
  if (started || typeof document === 'undefined') return
  started = true
  const halo = document.createElement('div')
  halo.className = 'tv-halo'
  halo.setAttribute('aria-hidden', 'true')
  document.body.appendChild(halo)

  let last = ''
  const frame = (): void => {
    const place = where(document.activeElement)
    const key = place
      ? `${place.x}|${place.y}|${place.w}|${place.h}|${place.r}|${place.clip.left}|${place.clip.top}|${place.clip.right}|${place.clip.bottom}`
      : ''
    if (key !== last) {
      if (place) {
        const out = RING + GAP
        // Kept on the screen and inside the list it is in: a row as wide as
        // the list has its ring just inside its edges, not off the screen.
        const left = Math.max(place.x - out, place.clip.left)
        const top = Math.max(place.y - out, place.clip.top)
        const right = Math.min(place.x + place.w + out, place.clip.right)
        const bottom = Math.min(place.y + place.h + out, place.clip.bottom)
        // Straight to the first place it is shown, gliding after that.
        if (!last) halo.style.transition = 'none'
        halo.style.transform = `translate(${left}px, ${top}px)`
        halo.style.width = `${right - left}px`
        halo.style.height = `${bottom - top}px`
        halo.style.borderRadius = `${place.r + out}px`
        halo.style.opacity = '1'
        if (!last) {
          void halo.offsetWidth
          halo.style.transition = ''
        }
      } else {
        halo.style.opacity = '0'
      }
      last = key
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

interface Place {
  x: number
  y: number
  w: number
  h: number
  /** The corner radius. */
  r: number
  /** What the ring stays within. */
  clip: { left: number; top: number; right: number; bottom: number }
}

/** Where the ring goes for `el`, or nowhere if it should not show. */
function where(el: Element | null): Place | null {
  if (!(el instanceof HTMLElement) || el === document.body || !shown(el)) return null
  // A whole photo, say, that the remote starts on but needs no ring round.
  if (el.hasAttribute('data-no-ring')) return null
  const target = el.querySelector<HTMLElement>('[data-focus-ring]') ?? el
  const box = target.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  const clip = within(el)
  // Scrolled mostly out of its list: no ring squeezed against the edge.
  const seen = Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top)
  if (seen < box.height / 2) return null
  const content = target === el ? hugged(el, box) : null
  if (content) {
    return {
      x: Math.round(content.left - 6),
      y: Math.round(content.top - 2),
      w: Math.round(content.width + 12),
      h: Math.round(content.height + 4),
      r: 8,
      clip,
    }
  }
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    w: Math.round(box.width),
    h: Math.round(box.height),
    r: radius(target, box),
    clip,
  }
}

/** The screen, less a hair, and the list that scrolls `el`, if one does. */
function within(el: HTMLElement): Place['clip'] {
  const clip = { left: 2, top: 2, right: window.innerWidth - 2, bottom: window.innerHeight - 2 }
  for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at)
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) {
      const box = at.getBoundingClientRect()
      clip.left = Math.max(clip.left, Math.round(box.left))
      clip.top = Math.max(clip.top, Math.round(box.top))
      clip.right = Math.min(clip.right, Math.round(box.right))
      clip.bottom = Math.min(clip.bottom, Math.round(box.bottom))
      break
    }
  }
  return clip
}

/**
 * What is drawn in `el`, when `el` itself is an unseen box much wider than
 * that: a text button laid across a whole column ("Look again"), whose ring
 * drawn round the column was a large empty frame. Not a tab or a choice,
 * whose ring is their pill even while it is not filled.
 */
function hugged(el: HTMLElement, box: DOMRect): DOMRect | null {
  if (el.matches('[role="tab"], [role="radio"], [role="row"], [aria-current]')) return null
  const style = getComputedStyle(el)
  const unseen =
    style.backgroundColor === 'rgba(0, 0, 0, 0)' &&
    style.borderTopWidth === '0px' &&
    style.boxShadow === 'none'
  if (!unseen) return null
  const range = document.createRange()
  range.selectNodeContents(el)
  const content = range.getBoundingClientRect()
  if (content.width === 0 || box.width - content.width < 48) return null
  return content
}

/** Whether `el` can be seen: neither it nor anything around it faded out or hidden. */
function shown(el: HTMLElement): boolean {
  if (el.closest('[aria-hidden="true"], [inert]')) return false
  // Its own visibility says it all: a hidden wrapper may show some of what
  // is in it again. A fade does not pass down, so every wrapper's counts.
  if (getComputedStyle(el).visibility !== 'visible') return false
  for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
    if (Number(getComputedStyle(at).opacity) < 0.3) return false
  }
  return true
}

/** The corner radius `el` is drawn with, in pixels, at most a full round. */
function radius(el: HTMLElement, box: DOMRect): number {
  const value = getComputedStyle(el).borderTopLeftRadius
  const round = Math.min(box.width, box.height) / 2
  const r = value.endsWith('%')
    ? (parseFloat(value) / 100) * Math.min(box.width, box.height)
    : parseFloat(value) || 0
  return Math.min(r, round)
}
