import { describe, expect, it } from 'vitest'

import type { ChannelMessage, PresentDevice } from './api'
import {
  KIND,
  apply,
  calledOf,
  isProgram,
  received,
  takesWithoutAsking,
  targetsOf,
  titleOf,
  totalOf,
  type OfferBody,
  type ShareItem,
} from './share'

function device(over: Partial<PresentDevice>): PresentDevice {
  return { device: 'x', name: 'X', online: true, lastSeen: 1, ...over }
}

const household = [
  device({ device: 'me', name: 'Laptop', form: 'computer', profile: 'maya', profileName: 'Maya' }),
  device({ device: 'tablet', name: 'Galaxy Tab', form: 'tablet', profile: 'maya', profileName: 'Maya', online: false }),
  device({ device: 'phone', name: 'Pixel', form: 'phone', profile: 'maya', profileName: 'Maya' }),
  device({ device: 'tv', name: 'Living room TV', form: 'tv', profile: 'maya', profileName: 'Maya' }),
  device({ device: 'sam-phone', name: 'Sam phone', form: 'phone', profile: 'sam', profileName: 'Sam' }),
  device({ device: 'amma-phone', name: 'Amma phone', form: 'phone', profile: 'amma', profileName: 'Amma', online: false }),
  device({ device: 'kitchen', name: 'Kitchen PC', form: 'computer' }),
]

const offer: OfferBody = {
  offer: 'o1',
  files: [{ name: 'Holiday 2026.mkv', size: 4_200_000_000, path: 'Films/Holiday 2026.mkv' }],
  from: { device: 'phone', name: 'Pixel', form: 'phone', profile: 'maya', profileName: 'Maya' },
  to: { device: 'sam-phone', name: 'Sam phone', form: 'phone', profile: 'sam', profileName: 'Sam' },
}

function answer(body: object): ChannelMessage {
  return {
    id: 'm',
    fromDevice: 'sam-phone',
    fromName: 'Sam phone',
    to: { to: 'device', device: 'phone' },
    kind: KIND.answer,
    body,
    sent: 1,
    expires: 2,
  }
}

describe('where a share can go', () => {
  it('is my other devices, then the home by person; never this one, never a TV', () => {
    const t = targetsOf(household, 'me')
    expect(t.mine.map((d) => d.device)).toEqual(['phone', 'tablet'])
    expect(t.home.map((g) => g.name)).toEqual(['Sam', 'Amma'])
    expect(t.home[0]!.devices.map((d) => d.device)).toEqual(['sam-phone'])
    expect(t.loose.map((d) => d.device)).toEqual(['kitchen'])
    expect(JSON.stringify(t)).not.toContain('"tv"')
  })
})

describe('taking a share without asking', () => {
  it('happens from my own devices, and from the home only when asked for', () => {
    expect(takesWithoutAsking(offer, 'maya', false)).toBe(true)
    expect(takesWithoutAsking(offer, 'sam', false)).toBe(false)
    expect(takesWithoutAsking(offer, 'sam', true)).toBe(true)
    expect(takesWithoutAsking(offer, undefined, false)).toBe(false)
  })
})

describe('answers to a share sent', () => {
  const sent: ShareItem = { ...received(offer, 10), direction: 'out', peer: offer.to }

  it('move it on, and say when another device took it', () => {
    const accepted = apply([sent], answer({ offer: 'o1', answer: 'accepted', by: offer.to }))
    expect(accepted[0]!.state).toBe('moving')
    const laptop = { device: 'sam-laptop', name: 'Sam laptop' }
    const done = apply(accepted, answer({ offer: 'o1', answer: 'done', by: laptop }))
    expect(done[0]!.state).toBe('done')
    expect(done[0]!.takenOn).toBe('Sam laptop')
  })

  it('never take it backwards, and leave other shares alone', () => {
    const done = apply([sent], answer({ offer: 'o1', answer: 'done', by: offer.to }))
    expect(apply(done, answer({ offer: 'o1', answer: 'accepted', by: offer.to }))[0]!.state).toBe('done')
    expect(apply([sent], answer({ offer: 'other', answer: 'declined', by: offer.to }))[0]!.state).toBe('waiting')
  })
})

describe('words', () => {
  it('name the files and the devices as a person would', () => {
    expect(titleOf(offer.files)).toBe('Holiday 2026.mkv')
    expect(titleOf([...offer.files, ...offer.files, ...offer.files])).toBe('Holiday 2026.mkv and 2 more')
    expect(totalOf(offer.files)).toBe(4_200_000_000)
    expect(calledOf(offer.from, 'maya')).toBe('your phone')
    expect(calledOf(offer.from, 'sam')).toBe('Maya’s phone')
    expect(calledOf({ device: 'k', name: 'Kitchen PC' }, 'sam')).toBe('Kitchen PC')
  })

  it('know a program when they see one', () => {
    expect(isProgram('setup.exe')).toBe(true)
    expect(isProgram('Basalt.apk')).toBe(true)
    expect(isProgram('notes.txt')).toBe(false)
  })
})

describe('why a share didn’t arrive', () => {
  it('is said plainly', async () => {
    const { plainReason } = await import('./useInbox')
    expect(plainReason('protocol: the device that sent it said: java.io.FileNotFoundException: No item at content://x')).toBe(
      'It’s no longer on the device that sent it.',
    )
    expect(plainReason("config: couldn't reach the device that sent it at 1.2.3.4:5")).toBe(
      'The two devices couldn’t reach each other on this Wi-Fi.',
    )
    expect(plainReason('protocol: the device that sent it said: that isn’t offered'.replace('’', "'"))).toBe('The device that sent it took it back.')
  })
})
