import { describe, expect, it } from 'vitest'
import { shouldAsk } from './review'

const DAY = 24 * 60 * 60 * 1000

describe('shouldAsk', () => {
  const first = 1_000_000_000_000

  it('asks after three films and a week', () => {
    expect(shouldAsk({ first, watched: 3, asked: false }, first + 7 * DAY)).toBe(true)
  })

  it('waits for the third film', () => {
    expect(shouldAsk({ first, watched: 2, asked: false }, first + 30 * DAY)).toBe(false)
  })

  it('waits for the week', () => {
    expect(shouldAsk({ first, watched: 10, asked: false }, first + 6 * DAY)).toBe(false)
  })

  it('never asks twice', () => {
    expect(shouldAsk({ first, watched: 10, asked: true }, first + 60 * DAY)).toBe(false)
  })
})
