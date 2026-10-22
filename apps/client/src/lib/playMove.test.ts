// @vitest-environment jsdom
//
// The APK offers Google Play only once the release says Play has it, only
// on Android, and not again after "Keep the APK version".

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Release } from './api'

const shell = vi.hoisted(() => ({ mobile: true }))
vi.mock('./platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./platform')>()),
  isMobileShell: () => shell.mobile,
}))

import { amazonDevice, canMoveToPlay, keepApk, offerPlay, onPlay, stopKeepingApk } from './playMove'

const release = (version: string, notes: string): Release => ({
  version,
  notes,
  pageUrl: '',
  installerName: 'Basalt-Android.apk',
  installerUrl: '',
  installerBytes: 1,
  sumsUrl: null,
})

describe('moving from the APK to Google Play', () => {
  beforeEach(() => {
    localStorage.clear()
    shell.mobile = true
  })

  it('is offered for a release whose notes say Play has that version', () => {
    const r = release('1.6.5', '## Fixed\n\n* Something.\n<!-- google-play: 1.6.5 -->')
    expect(onPlay(r)).toBe(true)
    expect(offerPlay(r)).toBe(true)
  })

  it('is not offered when Play has another version, or nothing is said', () => {
    expect(offerPlay(release('1.6.5', '<!-- google-play: 1.6.4 -->'))).toBe(false)
    expect(offerPlay(release('1.6.5', '## Fixed'))).toBe(false)
  })

  it('is not offered on a computer', () => {
    shell.mobile = false
    expect(offerPlay(release('1.6.5', '<!-- google-play: 1.6.5 -->'))).toBe(false)
    expect(canMoveToPlay()).toBe(false)
  })

  it('stops after Keep the APK version, and comes back from Settings', () => {
    const r = release('1.6.5', '<!-- google-play: 1.6.5 -->')
    keepApk()
    expect(offerPlay(r)).toBe(false)
    stopKeepingApk()
    expect(offerPlay(r)).toBe(true)
  })

  it('is offered in Settings only once Basalt has been seen on Play', () => {
    expect(canMoveToPlay()).toBe(false)
    onPlay(release('1.6.5', '<!-- google-play: 1.6.5 -->'))
    expect(canMoveToPlay()).toBe(true)
  })

  it('knows a Fire TV or Fire tablet, which have no Google Play', () => {
    const fireTv =
      'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7633; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36'
    const fireTablet = 'Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.1 like Chrome/120.0 Safari/537.36'
    const googleTv = 'Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36'
    const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
    expect(amazonDevice(fireTv)).toBe(true)
    expect(amazonDevice(fireTablet)).toBe(true)
    expect(amazonDevice(googleTv)).toBe(false)
    expect(amazonDevice(phone)).toBe(false)
  })
})
