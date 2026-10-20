/**
 * The parts of the window frame the system does not draw for this app, on
 * Linux. The same as Basalt Host's (apps/host/src/lib/windowFrame.ts).
 *
 * The window has no system title bar. On Windows, WebView2 moves the window
 * from the page's `.drag` areas (`-webkit-app-region`), and Windows 11 rounds
 * the corners. WebKitGTK does neither, so here a press on a `.drag` area asks
 * the system to move the window, the edges resize it, and the page rounds its
 * own corners inside the transparent window, square again when maximised.
 */

import { api } from './api'
import { isLinuxDesktop } from './platform'

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

/**
 * Hands the press to the system to move the window, or to resize it from
 * `edge`, then tells the page the button was let go: on Linux the system
 * keeps the release, and the page would go on thinking the button was held.
 */
async function frameDrag(edge?: Edge): Promise<void> {
  const win = await currentWindow()
  await (edge ? win.startResizeDragging(edge) : win.startDragging())
  await api.releasePointer().catch(() => {})
}

/**
 * A press on a `.drag` area moves the window, and a double press maximises
 * it, as a system title bar would. Presses on anything inside it that can be
 * used, or marked `.no-drag`, are theirs.
 */
function dragFromDragAreas(): void {
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (!target?.closest('.drag')) return
    if (target.closest('.no-drag, button, input, textarea, select, a, [role="button"]')) return
    if (event.detail === 2) void currentWindow().then((win) => win.toggleMaximize())
    else void frameDrag()
  })
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
 * Thin strips over the very edge of the page that hand a pull to the
 * system, as wide as the band Tauri itself resizes from on Linux.
 */
function addResizeEdges(): void {
  document.documentElement.style.setProperty('--edge', `${5 * window.devicePixelRatio}px`)
  for (const [edge, cursor] of EDGES) {
    const strip = document.createElement('div')
    strip.className = 'resize-edge'
    strip.dataset.edge = edge
    strip.style.cursor = cursor
    strip.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      void frameDrag(edge)
    })
    document.body.appendChild(strip)
  }
}

/**
 * On Linux: dragging, resizing, and rounded corners that square off while
 * maximised or full screen.
 */
export function shapeWindow(): void {
  if (!inTauri() || !isLinuxDesktop()) return
  const root = document.documentElement
  root.dataset.shape = 'rounded'
  dragFromDragAreas()
  addResizeEdges()
  void currentWindow().then(async (win) => {
    const update = async (): Promise<void> => {
      root.dataset.shape = (await win.isMaximized()) || (await win.isFullscreen()) ? 'square' : 'rounded'
    }
    await update()
    await win.onResized(() => void update())
  })
}
