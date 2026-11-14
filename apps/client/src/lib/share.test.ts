import { describe, expect, it } from 'vitest'

import type { ChannelMessage, PresentDevice } from './api'
import {
  KIND,
  OFFER_TTL_MS,
  apply,
  endedUnanswered,
  unanswered,
  calledOf,
  isProgram,
  progressIn,
  progressLine,
  received,
  timeLeft,
  takesWithoutAsking,
  COMING_THROUGH_HOST,
  THROUGH_HOST_TTL_MS,
  sentItem,
  steadyTargets,
  targetsOf,
  canTakeBack,
  fromMyProfile,
  trustedOffer,
  endedSilent,
  goneSilent,
  takenBack,
  SILENT_TTL_MS,
  throughHostFiles,
  throughHostSaid,
  toldOf,
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

describe('the list while the share sheet is open', () => {
  const ids = (t: ReturnType<typeof targetsOf>): string[] => [
    ...t.mine.map((d) => d.device),
    ...t.home.flatMap((g) => g.devices.map((d) => d.device)),
    ...t.loose.map((d) => d.device),
  ]
  const first = targetsOf(household, 'me')

  it('keeps every row in its place when a device goes on or off line', () => {
    const changed = household.map((d) =>
      d.device === 'tablet' ? { ...d, online: true } : d.device === 'phone' ? { ...d, online: false } : d,
    )
    const rebuilt = targetsOf(changed, 'me')
    // Rebuilt from scratch, the tablet would jump above the phone.
    expect(rebuilt.mine.map((d) => d.device)).toEqual(['tablet', 'phone'])
    const steady = steadyTargets(first, rebuilt)
    expect(ids(steady)).toEqual(ids(first))
    // The dots still say what is true now.
    expect(steady.mine.find((d) => d.device === 'tablet')!.online).toBe(true)
    expect(steady.mine.find((d) => d.device === 'phone')!.online).toBe(false)
  })

  it('keeps the rows of a refresh that came back empty for a moment', () => {
    const steady = steadyTargets(first, targetsOf([], ''))
    expect(ids(steady)).toEqual(ids(first))
    expect(steady.home.map((g) => g.name)).toEqual(['Sam', 'Amma'])
  })

  it('adds a device that comes along at the end of its part, moving no one', () => {
    const more = [
      ...household,
      device({ device: 'a-laptop', name: 'A laptop', form: 'computer', profile: 'maya', profileName: 'Maya' }),
      device({ device: 'nimal-phone', name: 'Nimal phone', form: 'phone', profile: 'nimal', profileName: 'Nimal' }),
    ]
    const steady = steadyTargets(first, targetsOf(more, 'me'))
    expect(steady.mine.map((d) => d.device)).toEqual(['phone', 'tablet', 'a-laptop'])
    expect(steady.home.map((g) => g.name)).toEqual(['Sam', 'Amma', 'Nimal'])
    expect(steady.loose.map((d) => d.device)).toEqual(['kitchen'])
  })

  it('takes the first list as it is', () => {
    expect(steadyTargets(null, first)).toBe(first)
  })
})

describe('a share sent straight across that can\'t reach the receiver', () => {
  const files = [{ name: 'Trip.mp4', size: 5_000_000, path: '', source: 'C:/Users/You/Videos/Trip.mp4' }]
  const body: OfferBody = { ...offer, files: toldOf(files) }

  it('tells the other side nothing of where the file is here', () => {
    expect(JSON.stringify(body)).not.toContain('C:/Users')
  })

  it('keeps, here, where its files are, so they can go through the host', () => {
    const sent = sentItem(body, files, 5)
    expect(throughHostFiles(sent)).toEqual([{ source: 'C:/Users/You/Videos/Trip.mp4', name: 'Trip.mp4', size: 5_000_000 }])
  })

  it('says out loud, on both sides, that it switched to the host', () => {
    // Seen in testing: the sender carried on as if nothing happened, and the
    // other phone showed nothing coming; the line on the row went unseen.
    expect(throughHostSaid('out', 'Maya’s phone')).toBe('Couldn’t reach Maya’s phone directly: sending it through your host instead')
    expect(throughHostSaid('in', 'Living room PC')).toBe('Couldn’t reach Living room PC directly: it’s coming through your host instead')
  })

  it('takes who sent it from the host, not from the offer itself', () => {
    // Another profile's device naming one of mine as the sender: asked, not taken.
    const forged: OfferBody = { ...body, from: { ...body.from, device: 'my-laptop', profile: 'me' } }
    const trusted = trustedOffer(forged, { fromDevice: 'their-phone', fromProfile: 'them' })
    expect(trusted.from.device).toBe('their-phone')
    expect(trusted.from.profile).toBe('them')
    expect(trusted.from.name).toBe(forged.from.name)
    expect(takesWithoutAsking(trusted, 'me', false)).toBe(false)
    expect(fromMyProfile({ fromProfile: 'them' }, 'me')).toBe(false)
    expect(fromMyProfile({ fromProfile: 'me' }, 'me')).toBe(true)
    expect(fromMyProfile({}, undefined)).toBe(false)
  })

  it('can be stopped from here while it waits or goes, and stays stopped', () => {
    const waiting = sentItem(body, files, 5)
    const moving: ShareItem = { ...waiting, state: 'moving' }
    expect(canTakeBack(waiting)).toBe(true)
    expect(canTakeBack(moving)).toBe(true)
    expect(takenBack(waiting).reason).toBe('You took it back.')
    expect(takenBack(moving).reason).toBe('You stopped it.')
    // Not one read from the drive, gone up to the host, ended, or coming here.
    expect(canTakeBack({ ...moving, files: [{ name: 'Trip.mp4', size: 5, path: 'Videos/Trip.mp4' }] })).toBe(false)
    expect(canTakeBack({ ...moving, reason: 'On the host until it’s taken' })).toBe(false)
    expect(canTakeBack({ ...moving, state: 'done' })).toBe(false)
    expect(canTakeBack({ ...moving, direction: 'in' })).toBe(false)
    // The other device, cut off, says it failed: this side still says why.
    const stopped = takenBack(moving)
    const after = apply([stopped], answer({ offer: moving.id, answer: 'failed', by: body.to, reason: 'It stopped part-way.' }))
    expect(after[0]?.reason).toBe('You stopped it.')
  })

  it('stops saying "sending" once the other device has long gone silent', () => {
    // The phone taking it was switched off: the row said "sending" at 40%
    // for ever, through every restart.
    const moving: ShareItem = { ...sentItem(body, files, 1_000), state: 'moving' }
    const heard = (at: number | undefined) => (): number | undefined => at
    const later = 1_000 + SILENT_TTL_MS + 1
    expect(goneSilent([moving], heard(undefined), 0, later)).toEqual([moving])
    // Heard from since, or this app only just started: still given time.
    expect(goneSilent([moving], heard(later - 5_000), 0, later)).toEqual([])
    expect(goneSilent([moving], heard(undefined), later - 5_000, later)).toEqual([])
    // One going by the host waits as the host says; one coming here is not this side's to end.
    expect(goneSilent([{ ...moving, reason: 'On the host until it’s taken' }], heard(undefined), 0, later)).toEqual([])
    expect(goneSilent([{ ...moving, direction: 'in' }], heard(undefined), 0, later)).toEqual([])
    const ended = endedSilent(moving)
    expect(ended.state).toBe('failed')
    expect(ended.reason).toMatch(/Lost touch with .* Check there whether it arrived/)
    // And if it did arrive after all, its "done" still counts.
    const done = apply([ended], answer({ offer: moving.id, answer: 'done', by: body.to }))
    expect(done[0]?.state).toBe('done')
  })

  it('ends on the receiver if it never comes through the host', () => {
    const coming: ShareItem = { ...received(offer, 0), state: 'moving', reason: COMING_THROUGH_HOST, since: 1_000 }
    expect(unanswered([coming], 1_000 + THROUGH_HOST_TTL_MS - 1)).toEqual([])
    expect(unanswered([coming], 1_000 + THROUGH_HOST_TTL_MS + 1)).toEqual([coming])
    expect(endedUnanswered(coming).state).toBe('failed')
    expect(endedUnanswered(coming).reason).toContain('through the host')
    // One moving straight across is left alone: it says how far it got.
    expect(unanswered([{ ...coming, reason: undefined }], 10 * THROUGH_HOST_TTL_MS)).toEqual([])
  })

  it('has nothing to send through the host for files on the drive', () => {
    const onDrive = sentItem(offer, offer.files, 5)
    expect(throughHostFiles(onDrive)).toBeNull()
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

  it('say when the host removed one still waiting, as no device taking it', () => {
    const host = { device: 'host-1', name: 'FST' }
    const removed = apply([sent], answer({ offer: 'o1', answer: 'removed', by: host, reason: 'Removed by the host' }))
    expect(removed[0]!.state).toBe('failed')
    expect(removed[0]!.reason).toBe('Removed by the host')
    expect(removed[0]!.takenOn).toBeUndefined()
  })

  it('drop why it was waiting once it moves on', () => {
    const viaHost: ShareItem = { ...sent, reason: 'On the host until it’s back' }
    const accepted = apply([viaHost], answer({ offer: 'o1', answer: 'accepted', by: offer.to }))
    expect(accepted[0]!.reason).toBeUndefined()
    const done = apply([viaHost], answer({ offer: 'o1', answer: 'done', by: offer.to }))
    expect(done[0]!.reason).toBeUndefined()
    const declined = apply([viaHost], answer({ offer: 'o1', answer: 'declined', by: offer.to, reason: 'Not now' }))
    expect(declined[0]!.reason).toBe('Not now')
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

describe('how far a share has come', () => {
  const item: ShareItem = {
    id: 'o9',
    direction: 'in',
    files: [
      { name: 'a.jpg', size: 1_000, path: '' },
      { name: 'b.mp4', size: 9_000, path: '' },
    ],
    peer: { device: 'p', name: 'Phone' },
    state: 'moving',
    at: 1,
  }
  const format = (bytes: number): string => `${bytes} B`

  it('counts the files before the one moving as done', () => {
    const p = progressIn(
      item,
      [
        { id: 'share-o9-0', transferred: 1_000, status: 'done', rate: 0 },
        { id: 'share-o9-1', transferred: 4_000, status: 'active', rate: 500 },
        { id: 'share-other-0', transferred: 7, status: 'active', rate: 99 },
      ],
      5,
    )
    expect(p).toEqual({ done: 5_000, total: 10_000, rate: 500, at: 5 })
    expect(progressLine(p!, format)).toBe('50% · 5000 B of 10000 B · 500 B/s · 10 s left')
  })

  it('is nothing until a file starts', () => {
    expect(progressIn(item, [], 5)).toBeNull()
  })

  it('says the time left as a person would', () => {
    expect(timeLeft(9.2)).toBe('10 s')
    expect(timeLeft(150)).toBe('3 min')
    expect(timeLeft(3_900)).toBe('1 h 5 min')
  })
})

describe('a share nobody answers', () => {
  const peer = { device: 'p', name: 'Phone' }
  const files = [{ name: 'a.jpg', size: 1, path: '' }]
  const offer = (held: boolean): OfferBody => ({
    offer: 'o',
    files,
    from: peer,
    to: { device: 'me', name: 'Me' },
    held,
  })
  const at = 1_000_000
  const sent: ShareItem = { id: 's', direction: 'out', files, peer, state: 'waiting', at }
  const viaHost: ShareItem = { ...sent, id: 'h', reason: 'On the host until it’s back' }
  const asked: ShareItem = { id: 'a', direction: 'in', files, peer, state: 'waiting', at, offer: offer(false) }
  const held: ShareItem = { ...asked, id: 'k', offer: offer(true) }
  const moving: ShareItem = { ...sent, id: 'm', state: 'moving' }
  const all = [sent, viaHost, asked, held, moving]

  it('ends after ten minutes when it went straight across, either way', () => {
    expect(unanswered(all, at + OFFER_TTL_MS - 1)).toEqual([])
    expect(unanswered(all, at + OFFER_TTL_MS + 1).map((i) => i.id)).toEqual(['s', 'a'])
  })

  it('leaves one kept on the host to the host, and one already moving alone', () => {
    const ids = unanswered(all, at + 24 * 60 * OFFER_TTL_MS).map((i) => i.id)
    expect(ids).not.toContain('h')
    expect(ids).not.toContain('k')
    expect(ids).not.toContain('m')
  })

  it('says why, and keeps nothing to accept', () => {
    expect(endedUnanswered(sent)).toMatchObject({ state: 'failed', reason: 'No answer in 10 minutes.' })
    const ended = endedUnanswered(asked)
    expect(ended.state).toBe('failed')
    expect(ended.offer).toBeUndefined()
    expect(ended.reason).toMatch(/send it again/)
  })
})
