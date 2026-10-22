import type { Release } from '@/lib/api'
import { PLAY_STORE } from '@/lib/channel'
import { isMobileShell } from '@/lib/platform'

/**
 * Moving from the APK to Google Play, offered once Play has caught up.
 *
 * The APK from GitHub and the app on Play are signed with the same key, so
 * Play can install over the APK as an ordinary update: nothing is uninstalled
 * and the paired drives, profiles and settings stay. From then on Play keeps
 * it up to date and this copy's own update check goes quiet.
 *
 * Whether Play has a release is written in that release's notes on GitHub,
 * as `<!-- google-play: 1.6.5 -->`, added once Play has published it. It only
 * decides whether the choice is offered: the Play address is this app's own,
 * and an update from GitHub is still checked against the release key.
 */

/**
 * An Amazon device: a Fire TV or a Fire tablet, which have no Google Play.
 * Their WebView says so: Fire TV models are named AFT…, tablets KF….
 */
export function amazonDevice(agent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bAFT[A-Z0-9]|\bKF[A-Z]{2,}|Silk\/|Amazon/.test(agent)
}

const MARKER = /<!--\s*google-play:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*-->/i
const KEPT = 'basalt.keptApk'

const LIVE = 'basalt.playLive'

/** Whether Play has this release, by its notes. Remembered once seen. */
export function onPlay(release: Release): boolean {
  const found = MARKER.exec(release.notes)
  const yes = !!found && found[1] === release.version
  if (yes) localStorage.setItem(LIVE, '1')
  return yes
}

/**
 * Whether to offer moving in Settings: in the APK on Android, once Basalt
 * has been seen on Play.
 */
export function canMoveToPlay(): boolean {
  if (PLAY_STORE || !isMobileShell() || amazonDevice()) return false
  return localStorage.getItem(LIVE) !== null
}

/**
 * Whether to offer the move for this release: in the APK on Android, when
 * Play has it, and not when the person already chose to keep the APK, or on
 * a Fire TV, which has no Google Play.
 */
export function offerPlay(release: Release): boolean {
  if (PLAY_STORE || !isMobileShell() || amazonDevice()) return false
  if (!onPlay(release)) return false
  return localStorage.getItem(KEPT) === null
}

/** "Keep the APK": the ordinary update from now on. */
export function keepApk(): void {
  localStorage.setItem(KEPT, '1')
}

/** "Move to Google Play" in Settings: the popup is offered again. */
export function stopKeepingApk(): void {
  localStorage.removeItem(KEPT)
}
