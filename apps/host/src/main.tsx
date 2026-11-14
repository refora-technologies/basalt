import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { suppressNativeContextMenu } from './lib/nativeMenu'
import { startUpdateChecks } from './lib/updates'
import { shapeWindow } from './lib/windowFrame'
import { followWindowShown } from './lib/windowShown'
import './styles.css'

// Before the first render, so no right click can ever reach the browser's
// own menu — not even during startup.
suppressNativeContextMenu()

// Before the first render too, so the corners are never seen square.
shapeWindow()

// A newer host is looked for on opening and twice a day after: a host runs
// for weeks, and the offer should be waiting at the top of the window.
startUpdateChecks()

// The window hidden in the tray says so to the page, which then stops polling.
followWindowShown()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
