import { api, inTauri } from './api'
import { android } from './android'
import { isAndroid, isLinuxDesktop } from './platform'

/**
 * Devices nearby found by Bluetooth (1.6.4), wherever this runs: how a device
 * with no Wi-Fi in common is found, and asked to open a Wi-Fi of its own for
 * one share. Before, a device ready to receive kept that Wi-Fi open all the
 * time, and its own Wi-Fi ran several times slower for it.
 *
 * The phone's side is NearbyBle.kt; the computer's, nearby_ble.rs (Windows).
 * Linux finds devices on the same Wi-Fi only, for now.
 */

/**
 * Whether this device can reach, and be reached by, devices that aren't on
 * its Wi-Fi: `ready`, or the first thing in the way, in the order to put it
 * right.
 */
export type NearbyReach = 'ready' | 'ask' | 'denied' | 'bluetooth' | 'wifi' | 'location' | 'unsupported'

/** A device that is ready, found by Bluetooth, and what it said about itself. */
export interface FoundBle {
  /** Where Bluetooth reaches it; only this device's to use. */
  address: string
  id: string
  name: string
  form?: 'computer' | 'phone' | 'tablet'
  /** The Wi-Fi it opens when asked. */
  ssid: string
  code: boolean
  rssi: number
  /**
   * It told us it's here, its Wi-Fi already open (it can't be found by
   * Bluetooth itself, so it listens for devices sharing): only to join.
   */
  open: boolean
}

/** What a ready device says about itself, as JSON over Bluetooth. */
export interface BleInfo {
  v: 1
  id: string
  name: string
  form?: string
  ssid: string
  code: boolean
}

/** Linux, and a browser: devices on the same Wi-Fi only. */
function none(): boolean {
  return !inTauri() ? false : !isAndroid() && isLinuxDesktop()
}

/** Where things stand; on a phone, asks for "nearby devices" first when `ask`. */
export async function nearbyReach(ask: boolean): Promise<NearbyReach> {
  if (none()) return 'unsupported'
  if (isAndroid()) {
    const state = (await android.nearbyState().catch(() => 'unsupported')) as NearbyReach
    if (state === 'ask' && ask) return (await android.requestNearby().catch(() => 'denied')) as NearbyReach
    return state
  }
  return (await api.nearbyReach().catch(() => 'unsupported')) as NearbyReach
}

/**
 * Bluetooth off: on a phone, Android's own "turn on Bluetooth?"; on a
 * computer, switched on (Windows lets an app), or Settings opened if not.
 */
export async function turnBluetoothOn(): Promise<void> {
  if (isAndroid()) await android.bluetoothTurnOn()
  else await api.bluetoothTurnOn()
}

/** Ready, saying so over Bluetooth with `info`; or not. */
export async function bleReady(on: boolean, info: BleInfo | null): Promise<void> {
  if (none()) return
  if (isAndroid()) {
    if (!on || !info) {
      await android.bleStop()
      return
    }
    const own = await api.nearbyWifiOwn()
    await android.bleReady(JSON.stringify({ ...info, ssid: own.ssid }), own.ssid, own.passphrase)
    return
  }
  await api.bleReady(on, info ? JSON.stringify(info) : '')
}

/** Looks for ready devices while `on`. */
export async function bleLook(on: boolean): Promise<void> {
  if (none()) return
  if (isAndroid()) await android.bleLook(on)
  else await api.bleLook(on)
}

/** What has been found by Bluetooth lately, strongest first. */
export async function bleSeen(): Promise<FoundBle[]> {
  if (none()) return []
  const raw = isAndroid() ? await android.bleSeen() : await api.bleSeen()
  return parseSeen(raw)
}

/** Each one that said who it is properly; the rest left out. */
export function parseSeen(raw: { address: string; info: string; rssi: number; open?: boolean }[]): FoundBle[] {
  const out: FoundBle[] = []
  for (const r of raw) {
    try {
      const info = JSON.parse(r.info) as Partial<BleInfo>
      if (info.v !== 1 || typeof info.id !== 'string' || typeof info.ssid !== 'string') continue
      const form = info.form === 'computer' || info.form === 'phone' || info.form === 'tablet' ? info.form : undefined
      out.push({
        address: r.address,
        id: info.id,
        name: info.name || 'A device',
        form,
        ssid: info.ssid,
        code: !!info.code,
        rssi: r.rssi,
        open: !!r.open,
      })
    } catch {
      // Not ours, or cut short: left out.
    }
  }
  // One device heard under two addresses (Bluetooth changes them): the strongest.
  const best = new Map<string, FoundBle>()
  for (const f of out) {
    const had = best.get(f.id)
    if (!had || f.rssi > had.rssi) best.set(f.id, f)
  }
  return [...best.values()].sort((a, b) => b.rssi - a.rssi)
}

/** Asks one to open its Wi-Fi, saying who asks; resolves once it has. */
export async function bleWake(address: string, from: string): Promise<void> {
  if (isAndroid()) await android.bleWake(address, from)
  else await api.bleWake(address, from)
}

/** What stands in the way, said plainly, with what to do. */
export function reachNote(state: NearbyReach): string | null {
  switch (state) {
    case 'ready':
      return null
    case 'bluetooth':
      return 'Turn on Bluetooth so devices that aren’t on your Wi-Fi can find this one.'
    case 'wifi':
      return 'Turn on Wi-Fi so devices that aren’t on your Wi-Fi can reach this one. It doesn’t need to be connected to a network.'
    case 'location':
      return 'Turn on Location so devices that aren’t on your Wi-Fi can be found. This version of Android needs it to look over Bluetooth.'
    case 'ask':
    case 'denied':
      return 'Allow Basalt to find nearby devices, so devices that aren’t on your Wi-Fi can reach this one.'
    case 'unsupported':
      return 'Only devices on the same Wi-Fi can find this one.'
  }
}
