import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Whether the window is on screen, told to the page.
 *
 * Closing the window to the tray hides it, but the page inside isn't told:
 * it went on saying "visible", so everything that pauses while nobody is
 * looking (looking for devices nearby, checking the firewall, asking the host who is online) went on all day in the tray. The app now says when it
 * hides and shows the window, and the page's own `document.visibilityState`
 * says so too, so every part that already asks it pauses.
 */
let hiddenByApp = false

export function followWindowShown(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const own = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hiddenByApp ? 'hidden' : (own?.get?.call(document) as DocumentVisibilityState)),
  })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => document.visibilityState === 'hidden' })
  const set = (shown: boolean): void => {
    if (hiddenByApp === !shown) return
    hiddenByApp = !shown
    document.dispatchEvent(new Event('visibilitychange'))
  }
  void listen<boolean>('basalt://window-shown', (e) => set(e.payload)).catch(() => {})
  // Started hidden (at login): known from the start.
  void getCurrentWindow()
    .isVisible()
    .then(set)
    .catch(() => {})
}
