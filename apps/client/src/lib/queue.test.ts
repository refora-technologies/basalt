import { describe, expect, it } from 'vitest'

import {
  addToQueue,
  current,
  cycleRepeat,
  fromListening,
  moveUpNext,
  next,
  playNext,
  previous,
  queueOf,
  removeUpNext,
  setShuffle,
  toListening,
  upNext,
} from './queue'

const ALBUM = ['1.flac', '2.flac', '3.flac', '4.flac']

/** A predictable "random": always the first choice. */
const first = (): number => 0

describe('playing through', () => {
  it('starts where asked and goes on in order', () => {
    let q = queueOf(ALBUM, 1, 'Lowlight')
    expect(current(q)).toBe('2.flac')
    expect(upNext(q)).toEqual(['3.flac', '4.flac'])
    q = next(q)!
    expect(current(q)).toBe('3.flac')
  })

  it('stops after the last song, or goes round with repeat on', () => {
    const last = queueOf(ALBUM, 3, 'x')
    expect(next(last)).toBeNull()
    expect(current(next({ ...last, repeat: 'all' })!)).toBe('1.flac')
  })

  it('plays one song again with repeat one, but Next still moves on', () => {
    const q = { ...queueOf(ALBUM, 1, 'x'), repeat: 'one' as const }
    expect(current(next(q, true)!)).toBe('2.flac')
    expect(current(next(q, false)!)).toBe('3.flac')
  })

  it('goes back to the start of the song after a few seconds, else to the one before', () => {
    const q = queueOf(ALBUM, 2, 'x')
    expect(previous(q, 10).restart).toBe(true)
    const back = previous(q, 1)
    expect(back.restart).toBe(false)
    expect(current(back.queue)).toBe('2.flac')
    // The first song has nothing before it, unless repeat is on.
    expect(previous(queueOf(ALBUM, 0, 'x'), 0).restart).toBe(true)
    expect(current(previous({ ...queueOf(ALBUM, 0, 'x'), repeat: 'all' }, 0).queue)).toBe('4.flac')
  })

  it('cycles repeat off, all, one', () => {
    const q = queueOf(ALBUM, 0, 'x')
    expect([cycleRepeat(q).repeat, cycleRepeat(cycleRepeat(q)).repeat]).toEqual(['all', 'one'])
    expect(cycleRepeat(cycleRepeat(cycleRepeat(q))).repeat).toBe('off')
  })
})

describe('shuffle', () => {
  it('starts with the song chosen and mixes the rest', () => {
    const q = queueOf(ALBUM, 2, 'x', true, first)
    expect(current(q)).toBe('3.flac')
    expect([...upNext(q)].sort()).toEqual(['1.flac', '2.flac', '4.flac'])
  })

  it('turned on and off, carries on from the song playing now', () => {
    let q = queueOf(ALBUM, 1, 'x')
    q = setShuffle(q, true, first)
    expect(current(q)).toBe('2.flac')
    expect(upNext(q)).toHaveLength(2)
    q = setShuffle(next(q)!, false)
    // Back in album order, from wherever shuffle had got to.
    const playing = current(q)!
    expect(upNext(q)).toEqual(ALBUM.slice(ALBUM.indexOf(playing) + 1))
  })
})

describe('changing what is queued', () => {
  it('plays songs next, or after everything else', () => {
    let q = queueOf(ALBUM, 0, 'x')
    q = playNext(q, ['a.mp3'])
    q = addToQueue(q, ['z.mp3'])
    expect(upNext(q)).toEqual(['a.mp3', '2.flac', '3.flac', '4.flac', 'z.mp3'])
  })

  it('removes and moves songs still to come', () => {
    let q = queueOf(ALBUM, 0, 'x')
    q = removeUpNext(q, 1)
    expect(upNext(q)).toEqual(['2.flac', '4.flac'])
    q = moveUpNext(q, 1, 0)
    expect(upNext(q)).toEqual(['4.flac', '2.flac'])
    expect(current(q)).toBe('1.flac')
    // Out of range changes nothing.
    expect(removeUpNext(q, 9)).toBe(q)
  })
})

describe('carrying on from another device', () => {
  it('saves the songs in playing order and comes back the same', () => {
    const q = next(setShuffle(queueOf(ALBUM, 0, 'Lowlight'), true, first))!
    const saved = toListening(q, 42.5, 1000)
    expect(saved.queue[saved.index]).toBe(current(q))
    const { queue, position } = fromListening(saved)
    expect(current(queue)).toBe(current(q))
    expect(upNext(queue)).toEqual(upNext(q))
    expect([position, queue.shuffle, queue.from]).toEqual([42.5, true, 'Lowlight'])
  })
})
