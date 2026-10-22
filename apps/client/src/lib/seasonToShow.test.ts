import { describe, expect, it } from 'vitest'
import type { LibrarySeason, Watched } from './api'
import { seasonToShow } from './seasonToShow'

const season = (number: number, count: number): LibrarySeason => ({
  number,
  episodes: Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    path: `Show/Season ${number}/E${i + 1}.mkv`,
    size: 1,
    added: 0,
  })),
})

const series = { seasons: [season(1, 3), season(2, 3), season(3, 3)] }

const seen = (entries: Array<[string, number, number]>): Map<string, Watched> =>
  new Map(
    entries.map(([path, fraction, updatedAt]) => [path, { path, fraction, position: 0, duration: 0, updatedAt }]),
  )

describe('seasonToShow', () => {
  it('opens on the first season when nothing is watched', () => {
    expect(seasonToShow(series, new Map())?.number).toBe(1)
  })

  it('opens on the season of the episode in progress', () => {
    const watched = seen([
      ['Show/Season 1/E3.mkv', 1, 10],
      ['Show/Season 2/E2.mkv', 0.4, 20],
    ])
    expect(seasonToShow(series, watched)?.number).toBe(2)
  })

  it('goes by the most recent, not the furthest', () => {
    const watched = seen([
      ['Show/Season 3/E1.mkv', 0.5, 10],
      ['Show/Season 2/E1.mkv', 0.3, 30],
    ])
    expect(seasonToShow(series, watched)?.number).toBe(2)
  })

  it("opens on the next season after a season's last episode is finished", () => {
    expect(seasonToShow(series, seen([['Show/Season 2/E3.mkv', 1, 10]]))?.number).toBe(3)
  })

  it('stays on the last season when the last episode of all is finished', () => {
    expect(seasonToShow(series, seen([['Show/Season 3/E3.mkv', 1, 10]]))?.number).toBe(3)
  })
})
