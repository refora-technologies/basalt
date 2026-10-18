import { describe, expect, it } from 'vitest'
import { wrongHostText } from './wrongHost'

describe('wrongHostText', () => {
  it('names the host this device paired with, not its id', () => {
    const text = wrongHostText('LIVING-ROOM-PC')
    expect(text).toContain('This isn’t LIVING-ROOM-PC.')
    expect(text).toContain('Another Basalt host is answering at its address')
    expect(text).toContain('If you reset LIVING-ROOM-PC, pair it again.')
    expect(text).not.toMatch(/[0-9a-f]{8}/)
  })

  it('says it keeps looking only where it does', () => {
    expect(wrongHostText('Den')).toContain('Basalt keeps looking for Den.')
    const once = wrongHostText('Den', { retrying: false })
    expect(once).not.toContain('keeps looking')
    expect(once).toBe(
      'This isn’t Den. Another Basalt host is answering at its address. If you reset Den, pair it again.',
    )
  })

  it('still reads when the name is not known', () => {
    for (const name of [undefined, null, '', '  ']) {
      expect(wrongHostText(name)).toContain('This isn’t your host.')
    }
  })
})
