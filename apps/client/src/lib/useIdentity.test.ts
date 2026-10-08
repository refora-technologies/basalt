// @vitest-environment jsdom
//
// Who is using the device is asked again when something says it may have
// changed, never on a timer: when a request is refused as signed out, and
// when the app comes back to the front.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asked = vi.hoisted(() => ({ identity: 0, profiles: 0 }))

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      identity: async () => {
        asked.identity += 1
        return {
          choose: true,
          profile: null,
          lastProfile: null,
          ended: false,
          rules: { requireProfile: false, ownerAddsProfiles: false },
        }
      },
      profiles: async () => {
        asked.profiles += 1
        return []
      },
    },
  }
})

import { useIdentity } from './useIdentity'

beforeEach(() => {
  asked.identity = 0
  asked.profiles = 0
})

// Each test's hook is gone before the next starts, or it would answer too.
afterEach(cleanup)

describe('asking again who is using the device', () => {
  it('follows a request refused as signed out, at once', async () => {
    const { result } = renderHook(() => useIdentity('host-a'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const before = asked.identity

    window.dispatchEvent(new Event('basalt:signedout'))
    await waitFor(() => expect(asked.identity).toBe(before + 1))
  })

  it('follows the app coming back to the front', async () => {
    const { result } = renderHook(() => useIdentity('host-a'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const before = asked.identity

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(asked.identity).toBe(before + 1))
  })

  it('does not ask on a timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { result } = renderHook(() => useIdentity('host-a'))
      await waitFor(() => expect(result.current.loaded).toBe(true))
      const before = asked.identity
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(asked.identity).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops listening for a host it has left', async () => {
    const { result, unmount } = renderHook(() => useIdentity('host-a'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    unmount()
    const before = asked.identity

    window.dispatchEvent(new Event('basalt:signedout'))
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(asked.identity).toBe(before)
  })
})
