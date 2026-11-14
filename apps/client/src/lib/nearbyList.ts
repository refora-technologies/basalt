/**
 * The devices nearby, as the list shows them between looks.
 *
 * Each look asks the Wi-Fi who is ready and hears back from most of them: a
 * phone saving power, or a busy Wi-Fi, misses one now and then. The list
 * used to be exactly what the last look heard, so a device that was there
 * all along dropped out of it for four seconds and came back ("sometimes it
 * finds it, sometimes not"), sometimes under a finger about to tap it. Now a
 * device stays for a little while after it last answered.
 */

/** How long a device stays listed after it last answered: two missed looks. */
export const NEAR_FOR_MS = 10_000

export interface Seen<T> {
  device: T
  at: number
}

/** `found` taken into `seen` (kept by the caller between looks); what to list now. */
export function stillNear<T extends { id: string; key?: string }>(seen: Map<string, Seen<T>>, found: T[], now: number): T[] {
  // As it answered last: its address or name may have changed.
  for (const device of found) seen.set(`${device.id}/${device.key ?? ''}`, { device, at: now })
  for (const [id, last] of seen) if (now - last.at > NEAR_FOR_MS) seen.delete(id)
  return [...seen.values()].map((s) => s.device)
}
