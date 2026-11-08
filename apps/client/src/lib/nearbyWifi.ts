import { api, inTauri } from './api'
import { android } from './android'
import { isAndroid } from './platform'

/**
 * A nearby device's own Wi-Fi, wherever this runs (1.6.4): for two devices
 * with no network in common. A device ready to receive hosts one named for
 * it ("DIRECT-bs-K7HM Pixel 8"); a device sharing finds it and joins it, and
 * from there it is as on any Wi-Fi. The computer's side is in the app's
 * Rust (Wi-Fi Direct, the WLAN API); the phone's in Android's.
 */

/** Every Basalt Wi-Fi's name starts so. */
export const WIFI_PREFIX = 'DIRECT-bs-'

/** A Basalt Wi-Fi found around. */
export interface FoundWifi {
  ssid: string
  /** Its device's short id, and name as the Wi-Fi's name has it. */
  id: string
  name: string
}

/** Whether this device can do it now: `granted`, or what stands in the way. */
export type WifiState = 'granted' | 'ask' | 'denied' | 'location' | 'unsupported'

/** The id and name in a Basalt Wi-Fi's name, if it is one. */
export function wifiDevice(ssid: string): { id: string; name: string } | null {
  if (!ssid.startsWith(WIFI_PREFIX)) return null
  const rest = ssid.slice(WIFI_PREFIX.length)
  const space = rest.indexOf(' ')
  const id = space === -1 ? rest : rest.slice(0, space)
  if (!/^[ACDEFHJKMNPRTUVWXY34679]{4}$/.test(id)) return null
  return { id, name: space === -1 ? '' : rest.slice(space + 1) }
}

/** Asks for what Android needs first (location, or nearby devices); on a computer, nothing. */
export async function wifiReady(ask: boolean): Promise<WifiState> {
  if (!inTauri()) return 'granted'
  if (!isAndroid()) return 'granted'
  const state = (await android.nearbyWifiState().catch(() => 'unsupported')) as WifiState
  if (state === 'ask' && ask) return (await android.requestNearbyWifi().catch(() => 'denied')) as WifiState
  return state
}

/** Hosts this device's own Wi-Fi, or stops. */
export async function hostWifi(on: boolean): Promise<void> {
  if (!inTauri()) return
  if (!isAndroid()) {
    await api.nearbyWifiHost(on)
    return
  }
  if (!on) {
    await android.nearbyHostStop()
    return
  }
  const own = await api.nearbyWifiOwn()
  await android.nearbyHost(own.ssid, own.passphrase)
}

/** The Basalt Wi-Fis around, strongest first. */
export async function scanWifi(): Promise<FoundWifi[]> {
  if (!inTauri()) return previewWifi()
  const found = isAndroid() ? await android.nearbyScan() : await api.nearbyWifiScan()
  return found.flatMap((f) => {
    const device = wifiDevice(f.ssid)
    return device ? [{ ssid: f.ssid, ...device }] : []
  })
}

/** Joins a Basalt Wi-Fi found around. On a phone, Android asks the person first. */
export async function joinWifi(ssid: string): Promise<void> {
  if (!inTauri()) return
  if (!isAndroid()) {
    await api.nearbyWifiJoin(ssid)
    return
  }
  const passphrase = await api.nearbyWifiPassphrase(ssid)
  await android.nearbyJoin(ssid, passphrase)
}

/** Leaves a Basalt Wi-Fi joined to share: back to the one before. */
export async function leaveWifi(): Promise<void> {
  if (!inTauri()) return
  if (isAndroid()) await android.nearbyLeave()
  else await api.nearbyWifiLeave()
}

/** The page preview's: a phone across the café, on no Wi-Fi of ours. */
function previewWifi(): FoundWifi[] {
  return [{ ssid: 'DIRECT-bs-RW4K Galaxy S24', id: 'RW4K', name: 'Galaxy S24' }]
}
