// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import type { NowSession } from '@/lib/api'
import { pickOther } from './NowPlaying'

const session = (device: string, playing: boolean): NowSession => ({
  device,
  name: device,
  at: 0,
  report: {
    listening: { queue: ['a.mp3'], index: 0, position: 0, shuffle: false, repeat: 'off', from: '', updated: 0 },
    playing,
    duration: 100,
  },
})

describe('which other device the bar shows', () => {
  it('keeps showing the same one, whatever order the list comes in', () => {
    const laptop = session('laptop', true)
    const tv = session('tv', true)
    expect(pickOther([laptop, tv], null)?.device).toBe('laptop')
    expect(pickOther([tv, laptop], laptop)?.device).toBe('laptop')
  })

  it('prefers one playing to one paused', () => {
    expect(pickOther([session('tv', false), session('laptop', true)], null)?.device).toBe('laptop')
    // The one shown paused while another plays: the playing one.
    expect(pickOther([session('tv', false), session('laptop', true)], session('tv', false))?.device).toBe('laptop')
  })

  it('moves on when the one shown is gone', () => {
    expect(pickOther([session('tv', true)], session('laptop', true))?.device).toBe('tv')
    expect(pickOther([], session('laptop', true))).toBeNull()
  })
})
