// @vitest-environment jsdom
//
// Typing a host's address in the drive list. It always started a new
// pairing, even for a host this device was paired with, so on a network where
// hosts cannot be found (guest Wi-Fi, a mesh that keeps devices apart, an
// emulator) the way back to a paired host asked for its PIN again. The
// identity card of a typed host also read "Sharing ." with no drive name.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredHost } from '@/lib/api'

const calls = vi.hoisted(() => ({
  identify: [] as string[],
  connect: [] as Array<[string, string | undefined]>,
  pair: [] as string[],
  /** Who answers at a typed address, or nothing. */
  answer: null as DiscoveredHost | null,
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // A network where hosts cannot be found: the reason to type one in.
      discover: () => Promise.resolve([]),
      identifyHost: (address: string) => {
        calls.identify.push(address)
        return calls.answer
          ? Promise.resolve(calls.answer)
          : Promise.reject(new actual.ApiError('offline', 'nothing answered'))
      },
      connectTo: (hostId: string, address?: string) => {
        calls.connect.push([hostId, address])
        return Promise.resolve({ connected: true, hostId } as never)
      },
      beginPairing: (address: string) => {
        calls.pair.push(address)
        return Promise.resolve({ requiresPin: true, setup: false })
      },
      cancelPairing: () => Promise.resolve(),
    },
  }
})

import { PairingView } from './PairingView'

// Lets React flush updates inside act(), as a test environment should.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const living: DiscoveredHost = {
  hostId: 'c3228c6a'.repeat(8),
  hostName: 'LIVING-ROOM-PC',
  vault: 'Media Drive',
  address: '192.168.1.13:7742',
  requiresPin: true,
  hasVault: true,
  paired: false,
  needsSetup: false,
}

async function typeAddress(address: string): Promise<void> {
  const open = await screen.findByText('Enter the address instead')
  await act(async () => {
    fireEvent.click(open)
  })
  fireEvent.change(screen.getByLabelText('Host address'), { target: { value: address } })
  await act(async () => {
    fireEvent.click(screen.getByText('Connect'))
  })
}

beforeEach(() => {
  calls.identify = []
  calls.connect = []
  calls.pair = []
  calls.answer = null
})

afterEach(() => cleanup())

describe('typing a host’s address', () => {
  it('reconnects to a host this device has paired with, without pairing again', async () => {
    calls.answer = { ...living, paired: true }
    const onPaired = vi.fn()
    render(createElement(PairingView, { onPaired }))

    await typeAddress('192.168.1.13')

    // The port is added, the host asked who it is, and it is reconnected to.
    expect(calls.identify).toEqual(['192.168.1.13:7742'])
    await waitFor(() => expect(calls.connect).toEqual([[living.hostId, living.address]]))
    expect(calls.pair).toEqual([])
    await waitFor(() => expect(onPaired).toHaveBeenCalled())
  })

  it('pairs with a new host under its own name and drive', async () => {
    calls.answer = living
    render(createElement(PairingView, { onPaired: vi.fn() }))

    await typeAddress('192.168.1.13:7742')

    await waitFor(() => expect(calls.pair).toEqual(['192.168.1.13:7742']))
    expect(calls.connect).toEqual([])
    // The PIN screen names the host it found, not the address typed.
    expect(await screen.findByText(/Type the six digits shown on LIVING-ROOM-PC/)).toBeTruthy()
    expect(screen.getByText('Media Drive')).toBeTruthy()
    expect(screen.getByText(living.hostId.slice(0, 8))).toBeTruthy()
  })

  it('does not say “Sharing .” for a host with no drive shared yet', async () => {
    calls.answer = { ...living, vault: '', hasVault: false }
    render(createElement(PairingView, { onPaired: vi.fn() }))

    await typeAddress('192.168.1.13')

    await waitFor(() => expect(calls.pair).toHaveLength(1))
    const card = await screen.findByText(/Check that this identity matches/)
    expect(card.textContent).not.toContain('Sharing')
  })

  it('says so when nothing answers at the address', async () => {
    render(createElement(PairingView, { onPaired: vi.fn() }))

    await typeAddress('10.0.0.99')

    expect(
      await screen.findByText(
        'Nothing answered at 10.0.0.99:7742. The address is shown in Basalt Host’s window.',
      ),
    ).toBeTruthy()
    expect(calls.pair).toEqual([])
    expect(calls.connect).toEqual([])
  })
})
