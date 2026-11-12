import { describe, expect, it } from 'vitest'

import type { MusicGroup } from './api'
import { groupPosition, groupSong, isHostGroup, stepFor } from './musicGroup'

function group(over: Partial<MusicGroup> = {}): MusicGroup {
  return {
    id: 'g1',
    members: [
      { device: 'laptop', name: 'Laptop' },
      { device: 'phone', name: 'Phone' },
    ],
    listening: { queue: ['a.mp3', 'b.mp3'], index: 0, position: 30, shuffle: false, repeat: 'off', from: '', updated: 0 },
    playing: true,
    at: 10_000,
    version: 3,
    ...over,
  }
}

describe('a group playing together', () => {
  it('is at its second by the host clock, and still when paused', () => {
    expect(groupPosition(group(), 12_000)).toBe(32)
    expect(groupPosition(group(), 9_000)).toBe(30)
    expect(groupPosition(group({ playing: false }), 99_000)).toBe(30)
    expect(groupSong(group())).toBe('a.mp3')
    expect(isHostGroup('g12')).toBe(true)
    expect(isHostGroup('5f3a9c')).toBe(false)
  })

  // The host's clock 500 ms ahead of this device's.
  const offset = 500

  it('opens another song, to start at the stamped moment', () => {
    const step = stepFor(group({ at: 12_000 }), { song: 'b.mp3', playing: true, position: 5 }, offset, 10_000)
    expect(step).toEqual({ do: 'open', from: 30, at: 11_500, paused: false })
    // Paused there: opened paused.
    expect(stepFor(group({ playing: false }), { song: null, playing: false, position: 0 }, offset, 20_000)).toEqual({
      do: 'open',
      from: 30,
      at: null,
      paused: true,
    })
  })

  it('plays or seeks at the moment, the one that asked as the others (no undoing, F5)', () => {
    // A seek stamped ahead: from there, at that moment.
    expect(stepFor(group({ at: 12_000, listening: { ...group().listening, position: 90 } }), { song: 'a.mp3', playing: true, position: 40 }, offset, 11_000)).toEqual({
      do: 'playAt',
      from: 90,
      at: 11_500,
    })
    // Already in step: nothing, the keeping in step does the rest.
    expect(stepFor(group(), { song: 'a.mp3', playing: true, position: 32.1 }, offset, 11_500)).toEqual({ do: 'nothing' })
    // Paused here while the group plays: on again, a moment ahead.
    expect(stepFor(group(), { song: 'a.mp3', playing: false, position: 30 }, offset, 11_500)).toEqual({
      do: 'playAt',
      from: 32.3,
      at: 11_800,
    })
  })

  it('pauses at the stamped moment, at the group’s second', () => {
    expect(stepFor(group({ playing: false, at: 12_000 }), { song: 'a.mp3', playing: true, position: 31 }, offset, 11_000)).toEqual({
      do: 'pause',
      position: 30,
      at: 11_500,
    })
    expect(stepFor(group({ playing: false }), { song: 'a.mp3', playing: false, position: 30.1 }, offset, 20_000)).toEqual({ do: 'nothing' })
  })
})
