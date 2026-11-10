import { beforeEach, describe, expect, it, vi } from 'vitest'

// The desktop plugin, as the test drives it: its mpv can go away.
const plugin = vi.hoisted(() => ({
  alive: false,
  inits: 0,
  destroys: 0,
}))

vi.mock('./platform', () => ({ isAndroid: () => false, isLinuxDesktop: () => false }))
vi.mock('./api', () => ({ api: {} }))
vi.mock('tauri-plugin-libmpv-api', () => {
  const gone = (): never => {
    throw new Error("mpv instance not found: mpv instance for window label 'main' not found")
  }
  return {
    init: async () => {
      plugin.inits += 1
      plugin.alive = true
    },
    destroy: async () => {
      plugin.destroys += 1
      plugin.alive = false
    },
    command: async () => (plugin.alive ? undefined : gone()),
    setProperty: async () => (plugin.alive ? undefined : gone()),
    getProperty: async () => (plugin.alive ? 42 : gone()),
    observeProperties: async () => () => {},
  }
})

import * as mpv from './mpvBackend'

describe('the desktop player when its mpv goes away', () => {
  beforeEach(() => {
    plugin.alive = false
    plugin.inits = 0
    plugin.destroys = 0
  })

  it('is set up again with the same options, and the request goes through', async () => {
    await mpv.init({ initialOptions: { vo: 'gpu-next' }, observedProperties: [] })
    plugin.alive = false
    const restarted = vi.fn()
    const stop = mpv.whenRestarted(restarted)
    await expect(mpv.command('loadfile', ['film.mkv'])).resolves.toBeUndefined()
    expect(plugin.inits).toBe(2)
    expect(restarted).toHaveBeenCalledOnce()
    await expect(mpv.getProperty('volume', 'double')).resolves.toBe(42)
    stop()
  })

  it('sets it up once for several requests failing together', async () => {
    await mpv.init({ initialOptions: {}, observedProperties: [] })
    plugin.alive = false
    await Promise.all([mpv.setProperty('pause', true), mpv.command('seek', [10]), mpv.getProperty('volume', 'double')])
    expect(plugin.inits).toBe(2)
  })

  it('leaves other failures alone, and a player put away stays away', async () => {
    expect(mpv.playerGone(new Error('property unavailable'))).toBe(false)
    await mpv.init({ initialOptions: {}, observedProperties: [] })
    await mpv.destroy()
    await expect(mpv.command('loadfile', ['film.mkv'])).rejects.toThrow(/not found/)
    expect(plugin.inits).toBe(1)
  })
})
