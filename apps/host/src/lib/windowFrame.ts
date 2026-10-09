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

type Edge = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'

/** Each edge and corner, and the cursor that says it can be pulled. */
const EDGES: Array<[Edge, string]> = [
  ['North', 'ns-resize'],
  ['South', 'ns-resize'],
  ['East', 'ew-resize'],
  ['West', 'ew-resize'],
  ['NorthWest', 'nwse-resize'],
  ['SouthEast', 'nwse-resize'],
  ['NorthEast', 'nesw-resize'],
  ['SouthWest', 'nesw-resize'],
]

/**
 * Edges to resize the window by, as a system frame would have. Thin strips
 * over the very edge of the page, that hand the pull to the system, which
 * keeps the window to its minimum size. Outside React, since they belong to
 * the frame rather than to any screen.
 */
function addResizeEdges(): void {
  for (const [edge, cursor] of EDGES) {
    const strip = document.createElement('div')
    strip.className = 'resize-edge'
    strip.dataset.edge = edge
    strip.style.cursor = cursor
    strip.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      void currentWindow().then((win) => win.startResizeDragging(edge))
    })
    document.body.appendChild(strip)
  }
}

/**
 * Rounds the window on Linux, and keeps it square while it is maximised.
 * Gives it edges to resize by there too.
 */
export function shapeWindow(): void {
  if (!inTauri() || !/Linux/.test(navigator.userAgent)) return
  const root = document.documentElement
  root.dataset.shape = 'rounded'
  addResizeEdges()
  void currentWindow().then(async (win) => {
    const update = async (): Promise<void> => {
      root.dataset.shape = (await win.isMaximized()) ? 'square' : 'rounded'
    }
    await update()
    await win.onResized(() => void update())
  })
}
