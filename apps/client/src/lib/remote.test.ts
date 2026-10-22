import { describe, expect, it } from 'vitest'
import { distance, nearest, seenFrom } from './remote'

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

describe('distance', () => {
  const here = box(100, 100, 50, 50)

  it('counts nothing that is not that way', () => {
    expect(distance(here, box(0, 100, 50, 50), 'right')).toBeNull()
    expect(distance(here, box(200, 100, 50, 50), 'left')).toBeNull()
    expect(distance(here, box(100, 0, 50, 50), 'down')).toBeNull()
    expect(distance(here, box(100, 200, 50, 50), 'up')).toBeNull()
  })

  it('measures the gap along the way', () => {
    expect(distance(here, box(170, 100, 50, 50), 'right')).toBe(20)
    expect(distance(here, box(100, 180, 50, 50), 'down')).toBe(30)
  })

  // Rows of slightly different heights overlap by a pixel or two.
  it('allows a little overlap', () => {
    expect(distance(here, box(149, 100, 50, 50), 'right')).toBe(0)
  })
})

describe('nearest', () => {
  const here = box(0, 0, 100, 40)

  it('takes the thing straight ahead over a nearer one off the line', () => {
    const ahead = { item: 'ahead', box: box(0, 140, 100, 40) }
    const aside = { item: 'aside', box: box(300, 60, 100, 40) }
    expect(nearest(here, [aside, ahead], 'down')).toBe('ahead')
  })

  // The bug this guards: past the last button of the player's row, right
  // jumped to the close button in the far corner.
  it('keeps left and right in the row', () => {
    const corner = { item: 'close', box: box(900, -400, 40, 40) }
    expect(nearest(here, [corner], 'right')).toBeNull()
  })

  it('reaches the side rail from any row', () => {
    const rail = { item: 'rail', box: box(-90, -300, 60, 40), anywhere: true }
    expect(nearest(here, [rail], 'left')).toBe('rail')
  })

  it('finds nothing when nothing is that way', () => {
    expect(nearest(here, [{ item: 'above', box: box(0, -100, 100, 40) }], 'down')).toBeNull()
  })
})

describe('seenFrom', () => {
  // Stand-ins for the page's elements: a box, and what is inside what.
  const element = (b: ReturnType<typeof box>, inside: object[] = []) => {
    const el = {
      getBoundingClientRect: () => b,
      contains: (other: object) => other === el || inside.includes(other),
    }
    return el as unknown as Element
  }
  const menu = element(box(900, 110, 40, 40))
  const row = element(box(0, 100, 960, 60), [menu])

  // The bug this guards: a row's ⋮ lies inside the row, so going right from
  // the row it was never "to the right" and the remote could not reach it.
  it('puts a button inside a row to the right of the row', () => {
    const from = row.getBoundingClientRect()
    const seen = seenFrom(menu, row, from, 'right')
    expect(distance(from, seen, 'right')).not.toBeNull()
  })

  it('puts the row just to the left of a button inside it', () => {
    const from = menu.getBoundingClientRect()
    expect(distance(from, seenFrom(row, menu, from, 'left'), 'left')).toBe(0)
  })

  it('leaves everything else where it is', () => {
    const other = element(box(0, 200, 960, 60))
    const from = row.getBoundingClientRect()
    expect(seenFrom(other, row, from, 'down')).toEqual(box(0, 200, 960, 60))
  })
})
