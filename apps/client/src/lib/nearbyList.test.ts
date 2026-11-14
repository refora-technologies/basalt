import { describe, expect, it } from 'vitest'

import { NEAR_FOR_MS, stillNear, type Seen } from './nearbyList'

interface Device {
  id: string
  key: string
  address: string
}

const pixel: Device = { id: 'K7HM', key: 'a1', address: '192.168.1.20' }
const laptop: Device = { id: 'W3RT', key: 'b2', address: '192.168.1.31' }

describe('the devices nearby, between looks', () => {
  it('keeps a device a look missed, for a little while', () => {
    const seen = new Map<string, Seen<Device>>()
    expect(stillNear(seen, [pixel, laptop], 0)).toEqual([pixel, laptop])
    // The next look heard only the laptop: the phone is still listed.
    expect(stillNear(seen, [laptop], 4_000)).toEqual([pixel, laptop])
    expect(stillNear(seen, [laptop], 8_000)).toEqual([pixel, laptop])
  })

  it('lets it go once it has not answered for a while', () => {
    const seen = new Map<string, Seen<Device>>()
    stillNear(seen, [pixel, laptop], 0)
    expect(stillNear(seen, [laptop], NEAR_FOR_MS + 1)).toEqual([laptop])
    expect(stillNear(seen, [], 3 * NEAR_FOR_MS)).toEqual([])
  })

  it('lists it as it answered last', () => {
    const seen = new Map<string, Seen<Device>>()
    stillNear(seen, [pixel], 0)
    const moved = { ...pixel, address: '192.168.49.1' }
    expect(stillNear(seen, [moved], 4_000)).toEqual([moved])
  })

  it('tells two devices with the same letters apart by their keys', () => {
    const seen = new Map<string, Seen<Device>>()
    const other = { ...pixel, key: 'zz' }
    expect(stillNear(seen, [pixel, other], 0)).toHaveLength(2)
  })
})
