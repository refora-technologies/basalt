// What a device found by Bluetooth said about itself, read as the list
// shows it: one row per device, however many addresses Bluetooth heard it
// under, and nothing that isn't ours.

import { describe, expect, it } from 'vitest'

import { parseSeen, reachNote } from './nearbyBle'

const info = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, id: 'K7HM', name: 'Maya’s laptop', form: 'computer', ssid: 'DIRECT-bs-K7HM Maya_s laptop', code: false, ...over })

describe('devices found by Bluetooth', () => {
  it('reads who each one is, with the Wi-Fi it opens', () => {
    const [d] = parseSeen([{ address: 'a1r', info: info(), rssi: -60 }])
    expect(d).toEqual({
      address: 'a1r',
      id: 'K7HM',
      name: 'Maya’s laptop',
      form: 'computer',
      ssid: 'DIRECT-bs-K7HM Maya_s laptop',
      code: false,
      rssi: -60,
      open: false,
    })
  })

  it('shows a device heard under two addresses once, by the stronger', () => {
    const list = parseSeen([
      { address: 'old', info: info(), rssi: -80 },
      { address: 'new', info: info(), rssi: -55 },
    ])
    expect(list.map((d) => d.address)).toEqual(['new'])
  })

  it('leaves out what isn’t ours or was cut short', () => {
    const list = parseSeen([
      { address: 'x', info: '{"v":2,"id":"AAAA","ssid":"s"}', rssi: -50 },
      { address: 'y', info: '{"v":1,"id":"BB', rssi: -50 },
      { address: 'z', info: '{"v":1,"name":"no id"}', rssi: -50 },
    ])
    expect(list).toEqual([])
  })

  it('puts the strongest first, and a kind it doesn’t know as none', () => {
    const list = parseSeen([
      { address: 'far', info: info({ id: 'FAR1', form: 'fridge' }), rssi: -90 },
      { address: 'near', info: info({ id: 'NEAR' }), rssi: -40 },
    ])
    expect(list.map((d) => d.id)).toEqual(['NEAR', 'FAR1'])
    expect(list[1]!.form).toBeUndefined()
  })
})

describe('a device that can’t be found, telling us it’s here', () => {
  it('is listed with its Wi-Fi already open, nothing to ask', () => {
    const [d] = parseSeen([{ address: 'here:K7HM', info: info(), rssi: -60, open: true }])
    expect(d!.open).toBe(true)
  })
})

describe('what stands in the way', () => {
  it('says nothing when ready, and what to do otherwise', () => {
    expect(reachNote('ready')).toBeNull()
    expect(reachNote('bluetooth')).toContain('Turn on Bluetooth')
    expect(reachNote('ask')).toContain('Allow Basalt')
    expect(reachNote('unsupported')).toContain('same Wi-Fi')
  })
})
