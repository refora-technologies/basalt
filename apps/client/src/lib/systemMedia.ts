/**
 * The music playing, as the system shows it outside the app: Android's lock
 * screen, notification player and Now Bar (a media session, in the Basalt
 * plugin), Windows' media controls, a Linux desktop's (MPRIS, in the app's
 * Rust side). Their buttons come back through `onSystemMedia`.
 *
 * Nothing at all in the browser preview.
 */
import { inTauri } from './api'
import { isAndroid } from './platform'

/** What is playing. Seconds for the times; `cover` is an address the system can fetch. */
export interface NowPlayingInfo {
  title: string
  artist: string
  album: string
  cover: string | null
  duration: number
  position: number
  playing: boolean
  canPrevious: boolean
  canNext: boolean
}

/** A button pressed in the system's controls. `position` is for `seek`. */
export interface SystemPress {
  action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' | 'seek'
  position: number
}

export async function showNowPlaying(now: NowPlayingInfo): Promise<void> {
  if (!inTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  if (isAndroid()) await invoke('plugin:basalt-android|media_session', { ...now })
  else await invoke('media_controls_show', { now })
}

export async function clearNowPlaying(): Promise<void> {
  if (!inTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  if (isAndroid()) await invoke('plugin:basalt-android|media_session_end')
  else await invoke('media_controls_clear')
}

/** Calls `handle` for each button pressed; returns how to stop listening. */
export async function onSystemMedia(handle: (press: SystemPress) => void): Promise<() => void> {
  if (!inTauri()) return () => {}
  if (isAndroid()) {
    const { addPluginListener } = await import('@tauri-apps/api/core')
    const listener = await addPluginListener<SystemPress>('basalt-android', 'media', handle)
    return () => void listener.unregister()
  }
  const { listen } = await import('@tauri-apps/api/event')
  return listen<SystemPress>('basalt://media-control', (e) => handle(e.payload))
}

/** The kinds of press, for telling one press arriving twice from two. */
type Kind = 'playpause' | 'next' | 'previous' | 'stop' | 'seek'

const KIND: Record<SystemPress['action'], Kind> = {
  play: 'playpause',
  pause: 'playpause',
  toggle: 'playpause',
  next: 'next',
  previous: 'previous',
  stop: 'stop',
  seek: 'seek',
}

const claimed = new Map<Kind, number>()

/**
 * Whether a press should be acted on. A media key can arrive twice: once as
 * a key in the page and once through the system's controls, which listen to
 * the same keys. The second within a moment is the same press.
 */
export function claimPress(action: SystemPress['action'], now = Date.now()): boolean {
  const kind = KIND[action]
  const last = claimed.get(kind)
  claimed.set(kind, now)
  return last === undefined || now - last > 400
}

/** The key a media key is, as a press; null for any other key. */
export function pressForKey(key: string): SystemPress['action'] | null {
  switch (key) {
    case 'MediaPlayPause':
      return 'toggle'
    case 'MediaPlay':
      return 'play'
    case 'MediaPause':
      return 'pause'
    case 'MediaTrackNext':
      return 'next'
    case 'MediaTrackPrevious':
      return 'previous'
    case 'MediaStop':
      return 'stop'
    default:
      return null
  }
}

/**
 * Whether the system's picture of the song needs telling again: the song,
 * playing or paused, or its length changed, or the position moved other than
 * by playing (a seek). The system moves its own bar on while playing.
 */
export function needsTelling(
  shown: { info: NowPlayingInfo; at: number } | null,
  next: NowPlayingInfo,
  now: number,
): boolean {
  if (!shown) return true
  const was = shown.info
  if (
    was.title !== next.title ||
    was.artist !== next.artist ||
    was.album !== next.album ||
    was.cover !== next.cover ||
    was.playing !== next.playing ||
    was.canNext !== next.canNext ||
    was.canPrevious !== next.canPrevious ||
    Math.abs(was.duration - next.duration) > 1
  ) {
    return true
  }
  const expected = was.position + (was.playing ? (now - shown.at) / 1000 : 0)
  return Math.abs(expected - next.position) > 2
}
