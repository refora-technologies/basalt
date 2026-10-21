import React from 'react'
import { MotionConfig } from 'framer-motion'
import ReactDOM from 'react-dom/client'
import { suppressNativeContextMenu } from './lib/nativeMenu'
import { noteLaunch } from './lib/review'
import { android } from './lib/android'
import { isAndroid, isMobileShell } from './lib/platform'
import { startHalo } from './lib/focusHalo'
import { startRemote } from './lib/remote'
import { startTvTyping } from './lib/tvTyping'
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

/**
 * A television first, before the app loads, so every part of it knows from
 * its first line: parts decide how they behave as they load.
 */
async function onTelevision(): Promise<boolean> {
  if (new URLSearchParams(location.search).has('tv')) return true
  if (!isAndroid()) return false
  // Not waited on for long: a phone that is slow to answer is still a phone.
  const asked = android.appVersion().then((v) => Boolean(v?.tv)).catch(() => false)
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))
  return Promise.race([asked, late])
}

void onTelevision().then(async (tv) => {
  if (tv) {
    document.documentElement.classList.add('tv')
    startRemote()
    startHalo()
    startTvTyping()
  }
  const { App } = await import('./App')
  render(App)
})

function render(App: () => React.JSX.Element): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/* Windows' "show animations" setting, honoured by everything that
          moves — not only the CSS, which the stylesheet already handles. */}
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </React.StrictMode>,
  )
}
