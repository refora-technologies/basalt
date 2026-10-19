// @vitest-environment jsdom
//
// A profile with no PIN yet, made on the host or reset there, used to be
// claimed by whichever paired device signed in first. The host now asks for
// the code it shows for the profile, typed with the new PIN.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileRules, ProfileView } from '@/lib/api'

const calls = vi.hoisted(() => ({
  claimed: [] as Array<[string, string, string]>,
  signedIn: [] as Array<[string, string]>,
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      profilesElsewhere: () => Promise.resolve([]),
      claimProfile: (id: string, code: string, pin: string) => {
        calls.claimed.push([id, code, pin])
        return Promise.resolve({} as ProfileView)
      },
      signInProfile: (id: string, pin: string) => {
        calls.signedIn.push([id, pin])
        return Promise.resolve({} as ProfileView)
      },
    },
  }
})

import { ProfileGate } from './ProfileGate'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sam: ProfileView = { id: 'p-sam', name: 'Sam', color: 1, hasPin: false, lastUsed: 0 }

function show(rules: ProfileRules): void {
  render(
    createElement(ProfileGate, {
      vaultName: 'Media Drive',
      deviceName: 'Maya’s phone',
      profiles: [sam],
      lastProfile: null,
      ended: false,
      rules,
      onDone: vi.fn(),
    }),
  )
}

async function chooseSam(): Promise<void> {
  const tile = await screen.findByText('Sam')
  await act(async () => {
    fireEvent.click(tile)
  })
}

async function typePins(pin: string): Promise<void> {
  // The step slides in: waited for, not assumed.
  fireEvent.change(await screen.findByLabelText('PIN'), { target: { value: pin } })
  fireEvent.change(screen.getByLabelText('Again, to be sure'), { target: { value: pin } })
}

beforeEach(() => {
  calls.claimed = []
  calls.signedIn = []
})

afterEach(() => cleanup())

describe('claiming a profile that has no PIN yet', () => {
  it('asks for the code the host shows, with the new PIN', async () => {
    show({ requireProfile: false, ownerAddsProfiles: false, claimCode: true })
    await chooseSam()

    const code = await screen.findByLabelText('Code from Basalt Host')
    expect(screen.getByText(/Type the code for Sam from Basalt Host/)).toBeTruthy()
    // Without the code, nothing is sent.
    await typePins('1357')
    await act(async () => {
      fireEvent.click(screen.getByText('Set PIN and sign in'))
    })
    expect(await screen.findByText('The code is eight letters and digits.')).toBeTruthy()
    expect(calls.claimed).toEqual([])

    fireEvent.change(code, { target: { value: 'k7qm-4xpr' } })
    await typePins('1357')
    await act(async () => {
      fireEvent.click(screen.getByText('Set PIN and sign in'))
    })
    await waitFor(() => expect(calls.claimed).toEqual([['p-sam', 'K7QM-4XPR', '1357']]))
    expect(calls.signedIn).toEqual([])
  })

  it('does not ask on a host that lets any device claim it', async () => {
    show({ requireProfile: false, ownerAddsProfiles: false, claimCode: false })
    await chooseSam()

    await typePins('1357')
    expect(screen.queryByLabelText('Code from Basalt Host')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText('Set PIN and sign in'))
    })
    await waitFor(() => expect(calls.signedIn).toEqual([['p-sam', '1357']]))
    expect(calls.claimed).toEqual([])
  })
})
