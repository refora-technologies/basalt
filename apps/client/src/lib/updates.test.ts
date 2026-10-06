import { describe, expect, it } from 'vitest'
import { versionFromCode } from './updates'

describe('versionFromCode', () => {
  it('reads Play version codes as the versions people see', () => {
    expect(versionFromCode(1004000)).toBe('1.4.0')
    expect(versionFromCode(1004005)).toBe('1.4.5')
    expect(versionFromCode(1012030)).toBe('1.12.30')
    expect(versionFromCode(2000001)).toBe('2.0.1')
  })
})
