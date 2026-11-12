import { describe, expect, it } from 'vitest'

import type { PresentDevice } from './api'
import { ownDevices, seenLine } from './usePresence'

const NOW = 1_800_000_000_000

function device(over: Partial<PresentDevice>): PresentDevice {
  return { device: 'x', name: 'X', online: false, lastSeen: 0, ...over }
}

const household = [
  device({ device: 'tablet', name: 'Galaxy Tab', profile: 'maya', lastSeen: NOW - 3 * 3600_000 }),
  device({ device: 'sam', name: 'Sam’s phone', profile: 'sam', online: true, lastSeen: NOW }),
  device({ device: 'laptop', name: 'Work laptop', profile: 'maya', online: true, lastSeen: NOW }),
  device({ device: 'phone', name: 'Pixel 8', profile: 'maya', online: true, lastSeen: NOW }),
  device({ device: 'loner', name: 'Kitchen PC', online: true, lastSeen: NOW }),
]

describe('your devices', () => {
  it('are the profile’s, this one first, then online, then by name', () => {
    const mine = ownDevices({ devices: household, you: 'phone', supported: true })
    expect(mine.map((d) => d.device)).toEqual(['phone', 'laptop', 'tablet'])
  })

  it('are only this one when it is signed in to no profile', () => {
    const mine = ownDevices({ devices: household, you: 'loner', supported: true })
    expect(mine.map((d) => d.device)).toEqual(['loner'])
  })

  it('are none before the host has answered', () => {
    expect(ownDevices({ devices: [], you: '', supported: true })).toEqual([])
  })
})

describe('when a device was last seen', () => {
  it('reads as a person would say it', () => {
    expect(seenLine(device({ online: true }), NOW)).toBe('Online')
    expect(seenLine(device({ lastSeen: 0 }), NOW)).toBe('Not online')
    expect(seenLine(device({ lastSeen: NOW - 30_000 }), NOW)).toBe('Last seen just now')
    expect(seenLine(device({ lastSeen: NOW - 25 * 60_000 }), NOW)).toBe('Last seen 25 min ago')
    expect(seenLine(device({ lastSeen: NOW - 3 * 3600_000 }), NOW)).toBe('Last seen 3 h ago')
    expect(seenLine(device({ lastSeen: NOW - 26 * 3600_000 }), NOW)).toBe('Last seen yesterday')
    expect(seenLine(device({ lastSeen: NOW - 5 * 86_400_000 }), NOW)).toBe('Last seen 5 days ago')
  })
})
