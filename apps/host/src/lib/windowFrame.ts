/**
 * The parts of the window frame the system does not draw for this app.
 *
 * The window has no system title bar, so it supplies its own. Windows does
 * the rest itself: WebView2 reads `-webkit-app-region` to move the window,
 * and Windows 11 rounds the corners. Linux does neither, so there the title
 * bar asks to be dragged, and the page rounds its own corners inside a
 * transparent window, square again when maximised as every other window is.
 */

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** WebView2, which moves the window from `-webkit-app-region` by itself. */
function nativeDrag(): boolean {
  return /Windows/.test(navigator.userAgent)
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * Moves the window from a press on the title bar, or maximises it on a
 * double press, as a system title bar would. Presses on its buttons are
 * theirs.
 */
export function dragFromTitleBar(event: React.MouseEvent): void {
  if (!inTauri() || nativeDrag() || event.button !== 0) return
  if ((event.target as HTMLElement).closest('.no-drag, button, input, a')) return
  void currentWindow().then((win) =>
    event.detail === 2 ? win.toggleMaximize() : win.startDragging(),
  )
}

/** Rounds the window on Linux, and keeps it square while it is maximised. */
export function shapeWindow(): void {
  if (!inTauri() || !/Linux/.test(navigator.userAgent)) return
  const root = document.documentElement
  root.dataset.shape = 'rounded'
  void currentWindow().then(async (win) => {
    const update = async (): Promise<void> => {
      root.dataset.shape = (await win.isMaximized()) ? 'square' : 'rounded'
    }
    await update()
    await win.onResized(() => void update())
  })
}
