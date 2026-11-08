// @vitest-environment jsdom
//
// On a TV, a song started with OK keeps the focus on that song: the page
// drawn again around it (the music bar coming in) once sent the remote back
// to the page's Play button.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startRemote } from './remote'

const page = (): string => `
  <main>
    <button data-remote-first="">Play</button>
    <button data-remote-key="song:a.mp3">One</button>
    <button data-remote-key="song:b.mp3">Two</button>
  </main>`

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom lays nothing out: every button is given a size, so it counts as seen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 40,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect)
  HTMLElement.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the remote', () => {
  it('finds the same song again when the page is drawn anew', () => {
    startRemote()
    document.body.innerHTML = page()
    document.querySelector<HTMLElement>('[data-remote-key="song:b.mp3"]')!.focus()
    // Drawn again: the button that had the focus is gone, an equal one in its place.
    document.body.innerHTML = page()
    vi.advanceTimersByTime(400)
    expect(document.activeElement?.textContent).toBe('Two')
  })
})
