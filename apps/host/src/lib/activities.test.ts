import { describe, expect, it } from 'vitest'

import { activities } from '@/components/Machine'
import type { DeviceView, HostStatus } from './api'

const device = (name: string, sendRate: number, receiveRate: number): DeviceView => ({
  id: name,
  name,
  pairedAt: 0,
  lastSeen: 0,
  writable: true,
  online: true,
  connections: 1,
  sent: 0,
  received: 0,
  sendRate,
  receiveRate,
  keyed: true,
  keyKind: 'chip',
  owner: false,
})

const status = (changes: {
  active?: HostStatus['conversion']['active']
  scanning?: boolean
  previewsNow?: HostStatus['library']['previewsNow']
}): HostStatus =>
  ({
    conversion: { active: changes.active ?? [], measuring: false },
    library: { scanning: changes.scanning ?? false, previewsNow: changes.previewsNow ?? null },
  }) as unknown as HostStatus

describe('what the host is doing now', () => {
  it('says nothing when it is idle', () => {
    expect(activities(status({}), [device('Maya’s laptop', 0, 0)])).toEqual([])
  })

  it('names who files are moving to and from, busiest first, at most two', () => {
    const lines = activities(status({}), [
      device('Sam’s tablet', 2_000, 0),
      device('Maya’s laptop', 21_800_000, 14_000),
      device('Maya’s phone', 0, 6_400_000),
    ])
    expect(lines).toEqual([
      'Sending to Maya’s laptop at 21.8 MB/s',
      'Receiving from Maya’s phone at 6.4 MB/s',
    ])
  })

  it('says what is converted for whom, a scan, and timeline pictures with their count', () => {
    const lines = activities(
      status({
        active: [{ device: 'Pixel 8', file: 'Shows/Northwind/Northwind S01E03.mkv', since: 0 }],
        scanning: true,
        previewsNow: { name: 'Films/Harbour Lights (2021).mkv', done: 2, total: 12 },
      }),
      [],
    )
    expect(lines).toEqual([
      'Converting Northwind S01E03 for Pixel 8',
      'Reading the drive for films, series, music and photos',
      'Making timeline pictures: Harbour Lights (2021) · 3 of 12',
    ])
  })
})
