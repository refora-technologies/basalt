// @vitest-environment jsdom
//
// The phone app is the computer's, under a finger. Two things a finger could
// not do: drag the seek bar (the browser took the movement for a scroll, so
// only the first touch seeked), and take a film off Continue watching (its ×
// only ever appeared under a hovering pointer).

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItem, Watched } from '@/lib/api'

vi.mock('@/lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform')>()
  return { ...actual, isMobileShell: () => true }
})

import { Scrubber } from './PlayerOverlay'
import { ContinueWatching } from './ContinueWatching'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => cleanup())

describe('the seek bar under a finger', () => {
  beforeEach(() => {
    // A bar 200 px wide, from x = 0.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 4,
      right: 200,
      bottom: 4,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
  })

  function bar(): { slider: HTMLElement; scrubs: number[]; seeks: number[] } {
    const scrubs: number[] = []
    const seeks: number[] = []
    render(
      createElement(Scrubber, {
        percent: 10,
        duration: 600,
        onScrub: (f: number) => scrubs.push(f),
        onSeek: (f: number) => seeks.push(f),
        disabled: false,
      }),
    )
    return { slider: screen.getByRole('slider'), scrubs, seeks }
  }

  it('keeps sideways movement for itself', () => {
    const { slider } = bar()
    expect(slider.style.touchAction).toBe('none')
  })

  it('follows a drag, shows where it will land, and seeks once on letting go', () => {
    const { slider, scrubs, seeks } = bar()
    act(() => {
      fireEvent.pointerDown(slider, { clientX: 20, pointerId: 1, buttons: 1 })
      fireEvent.pointerMove(slider, { clientX: 60, pointerId: 1, buttons: 1 })
      fireEvent.pointerMove(slider, { clientX: 100, pointerId: 1, buttons: 1 })
    })
    expect(scrubs).toEqual([0.1, 0.3, 0.5])
    expect(seeks).toEqual([])
    // 0.5 of ten minutes, over the finger.
    expect(screen.getByText('5:00')).toBeTruthy()

    act(() => {
      fireEvent.pointerUp(slider, { clientX: 100, pointerId: 1 })
    })
    expect(seeks).toEqual([0.5])
    expect(screen.queryByText('5:00')).toBeNull()
  })

  it('does not seek on a pointer passing over it', () => {
    const { slider, scrubs, seeks } = bar()
    act(() => {
      fireEvent.pointerMove(slider, { clientX: 100, pointerId: 1, buttons: 0 })
    })
    expect(scrubs).toEqual([])
    expect(seeks).toEqual([])
  })

  it('lands where it was last held when the system takes the touch away', () => {
    const { slider, seeks } = bar()
    act(() => {
      fireEvent.pointerDown(slider, { clientX: 20, pointerId: 1, buttons: 1 })
      fireEvent.pointerMove(slider, { clientX: 140, pointerId: 1, buttons: 1 })
      fireEvent.pointerCancel(slider, { pointerId: 1 })
    })
    expect(seeks).toEqual([0.7])
  })
})

describe('Continue watching under a finger', () => {
  const film: LibraryItem = {
    id: 'f1',
    kind: 'film',
    title: 'The Last Sunrise',
    year: 2026,
    path: 'Movies/sunrise.mkv',
    size: 1,
    added: 1,
    seasons: [],
    confidence: 90,
    hasArt: false,
  }
  const watched: Watched = {
    path: 'Movies/sunrise.mkv',
    position: 600,
    duration: 6000,
    fraction: 0.1,
    updatedAt: 1,
  }

  function row(): { more: string[]; played: string[]; forgot: string[] } {
    const more: string[] = []
    const played: string[] = []
    const forgot: string[] = []
    render(
      createElement(ContinueWatching, {
        entries: [{ watched, item: film, episode: '', quality: null }],
        onPlay: (path: string) => played.push(path),
        onForget: (path: string) => forgot.push(path),
        onMore: (entry) => more.push(entry.item.title),
      }),
    )
    return { more, played, forgot }
  }

  it('offers a ⋮ in the card, not a × that only a hovering pointer finds', () => {
    const { more, forgot } = row()
    expect(screen.queryByLabelText(/Remove .* from Continue watching/)).toBeNull()
    fireEvent.click(screen.getByLabelText('More for The Last Sunrise'))
    expect(more).toEqual(['The Last Sunrise'])
    // Nothing is removed without asking.
    expect(forgot).toEqual([])
  })

  it('plays on a tap and offers the rest on a long press', () => {
    vi.useFakeTimers()
    try {
      const { more, played } = row()
      const card = screen.getByText('1h 30m left').closest('button')!
      act(() => {
        fireEvent.pointerDown(card, { clientX: 5, clientY: 5, button: 0 })
        fireEvent.pointerUp(card)
      })
      expect(played).toEqual(['Movies/sunrise.mkv'])

      act(() => {
        fireEvent.pointerDown(card, { clientX: 5, clientY: 5, button: 0 })
        vi.advanceTimersByTime(600)
        fireEvent.pointerUp(card)
      })
      expect(more).toEqual(['The Last Sunrise'])
      // A long press does not also play.
      expect(played).toEqual(['Movies/sunrise.mkv'])
    } finally {
      vi.useRealTimers()
    }
  })
})
