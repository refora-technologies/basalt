/**
 * Which app this is: the desktop window, or the phone and tablet app.
 *
 * Decided once, from the webview itself. Android's says so in its user
 * agent. The browser preview can ask for the mobile app with `?mobile`, so
 * its screens can be worked on at a desk.
 */
export function isMobileShell(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/Android/i.test(navigator.userAgent)) return true
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('mobile')) {
    return true
  }
  return false
}

/**
 * The app on a television: Android TV or Google TV, driven by a remote.
 * Known once the app has asked Android (see `main.tsx`), which it does
 * before anything else loads; `?tv` (with `?mobile`) previews it.
 */
export function isTv(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('tv')
}

/** What the Android app is on, in words: "phone", or "TV" on a television. */
export function handheldWord(): 'phone' | 'TV' {
  return isTv() ? 'TV' : 'phone'
}

/** Whether this is the Android app itself, not a preview of it. */
export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

/** The desktop app on Linux. Android says Linux too, so it is ruled out first. */
export function isLinuxDesktop(): boolean {
  return typeof navigator !== 'undefined' && !isAndroid() && /Linux/.test(navigator.userAgent)
}
