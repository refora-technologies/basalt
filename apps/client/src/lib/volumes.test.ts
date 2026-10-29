// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { rememberVolume, rememberedVolume } from './volumes'

describe('volumes kept apart', () => {
  beforeEach(() => localStorage.clear())

  it('starts music lower than films the first time', () => {
    expect(rememberedVolume('music')).toBe(70)
    expect(rememberedVolume('video')).toBe(100)
  })

  it('keeps each as last set, apart from the other', () => {
    rememberVolume('music', 35)
    rememberVolume('video', 120)
    expect(rememberedVolume('music')).toBe(35)
    expect(rememberedVolume('video')).toBe(120)
  })

  it('keeps each within its own range', () => {
    rememberVolume('music', 130)
    rememberVolume('video', -5)
    expect(rememberedVolume('music')).toBe(100)
    expect(rememberedVolume('video')).toBe(0)
  })

  it('ignores what is not a number', () => {
    rememberVolume('music', Number.NaN)
    expect(rememberedVolume('music')).toBe(70)
    localStorage.setItem('basalt.volume.video', 'loud')
    expect(rememberedVolume('video')).toBe(100)
  })
})
