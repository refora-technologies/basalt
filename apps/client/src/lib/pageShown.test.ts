// @vitest-environment jsdom
//
// Devices nearby are looked for only while Basalt is on screen: a phone left
// with a Share sheet open went on looking in the background.

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { usePageShown } from './pageShown'

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => setVisibility('visible'))

describe('whether Basalt is on screen', () => {
  it('follows the app going to the background and coming back', () => {
    const { result } = renderHook(() => usePageShown())
    expect(result.current).toBe(true)
    act(() => setVisibility('hidden'))
    expect(result.current).toBe(false)
    act(() => setVisibility('visible'))
    expect(result.current).toBe(true)
  })
})
