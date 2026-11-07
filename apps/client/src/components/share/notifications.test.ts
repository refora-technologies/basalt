// @vitest-environment jsdom
//
// The computer's share notifications are told once: a share already in the
// Inbox when the page loads (after a reload, or from another day) is never
// told again, which once had one picture announced twenty times.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ShareItem } from '@/lib/share'
import type { Inbox } from '@/lib/useInbox'
import type { Presence } from '@/lib/usePresence'

const told = vi.hoisted(() => [] as string[])

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      notify: async (_tag: string, title: string) => {
        told.push(title)
      },
    },
    onNotification: async () => () => {},
    onOpenPage: async () => () => {},
  }
})

const { useShareNotifications } = await import('./notifications')

const presence: Presence = { devices: [], you: 'pc', supported: true }

function item(id: string, state: ShareItem['state'], at: number): ShareItem {
  return {
    id,
    direction: 'in',
    files: [{ name: `${id}.jpg`, size: 1, path: '' }],
    peer: { device: 'phone', name: 'Pixel' },
    state,
    at,
  }
}

function inbox(items: ShareItem[]): Inbox {
  return { items, waiting: [] } as unknown as Inbox
}

afterEach(() => {
  cleanup()
  told.length = 0
})

describe('share notifications', () => {
  it('tell what arrives while the page runs, once, and never what was there before', () => {
    const old = item('old', 'done', Date.now() - 60_000)
    const view = renderHook(({ items }) => useShareNotifications(inbox(items), presence, () => {}), {
      initialProps: { items: [old] },
    })
    expect(told).toEqual([])

    const fresh = item('new', 'moving', Date.now() + 1)
    view.rerender({ items: [fresh, old] })
    view.rerender({ items: [{ ...fresh, state: 'done' }, old] })
    view.rerender({ items: [{ ...fresh, state: 'done' }, old] })
    expect(told).toEqual(['new.jpg arrived'])
  })
})
