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
  forgot: [] as string[],
  /** Who answers at a typed address, or nothing. */
  answer: null as DiscoveredHost | null,
  /** What a search turns up. */
  discovered: [] as DiscoveredHost[],
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      // A network where hosts cannot be found: the reason to type one in.
      discover: () => Promise.resolve(calls.discovered),
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
      forgetHost: (hostId: string) => {
        calls.forgot.push(hostId)
        calls.discovered = calls.discovered.filter((h) => h.hostId !== hostId)
        return Promise.resolve({ connected: true } as never)
      },
    },
  }
})

import { groupHosts, PairingView } from './PairingView'

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
  const open = await screen.findByText('Enter the address or computer name')
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
  calls.forgot = []
  calls.answer = null
  calls.discovered = []
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

describe('a paired host the search did not find', () => {
  it('is listed, dimmed, and reconnected to with a tap', async () => {
    const attic: DiscoveredHost = {
      ...living,
      hostId: '3b7d1f9e'.repeat(8),
      hostName: 'ATTIC-NAS',
      vault: 'Archive',
      address: '192.168.1.8:7742',
      paired: true,
      seen: false,
    }
    calls.discovered = [{ ...living, seen: true }, attic]
    const onPaired = vi.fn()
    render(createElement(PairingView, { onPaired }))

    const row = (await screen.findByText('Archive')).closest('button')!
    expect(row.textContent).toContain('not found right now')
    expect(row.disabled).toBe(false)
    // After the hosts that were found.
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    const atticAt = names.findIndex((t) => t.includes('Archive'))
    const livingAt = names.findIndex((t) => t.includes('Media Drive'))
    expect(livingAt).toBeLessThan(atticAt)

    await act(async () => {
      fireEvent.click(row)
    })
    await waitFor(() => expect(calls.connect).toEqual([[attic.hostId, attic.address]]))
    expect(calls.pair).toEqual([])
    await waitFor(() => expect(onPaired).toHaveBeenCalled())
  })
})

describe('a long list of drives', () => {
  const host = (id: string, name: string, more: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
    ...living,
    hostId: id.repeat(8),
    hostName: `${name.toUpperCase()}-PC`,
    vault: name,
    ...more,
  })
  const inUse = host('11111111', 'Home', { paired: true })
  const office = host('22222222', 'Office', { paired: true })
  const fresh = host('33333333', 'Neighbour')
  const away = host('44444444', 'Attic', { paired: true, seen: false })

  it('is in groups: yours with the one in use first, new ones, then those not found', () => {
    const groups = groupHosts([fresh, office, away, inUse], inUse.hostId)
    expect(groups.map((g) => [g.title, g.hosts.map((h) => h.vault)])).toEqual([
      ['Your drives', ['Home', 'Office']],
      ['New on this network', ['Neighbour']],
      ['Not found right now', ['Attic']],
    ])
  })

  it('leaves out groups with nothing in them', () => {
    expect(groupHosts([fresh], null).map((g) => g.title)).toEqual(['New on this network'])
  })

  it('forgets a paired drive from its menu, after asking', async () => {
    calls.discovered = [inUse, office]
    render(createElement(PairingView, { onPaired: vi.fn(), currentHostId: inUse.hostId, onBack: vi.fn() }))
    const row = (await screen.findByText('Office')).closest('button')!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    await act(async () => {
      fireEvent.click(await screen.findByText('Forget this drive…'))
    })
    // Nothing forgotten until it is confirmed.
    expect(calls.forgot).toEqual([])
    await act(async () => {
      fireEvent.click(await screen.findByText('Forget'))
    })
    await waitFor(() => expect(calls.forgot).toEqual([office.hostId]))
    await waitFor(() => expect(screen.queryByText('Office')).toBeNull())
  })

  it('offers nothing to forget for the drive in use', async () => {
    calls.discovered = [inUse]
    render(createElement(PairingView, { onPaired: vi.fn(), currentHostId: inUse.hostId, onBack: vi.fn() }))
    const row = (await screen.findByText('Home')).closest('button')!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    expect(screen.queryByText('Forget this drive…')).toBeNull()
  })
})
