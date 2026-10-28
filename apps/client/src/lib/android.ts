/**
 * What the app asks of Android itself, through the Basalt plugin.
 *
 * Only in the Android app; everything here does nothing — and returns
 * nothing — anywhere else, including the browser preview, so screens can
 * call it without checking where they are.
 */
import { inTauri } from './api'
import { isAndroid, isTv } from './platform'

/** A file on the phone, as Android describes one it has handed over. */
export interface PhoneFile {
  uri: string
  name: string
  /** Bytes; negative when the phone could not say. */
  size: number
  /** Unix seconds, or 0. */
  mtime: number
  mime?: string
  /** Where it sits inside a picked folder: `Sub/name`. */
  rel?: string
}

/**
 * Whether Android lets the app reach the home network: `ask` when Android
 * will show its question, `denied` when only Settings can change it.
 */
export type LocalNetworkState = 'granted' | 'ask' | 'denied'

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
  keyboard: number
}

async function plugin<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inTauri() || !isAndroid()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(`plugin:basalt-android|${command}`, args ?? {})
}

export const android = {
  /** Photos and videos, or any files, from the phone's own picker. */
  pickFiles: async (kind: 'any' | 'media' | 'image' | 'video' | 'audio' | 'subtitle' = 'any') =>
    (await plugin<{ files: PhoneFile[] }>('pick_files', { kind, multiple: kind !== 'subtitle' }))
      ?.files ?? [],

  /** A folder, to upload with everything in it. */
  pickFolder: async () => {
    const picked = await plugin<{ uri?: string; name?: string }>('pick_folder')
    return picked?.uri ? { uri: picked.uri, name: picked.name ?? 'Folder' } : null
  },

  /** Every file and folder inside a picked folder, relative to it. */
  listFolder: async (uri: string) =>
    (await plugin<{ files: PhoneFile[]; folders: string[] }>('list_folder', { uri })) ?? {
      files: [],
      folders: [],
    },

  /** Files shared into Basalt from another app, once each. */
  takeShared: async () => (await plugin<{ files: PhoneFile[] }>('take_shared'))?.files ?? [],

  /** A stream, handed to another player: VLC, MX Player. */
  openWith: (url: string, mime: string, title: string) =>
    plugin<void>('open_with', { url, mime, title }),

  openDownload: (uri: string) => plugin<void>('open_download', { uri }),
  shareDownload: (uri: string) => plugin<void>('share_download', { uri }),

  /**
   * Keeps the app running with the screen off, with a notification: a
   * transfer, a film handed to another player (`playback`), or music, whose
   * notification is the media player (see `systemMedia`).
   */
  keepAlive: (reason: 'transfer' | 'playback' | 'music', title: string, text: string, progress = -1) =>
    plugin<void>('keep_alive', { reason, title, text, progress }),
  letGo: (reason: 'transfer' | 'playback' | 'music') => plugin<void>('let_go', { reason }),
  requestNotifications: () => plugin<{ granted: boolean }>('request_notifications'),

  setImmersive: (on: boolean) => plugin<void>('set_immersive', { on }),
  /**
   * Android 17's permission for the home network, without which Basalt can
   * reach nothing. `granted` wherever Android does not ask.
   */
  localNetwork: async (): Promise<LocalNetworkState> =>
    (await plugin<{ state: LocalNetworkState }>('local_network'))?.state ?? 'granted',
  /** Android's question; what it says now. */
  requestLocalNetwork: async (): Promise<LocalNetworkState> =>
    (await plugin<{ state: LocalNetworkState }>('request_local_network'))?.state ?? 'granted',
  /** Basalt's page in Android's settings. */
  openAppSettings: () => plugin<void>('open_app_settings'),
  /**
   * Whether a film is playing, and its picture's size: playing, leaving the
   * app puts it in a small window over other apps.
   */
  setPip: (playing: boolean, width = 0, height = 0) =>
    plugin<void>('set_pip', { playing, width, height }),
  setOrientation: (mode: 'landscape' | 'portrait' | 'auto') =>
    plugin<void>('set_orientation', { mode }),
  /** Back at the top of the app: to the home screen, as every app does. */
  minimize: () => plugin<void>('minimize'),
  haptic: (kind: 'tap' | 'long' | 'confirm' = 'tap') => plugin<void>('haptic', { kind }),
  /** Brightness and media volume, each 0 to 1, for the player's swipes. */
  playerLevels: () => plugin<{ brightness: number; volume: number; volumeSteps: number }>('player_levels'),
  /** This window's brightness, 0 to 1; below 0 gives it back to the system. */
  setBrightness: (level: number) => plugin<void>('set_brightness', { level }),
  /** The phone's media volume, 0 to 1. Answers with where it landed. */
  setVolume: (level: number) => plugin<{ volume: number }>('set_volume', { level }),
  insets: () => plugin<Insets>('insets'),

  /** "Basalt <version> is available", as a phone notification. Whether it showed. */
  notifyUpdate: async (version: string) =>
    (await plugin<{ shown: boolean }>('notify_update', { version }))?.shown ?? false,
  /** What a notification tap asked the app to open, once. */
  takeAction: async () => (await plugin<{ action: string | null }>('take_action'))?.action ?? null,
  canInstallApks: async () => (await plugin<{ can: boolean }>('can_install_apks'))?.can ?? false,
  openInstallSettings: () => plugin<void>('open_install_settings'),
  installApk: (path: string) => plugin<void>('install_apk', { path }),

  /** The version Android installed: the name people see and Play's number. */
  appVersion: () =>
    plugin<{ name: string; code: number; device: string; android: string; tv?: boolean }>('app_version'),
  /** Text handed to any app that takes it: a link sent to WhatsApp, an email, a PC. */
  shareText: (text: string, title?: string) => plugin<void>('share_text', { text, title }),
  /** A new email in the person's mail app, filled in and not sent. Whether it opened. */
  composeEmail: async (to: string, subject: string, body: string) =>
    (await plugin<{ opened: boolean }>('compose_email', { to, subject, body }))?.opened ?? false,

  /** Google Play's update and rating services: in the Play build only. */
  playUpdateCheck: () =>
    plugin<{ available: boolean; versionCode?: number; status?: string; error?: string }>('play_update_check'),
  playUpdateStart: () => plugin<{ started: boolean; error?: string }>('play_update_start'),
  playUpdateState: () => plugin<{ status: string; bytes: number; total: number }>('play_update_state'),
  playUpdateComplete: () => plugin<void>('play_update_complete'),
  playReview: async () => (await plugin<{ asked: boolean }>('play_review'))?.asked ?? false,
}

/**
 * What a television keeps clear at its edges, which some sets crop (overscan):
 * 5% of the screen, as Google asks of TV apps, in dp (48 by 27 at 1080p).
 */
const TV_EDGES = { top: 27, bottom: 27, left: 48, right: 48 }

/**
 * Applies the system bars' sizes as CSS variables, now and on every change.
 * On a television they are at least its safe edges (Android applies them too,
 * as it writes these itself), so every screen keeps clear of what a set crops.
 */
export async function applyInsets(): Promise<void> {
  const insets = await android.insets().catch(() => null)
  const tv = isTv()
  if (!insets && !tv) return
  const style = document.documentElement.style
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const px = Math.max(insets?.[side] ?? 0, tv ? TV_EDGES[side] : 0)
    style.setProperty(`--inset-${side}`, `${px}px`)
  }
  style.setProperty('--keyboard', `${insets?.keyboard ?? 0}px`)
}
