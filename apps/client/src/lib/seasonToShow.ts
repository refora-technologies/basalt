import { isFinished, type LibraryItem, type LibrarySeason, type Watched } from './api'

/**
 * The season a series opens on: where the person is up to, not the first.
 *
 * The episode watched most recently decides. Part-watched, its season; seen
 * to the end, the season of the episode after it, so finishing a season's
 * last episode opens the next season. Nothing watched yet, the first season.
 */
export function seasonToShow(
  item: Pick<LibraryItem, 'seasons'>,
  watched: Map<string, Watched>,
): LibrarySeason | undefined {
  const order = item.seasons.flatMap((season) => season.episodes.map((episode) => ({ season, episode })))
  let latest = -1
  let at = -Infinity
  order.forEach(({ episode }, index) => {
    const entry = watched.get(episode.path)
    if (entry && entry.updatedAt > at) {
      at = entry.updatedAt
      latest = index
    }
  })
  const last = order[latest]
  const entry = last && watched.get(last.episode.path)
  if (!last || !entry) return item.seasons[0]
  const next = isFinished(entry) ? order[latest + 1] : undefined
  return (next ?? last).season
}
