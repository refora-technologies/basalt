// Ready for devices nearby, but the port was taken (another copy of Basalt on
// the same phone held it): it said nothing and looked ready while nothing
// could reach it. Now it says why, plainly.

import { describe, expect, it } from 'vitest'

import { readyNoteFor } from './useNearby'

describe('why a device couldn’t be ready nearby', () => {
  it('says another app holds the port, and that it tries again by itself', () => {
    const note = readyNoteFor("something else on this device is using Basalt's nearby port (7745): close it and try again")
    expect(note).toMatch(/another copy of Basalt/)
    expect(note).toMatch(/tries again by itself/)
    expect(note).not.toMatch(/7745/)
  })

  it('passes on any other reason as it came', () => {
    expect(readyNoteFor('the network is down')).toBe('Devices nearby can’t reach this one: the network is down')
  })
})
