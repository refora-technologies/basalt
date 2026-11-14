// @vitest-environment jsdom
//
// What's new shows once, after updating to 1.6.4: never to a device that is
// new here (it has the setup steps), never twice. Each kind of device gets
// the cards that are true for it.

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TOUR_VERSION, tourDue } from './featureTour'
import { cardsFor } from '@/components/FeatureTour'
import { Tip } from '@/components/share/Tip'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('when What’s new shows', () => {
  it('shows to a device that comes from an older version', () => {
    // 1.6.3 kept no "seen", but it had kept things, or was paired.
    expect(tourDue(null, true)).toBe(true)
  })

  it('never shows to a device that is new here', () => {
    expect(tourDue(null, false)).toBe(false)
  })

  it('shows once: not again after it was seen', () => {
    expect(tourDue(TOUR_VERSION, true)).toBe(false)
  })

  it('shows again for a later version with cards of its own', () => {
    expect(tourDue('1.6.4', true, '1.7.0')).toBe(true)
  })
})

describe('the cards each device gets', () => {
  it('a phone: sharing, nearby with its switch, ready in the background with its switch, music', () => {
    const cards = cardsFor('phone', false, false)
    expect(cards.map((c) => c.art)).toEqual(['share', 'nearby', 'background', 'music'])
    expect(cards.map((c) => c.control ?? null)).toEqual([null, 'nearby', 'ready', null])
  })

  it('a computer with a tray says what closing the window does now', () => {
    const cards = cardsFor('computer', true, false)
    expect(cards.map((c) => c.art)).toEqual(['share', 'nearby', 'tray', 'music'])
    expect(cards[0]!.line).toContain('File Explorer')
  })

  it('a Linux desktop with no tray leaves that card out, and names the file manager', () => {
    const cards = cardsFor('computer', false, true)
    expect(cards.map((c) => c.art)).toEqual(['share', 'nearby', 'music'])
    expect(cards[0]!.line).toContain('file manager')
  })
})

describe('a tip', () => {
  it('shows the first time its moment comes, and not again', () => {
    const tip = createElement(Tip, { id: 'test', art: 'code', title: 'Busy place? Ask for a code', line: 'They type the code on your screen.' })
    render(tip)
    expect(screen.queryByText('Busy place? Ask for a code')).not.toBeNull()
    cleanup()
    render(tip)
    expect(screen.queryByText('Busy place? Ask for a code')).toBeNull()
  })
})
