// Basalt keeps running without a window while anything holds it: the home's
// "always ready", or being ready for devices nearby. A phone with only the
// second (no drive) used to quit when swiped away.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from './api'
import { holdRunning } from './stayRunning'

afterEach(() => {
  holdRunning('ready', false)
  holdRunning('nearby', false)
  vi.restoreAllMocks()
})

describe('staying running without a window', () => {
  it('holds while either reason does, and lets go only when neither does', () => {
    const told = vi.spyOn(api, 'stayRunning').mockResolvedValue(undefined as never)
    holdRunning('nearby', true)
    expect(told).toHaveBeenLastCalledWith(true)
    holdRunning('ready', true)
    holdRunning('ready', false)
    // Still held by nearby: nothing new said.
    expect(told).toHaveBeenCalledTimes(1)
    holdRunning('nearby', false)
    expect(told).toHaveBeenLastCalledWith(false)
    expect(told).toHaveBeenCalledTimes(2)
  })
})
