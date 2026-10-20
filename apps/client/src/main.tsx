import React from 'react'
import { MotionConfig } from 'framer-motion'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { suppressNativeContextMenu } from './lib/nativeMenu'
import { noteLaunch } from './lib/review'
import { isMobileShell } from './lib/platform'
import { startUpdateChecks } from './lib/updates'
import { shapeWindow } from './lib/windowFrame'
import './styles.css'

// Before the first render, so no right click can ever reach the browser's
// own menu — not even during startup.
suppressNativeContextMenu()

// The phone's look from the first frame: its own scrollbars among it, which
// the computer's would otherwise replace until the phone app had drawn.
if (isMobileShell()) document.documentElement.classList.add('mobile')

// On Linux the page is the window's frame too: see lib/windowFrame.ts.
shapeWindow()

// A newer Basalt is looked for on opening and twice a day after, so the offer
// is waiting in the sidebar, or on a phone in a banner and a notification,
// without anyone going to Settings to ask.
startUpdateChecks()

// The Play build asks for a rating once, a week after this first opening.
noteLaunch()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Windows' "show animations" setting, honoured by everything that moves
        — not only the CSS, which the stylesheet already handles. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </React.StrictMode>,
)
