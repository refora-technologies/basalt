import { describe, expect, it } from 'vitest'
import { ApiError, type Status } from './api'
import { filesEmptyLabel } from './useVault'

const status: Status = {
  connected: false,
  connecting: true,
  hostId: 'host-a',
  hostName: 'LIVING-ROOM-PC',
  vault: 'Media',
  writable: false,
  address: null,
  hasPaired: true,
  deviceName: 'Phone',
} as Status

describe('filesEmptyLabel', () => {
  it('never calls a folder empty before the phone has reached its host', () => {
    for (const error of [null, new ApiError('offline', 'no answer')]) {
      const label = filesEmptyLabel({ connected: false, status, error, query: '' })
      expect(label).not.toContain('empty')
    }
    expect(filesEmptyLabel({ connected: false, status, error: null, query: '' })).toBe(
      'Connecting to the host…',
    )
    expect(
      filesEmptyLabel({
        connected: false,
        status,
        error: new ApiError('offline', 'no answer'),
        query: '',
      }),
    ).toBe('Not connected to the host')
  })

  it('says it is waiting for a paired drive that is not answering', () => {
    const waiting = { ...status, connecting: false }
    expect(filesEmptyLabel({ connected: false, status: waiting, error: null, query: '' })).toBe(
      'Waiting for Media. It opens here by itself as soon as LIVING-ROOM-PC is sharing again.',
    )
  })

  it('calls a folder empty only once it has been listed', () => {
    const online = { ...status, connected: true, connecting: false }
    expect(filesEmptyLabel({ connected: true, status: online, error: null, query: '' })).toBe(
      'This folder is empty',
    )
    expect(filesEmptyLabel({ connected: true, status: online, error: null, query: 'zz' })).toBe(
      'Nothing matches “zz”',
    )
  })
})
