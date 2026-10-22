// @vitest-environment jsdom
//
// A series opens on where the person is up to: Continue plays the right
// episode, the season heading opens a list of every season, and an episode
// seen to the end says so on its picture.

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LibraryItem, Watched } from '@/lib/api'

vi.mock('./Poster', () => ({ Poster: () => null }))

import { SeriesPage, nextUp } from './SeriesPage'

const episode = (season: number, number: number) => ({
  number,
  path: `Shows/Signal House/Season 0${season}/Signal.House.S0${season}E0${number}.mkv`,
  title: `Episode ${season}.${number}`,
  size: 1,
  added: 0,
})

const series: LibraryItem = {
  id: 's1',
  kind: 'series',
  title: 'Signal House',
  size: 1,
  added: 0,
  confidence: 99,
  hasArt: false,
  seasons: [
    { number: 1, episodes: [episode(1, 1), episode(1, 2)] },
    { number: 2, episodes: [episode(2, 1), episode(2, 2), episode(2, 3)] },
  ],
}

function watched(...entries: Array<[string, number]>): Map<string, Watched> {
  return new Map(
    entries.map(([path, fraction], i) => [path, { path, fraction, position: 0, duration: 0, updatedAt: 100 + i }]),
  )
}

const path = (season: number, number: number): string => episode(season, number).path

describe('what Continue plays', () => {
  it('starts at the first episode of a series not begun', () => {
    expect(nextUp(series, new Map())).toMatchObject({ kind: 'start', season: 1, episode: { number: 1 } })
  })

  it('resumes the episode watched last, part way through', () => {
    const next = nextUp(series, watched([path(1, 1), 1], [path(1, 2), 0.4]))
    expect(next).toMatchObject({ kind: 'resume', season: 1, episode: { number: 2 }, fraction: 0.4 })
  })

  it('goes on to the next season after the last episode of one', () => {
    const next = nextUp(series, watched([path(1, 1), 1], [path(1, 2), 1]))
    expect(next).toMatchObject({ kind: 'next', season: 2, episode: { number: 1 } })
  })

  it('offers it again from the start once the last episode is seen', () => {
    expect(nextUp(series, watched([path(2, 3), 1]))).toMatchObject({ kind: 'again', season: 1 })
  })
})

describe('the series page', () => {
  beforeAll(() => {
    // jsdom has no media queries: a phone held upright.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia
  })
  afterEach(cleanup)

  const open = (w: Map<string, Watched>): void => {
    render(createElement(SeriesPage, { item: series, watched: w, mediaBase: '', onClose: () => {}, onPlay: () => {} }))
  }

  it('opens on the season being watched, and lists every season from its heading', () => {
    open(watched([path(1, 1), 1], [path(1, 2), 1], [path(2, 1), 0.5]))
    const heading = screen.getByRole('button', { name: /Season 2/ })
    expect(heading.textContent).toContain('3 episodes')
    fireEvent.click(heading)
    const list = screen.getByRole('listbox')
    const options = within(list).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Season 1'),
      expect.stringContaining('Season 2'),
    ])
    expect(options[0]!.textContent).toContain('Watched')
    fireEvent.click(options[0]!)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByText('Episode 1.2')).toBeTruthy()
  })

  it('marks an episode seen to the end on its picture', () => {
    open(watched([path(1, 1), 1], [path(1, 2), 0.3]))
    expect(screen.getAllByText('Watched')).toHaveLength(1)
    expect(screen.getByText('30% watched')).toBeTruthy()
  })
})
