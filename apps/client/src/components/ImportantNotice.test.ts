import { beforeEach, describe, expect, it } from 'vitest'
import { noteFirstStatus, resetNoticeForTests } from './ImportantNotice'

// A plain in-memory localStorage: the tests run without a browser.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage

describe('the update notice', () => {
  beforeEach(() => {
    store.clear()
    resetNoticeForTests()
  })

  // The bug this guards: a brand new phone was told to "update Basalt on all
  // your devices" the moment it first paired.
  it('counts as read on a device that starts never having paired', () => {
    noteFirstStatus({ hasPaired: false })
    expect(store.get('basalt.notice')).toBe('basalt-1.5')
  })

  it('still shows to someone updating, whose device was paired already', () => {
    noteFirstStatus({ hasPaired: true })
    expect(store.has('basalt.notice')).toBe(false)
  })

  it('is decided by the first status of the run, not a later one', () => {
    noteFirstStatus({ hasPaired: true })
    // Forgetting the host later in the same run is not a fresh install.
    noteFirstStatus({ hasPaired: false })
    expect(store.has('basalt.notice')).toBe(false)
  })

  it('waits for a status to arrive', () => {
    noteFirstStatus(null)
    noteFirstStatus({ hasPaired: false })
    expect(store.get('basalt.notice')).toBe('basalt-1.5')
  })
})
