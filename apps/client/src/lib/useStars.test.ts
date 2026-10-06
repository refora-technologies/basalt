import { describe, expect, it } from 'vitest'
import { applyStars, nextStars } from './useStars'

const entry = (id: string) => ({
  id,
  name: id.split('/').pop()!,
  kind: 'file' as const,
})

describe('nextStars', () => {
  it('stars something new', () => {
    const next = nextStars([], [entry('films/a.mkv')])
    expect(next.map((r) => r.path)).toEqual(['films/a.mkv'])
  })

  it('unstars something already starred', () => {
    const next = nextStars([{ path: 'films/a.mkv' }], [entry('films/a.mkv')])
    expect(next).toEqual([])
  })

  it('leaves everything else alone', () => {
    const next = nextStars(
      [{ path: 'films/a.mkv' }, { path: 'docs/b.txt' }],
      [entry('films/a.mkv')],
    )
    expect(next.map((r) => r.path)).toEqual(['docs/b.txt'])
  })

  // Toggling each item independently would leave a mixed selection
  // half-starred, which is never what anyone means by clicking one button.
  it('stars a mixed selection whole rather than inverting each item', () => {
    const next = nextStars(
      [{ path: 'a' }],
      [entry('a'), entry('b'), entry('c')],
    )
    expect(next.map((r) => r.path).sort()).toEqual(['a', 'b', 'c'])
  })

  it('unstars a fully starred selection whole', () => {
    const next = nextStars(
      [{ path: 'a' }, { path: 'b' }],
      [entry('a'), entry('b')],
    )
    expect(next).toEqual([])
  })

  it('does not add the same path twice', () => {
    const next = nextStars([{ path: 'a' }], [entry('a'), entry('b')])
    expect(next.filter((r) => r.path === 'a')).toHaveLength(1)
  })

  it('handles an empty selection without changing anything', () => {
    const current = [{ path: 'a' }]
    expect(nextStars(current, [])).toEqual(current)
  })
})

// Each device decides "star" or "unstar" from what it shows, then makes that
// change on the host's list as it is now. Writing its own whole list back
// instead undid stars another device had just added.
describe('applyStars', () => {
  it('keeps a star another device added meanwhile', () => {
    const onHost = [{ path: 'a' }, { path: 'from-the-phone' }]
    const next = applyStars(onHost, [entry('b')], true)
    expect(next.map((r) => r.path)).toEqual(['a', 'from-the-phone', 'b'])
  })

  it('removes only what was unstarred here', () => {
    const onHost = [{ path: 'a' }, { path: 'from-the-phone' }]
    const next = applyStars(onHost, [entry('a')], false)
    expect(next.map((r) => r.path)).toEqual(['from-the-phone'])
  })

  it('does not star twice what another device starred too', () => {
    const next = applyStars([{ path: 'b' }], [entry('b')], true)
    expect(next).toHaveLength(1)
  })
})
