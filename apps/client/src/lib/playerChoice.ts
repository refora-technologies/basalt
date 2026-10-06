/**
 * The player the person chose for "Play in your player", on Windows.
 *
 * Without a choice the app uses the player Windows opens the file with, when
 * it can stream, and that is right for most people. This is for the rest:
 * someone whose default is a player that cannot take a stream, or who simply
 * wants films in another one.
 */

const KEY = 'basalt.external-player'

export interface PlayerChoice {
  name: string
  path: string
}

export function preferredPlayer(): PlayerChoice | null {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<PlayerChoice>) : null
    return parsed?.path && parsed.name ? { name: parsed.name, path: parsed.path } : null
  } catch {
    return null
  }
}

/** Remembers a player for next time, or forgets the choice with `null`. */
export function preferPlayer(choice: PlayerChoice | null): void {
  try {
    if (choice) localStorage.setItem(KEY, JSON.stringify(choice))
    else localStorage.removeItem(KEY)
  } catch {
    // Not remembered: the next film asks Windows again, which is harmless.
  }
}
