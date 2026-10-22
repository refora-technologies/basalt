/**
 * Typing on a television.
 *
 * A TV's keyboard floats over the bottom of the screen without telling the
 * app how tall it is (Android reports it as taking no room), so a field in
 * the lower half was typed in blind: an address, a setup code, a search.
 * While a field has the focus, the page moves up until the field sits in the
 * top part of the screen, above where the keyboard comes; it moves back when
 * the field is left. The highlight follows by itself (see focusHalo.ts).
 */

/** How far down the screen a field may sit: the keyboard takes the rest. */
const ABOVE = 0.42

export function startTvTyping(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)'

  const settle = (): void => {
    const field = document.activeElement
    const typing =
      field instanceof HTMLTextAreaElement ||
      (field instanceof HTMLInputElement && !NOT_TYPED.has(field.type)) ||
      (field instanceof HTMLElement && field.isContentEditable)
    if (!typing) {
      root.style.transform = ''
      return
    }
    // Measured where it would be with the page in place, wherever the page
    // is right now, mid-way through moving included.
    const bottom = field.getBoundingClientRect().bottom - offset(root)
    const lift = Math.max(0, bottom - window.innerHeight * ABOVE)
    root.style.transform = lift > 0 ? `translateY(${-lift}px)` : ''
  }
  // After the focus has settled: leaving one field for another passes
  // through nothing in between.
  const later = (): void => void requestAnimationFrame(settle)
  document.addEventListener('focusin', later)
  document.addEventListener('focusout', later)
}

/** Fields the keyboard does not come up for. */
const NOT_TYPED = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'])

/** How far the page is moved down right now (negative: up). */
function offset(root: HTMLElement): number {
  const transform = getComputedStyle(root).transform
  return transform && transform !== 'none' ? new DOMMatrix(transform).m42 : 0
}
