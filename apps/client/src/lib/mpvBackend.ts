import * as desktop from 'tauri-plugin-libmpv-api'
import type { MpvConfig, MpvObservableProperty } from 'tauri-plugin-libmpv-api'
import { api } from './api'
import { isAndroid, isLinuxDesktop } from './platform'

export type { MpvObservableProperty } from 'tauri-plugin-libmpv-api'

/**
 * mpv, wherever it lives.
 *
 * On the desktop it is the libmpv plugin, drawing into the window. On Android
 * it is the app's own plugin, drawing on a surface beneath the page. Both take
 * the same requests and send the same property changes, so the player above
 * this is one piece of code for both.
 *
 * On Linux it is the app's own, drawn into a GL area under the page (see
 * `linux_player.rs`): the plugin's way, handing mpv the window, puts mpv's
 * picture over the page there, and does not work on Wayland at all.
 *
 * Only the functions the player uses are here, with the desktop plugin's
 * names and shapes.
 */

interface PropertyChange {
  event: 'property-change'
  name: string
  data: unknown
}

const PLUGIN = 'plugin:basalt-android|'

/** mpv wants words, and every value crosses to Kotlin as one. */
function asText(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(PLUGIN + command, args)
}

const LINUX = isLinuxDesktop()

/**
 * The desktop player, set up again if it has gone (1.6.4).
 *
 * It is set up once for the window's life. If its mpv goes away underneath
 * (another program took the graphics card, a driver reset), every request
 * after fails with "mpv instance … not found", and only restarting Basalt
 * helped. Now such a failure sets it up again with the same options, tells
 * whoever asked (the player puts its subtitle style back), and tries the
 * request once more. Listeners carry on: they listen to the window.
 */
let lastConfig: MpvConfig | null = null
let restarting: Promise<void> | null = null
const onRestart = new Set<() => void>()

/** Called after the desktop player was set up again; returns a way to stop. */
export function whenRestarted(callback: () => void): () => void {
  onRestart.add(callback)
  return () => onRestart.delete(callback)
}

/** Whether a failure says the player itself is gone, not that a request was bad. */
export function playerGone(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /instance.*not found|not initiali[sz]ed|no mpv instance/i.test(text)
}

async function healing<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request()
  } catch (e) {
    if (!lastConfig || !playerGone(e)) throw e
    if (!restarting) {
      const config = lastConfig
      restarting = (async () => {
        await desktop.destroy().catch(() => {})
        await desktop.init(config)
        for (const callback of onRestart) callback()
      })().finally(() => {
        restarting = null
      })
    }
    await restarting
    return request()
  }
}

export async function init(config: MpvConfig): Promise<void> {
  if (LINUX) {
    const options: Record<string, string> = {}
    for (const [name, value] of Object.entries(config.initialOptions ?? {})) {
      if (value !== undefined && value !== null) options[name] = asText(value)
    }
    await api.linuxMpvInit(options, config.observedProperties ?? [])
    return
  }
  if (!isAndroid()) {
    lastConfig = config
    await desktop.init(config)
    return
  }
  const options: Record<string, string> = {}
  for (const [name, value] of Object.entries(config.initialOptions ?? {})) {
    if (value !== undefined && value !== null) options[name] = asText(value)
  }
  const observed: Record<string, string> = {}
  for (const [name, format] of config.observedProperties ?? []) observed[name] = format
  await invoke('mpv_init', { options, observed })
}

export async function observeProperties<T extends ReadonlyArray<MpvObservableProperty>>(
  properties: T,
  callback: (event: PropertyChange) => void,
): Promise<() => void> {
  if (LINUX) {
    const names = new Set<string>(properties.map((p) => p[0]))
    const { listen } = await import('@tauri-apps/api/event')
    return listen<PropertyChange>('basalt-mpv', ({ payload }) => {
      if (payload.event === 'property-change' && names.has(payload.name)) callback(payload)
    })
  }
  if (!isAndroid()) {
    return desktop.observeProperties(properties, (event) =>
      callback(event as unknown as PropertyChange),
    )
  }
  const names = new Set<string>(properties.map((p) => p[0]))
  const { addPluginListener } = await import('@tauri-apps/api/core')
  const listener = await addPluginListener<PropertyChange>('basalt-android', 'mpv', (event) => {
    if (event.event === 'property-change' && names.has(event.name)) callback(event)
  })
  return () => void listener.unregister()
}

export async function command(
  name: string,
  args: Array<string | number | boolean> = [],
): Promise<void> {
  if (LINUX) return api.linuxMpvCommand([name, ...args.map(asText)])
  if (!isAndroid()) return healing(() => desktop.command(name, args))
  // Where the sound goes is Android's business, not the player's.
  if (name === 'set' && args[0] === 'audio-device') return
  // A file from the phone's picker is an address mpv cannot open itself.
  if (name === 'sub-add' && String(args[0]).startsWith('content://')) {
    await invoke('mpv_add_subtitle', { uri: String(args[0]), flag: asText(args[1] ?? 'select') })
    return
  }
  await invoke('mpv_command', { args: [name, ...args.map(asText)] })
}

export async function setProperty(name: string, value: string | number | boolean): Promise<void> {
  if (LINUX) return api.linuxMpvSetProperty(name, asText(value))
  if (!isAndroid()) return healing(() => desktop.setProperty(name, value))
  await invoke('mpv_set_property', { name, value: asText(value) })
}

export async function getProperty(
  name: string,
  format: 'string' | 'flag' | 'int64' | 'double',
): Promise<unknown> {
  if (!isAndroid() && !LINUX) return healing(() => desktop.getProperty(name, format))
  const reply = LINUX
    ? await api.linuxMpvGetProperty(name, format)
    : await invoke<{ value?: unknown }>('mpv_get_property', { name, format })
  return reply.value ?? null
}

export async function destroy(): Promise<void> {
  if (LINUX) return api.linuxMpvDestroy()
  if (!isAndroid()) {
    lastConfig = null
    return desktop.destroy()
  }
  await invoke('mpv_destroy', {})
}

/**
 * On a phone, links in the font for a script subtitles are written in, and
 * says its family and whether mpv's font folder changed. Nothing elsewhere:
 * a computer finds fonts for any script by itself.
 */
export async function subtitleFont(script: string): Promise<{ family: string | null; changed: boolean }> {
  if (!isAndroid()) return { family: null, changed: false }
  const reply = await invoke<{ family?: string; changed?: boolean }>('mpv_subtitle_font', { script })
  return { family: reply.family ?? null, changed: Boolean(reply.changed) }
}
