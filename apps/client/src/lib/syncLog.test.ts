// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'

import { clearSyncLog, setSyncLogOn, syncLog, syncLogText } from './syncLog'

afterEach(() => {
  setSyncLogOn(false)
  clearSyncLog()
})

describe('the sync log', () => {
  it('keeps nothing while off, and each line with its time while on', () => {
    syncLog('nobody hears this')
    expect(syncLogText()).toBe('')
    setSyncLogOn(true)
    syncLog('gap 6 ms, speed 1')
    syncLog('group v4 playing at 40.5 s')
    const text = syncLogText().split('\n')
    expect(text).toHaveLength(2)
    expect(text[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} gap 6 ms, speed 1$/)
    setSyncLogOn(false)
    expect(syncLogText()).toBe('')
  })
})
