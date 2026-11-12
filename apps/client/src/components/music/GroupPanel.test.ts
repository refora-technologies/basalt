// @vitest-environment jsdom
//
// The "In sync" chip used to stop syncing at once, with no say in what. It
// opens this panel now (mockup 15b): each device by name and how it is
// doing, stopping one there, leaving and playing on here, or stopping all.

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MusicPlayerApi } from '@/lib/musicPlayer'
import { GroupPanel } from './GroupPanel'

vi.mock('@/mobile/useBack', () => ({ useBack: () => {} }))

function playerWith(): MusicPlayerApi {
  return {
    paused: false,
    together: [
      { device: 'laptop', name: "Maya's work laptop", form: 'computer' },
      { device: 'tablet', name: 'Living room tablet', form: 'tablet' },
    ],
    others: [
      { device: 'laptop', name: "Maya's work laptop", form: 'computer', at: 0, report: { playing: true } },
      { device: 'tablet', name: 'Living room tablet', form: 'tablet', at: 0, report: { playing: false } },
    ],
    stopThere: vi.fn(),
    stopAll: vi.fn(),
    unlink: vi.fn(),
  } as unknown as MusicPlayerApi
}

afterEach(cleanup)

describe('the group panel', () => {
  it('names every device in the group and how each is doing', () => {
    render(createElement(GroupPanel, { player: playerWith(), title: 'Blue Hour', open: true, onClose: () => {} }))
    expect(screen.getByText('Playing in sync')).toBeTruthy()
    expect(screen.getByText('Blue Hour · 3 devices · the same second on all')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText("Maya's work laptop")).toBeTruthy()
    expect(screen.getByText('Living room tablet')).toBeTruthy()
    expect(screen.getAllByText('In step')).toHaveLength(2)
    expect(screen.getByText('Catching up…')).toBeTruthy()
  })

  it('stops one device there, and only that one', () => {
    const player = playerWith()
    render(createElement(GroupPanel, { player, title: 'Blue Hour', open: true, onClose: () => {} }))
    fireEvent.click(screen.getAllByText('Stop there')[1]!)
    expect(player.stopThere).toHaveBeenCalledWith('tablet')
    expect(player.stopAll).not.toHaveBeenCalled()
    expect(player.unlink).not.toHaveBeenCalled()
  })

  it('leaves, or stops them all, and closes', () => {
    const player = playerWith()
    const onClose = vi.fn()
    render(createElement(GroupPanel, { player, title: 'Blue Hour', open: true, onClose }))
    fireEvent.click(screen.getByText('Leave the group, keep playing here'))
    expect(player.unlink).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByText('Stop on all devices'))
    expect(player.stopAll).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
