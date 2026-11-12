import { api } from './api'

/**
 * Whether Basalt goes on running when its window goes (a phone's app swiped
 * away, a computer's window closed to the tray): while anything holds it.
 *
 * Two things do on a phone: being ready for the home's shares, and being
 * ready for devices nearby. Only the first used to tell the app, so a phone
 * ready for devices nearby but on no drive (a guest's phone) quit when swiped
 * away, though Android was asked to keep it, and stopped receiving.
 */
const holders = new Set<string>()

export function holdRunning(reason: string, on: boolean): void {
  const before = holders.size > 0
  if (on) holders.add(reason)
  else holders.delete(reason)
  const now = holders.size > 0
  if (now !== before) void api.stayRunning(now).catch(() => {})
}
