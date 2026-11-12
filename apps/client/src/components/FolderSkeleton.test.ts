// @vitest-environment jsdom
//
// A folder clicked on a slow line kept showing the last folder's files under
// the new breadcrumb. Rows with nothing in them show while it comes, but only
// once it has taken a moment: a quick folder must not flash them.

import { createElement } from 'react'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FolderSkeleton, useAfter } from './FolderSkeleton'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a folder on its way', () => {
  it('shows nothing for a folder that answers within the moment', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ on }) => useAfter(on, 150), { initialProps: { on: true } })
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(100))
    rerender({ on: false })
    act(() => vi.advanceTimersByTime(200))
    expect(result.current).toBe(false)
  })

  it('shows the rows once it takes longer, and drops them when it comes', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ on }) => useAfter(on, 150), { initialProps: { on: true } })
    act(() => vi.advanceTimersByTime(160))
    expect(result.current).toBe(true)
    rerender({ on: false })
    expect(result.current).toBe(false)
  })

  it('says it is loading, for a screen reader', () => {
    render(createElement(FolderSkeleton, { view: 'details' }))
    expect(screen.getByLabelText('Loading the folder').getAttribute('aria-busy')).toBe('true')
  })
})
