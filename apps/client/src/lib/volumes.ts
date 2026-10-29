/**
 * The volume music plays at, and the volume films play at, each as last
 * set, kept on this device.
 *
 * Music and films share one player underneath, so without these whichever
 * played last left its volume to the other, and the first of either after
 * the app opened was at full: a song turned down for the evening came back
 * loud, and so did the next film.
 */
export type VolumeOf = 'music' | 'video'

/** Before anything was set: music a little lower, as it is listened to around other things. */
const FIRST: Record<VolumeOf, number> = { music: 70, video: 100 }
/** The highest each goes: films may go past the file's own loudness, music does not. */
const MOST: Record<VolumeOf, number> = { music: 100, video: 130 }

const key = (of: VolumeOf): string => `basalt.volume.${of}`

export function rememberedVolume(of: VolumeOf): number {
  try {
    const kept = localStorage.getItem(key(of))
    if (kept === null) return FIRST[of]
    const value = Number(kept)
    return Number.isFinite(value) ? Math.max(0, Math.min(MOST[of], Math.round(value))) : FIRST[of]
  } catch {
    return FIRST[of]
  }
}

export function rememberVolume(of: VolumeOf, volume: number): void {
  if (!Number.isFinite(volume)) return
  try {
    localStorage.setItem(key(of), String(Math.max(0, Math.min(MOST[of], Math.round(volume)))))
  } catch {
    // Not kept: the next start uses the last one kept.
  }
}
