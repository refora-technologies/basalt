import { joinPath, type ChosenFiles, type DirEntry } from './api'
import type { ShareFile } from './share'

/**
 * Sharing a folder (1.6.4): it goes as its files, each with its folder inside
 * it ("Holiday/Day 1"), and the device that takes them makes the same
 * folders under its received folder. The same on every way a share goes:
 * straight across, nearby, and through the host.
 */

/** The most files one share holds (the host's limit too). */
export const MOST_SHARE_FILES = 1000

/** One thing chosen in Files: a file or a folder on the drive. */
export interface Chosen {
  /** Its path on the drive. */
  id: string
  name: string
  kind: 'dir' | 'file'
  size: number
}

/** Names nobody means to send: what systems make for themselves. */
const LEFT_BEHIND = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', '.ds_store'])

function leftBehind(entry: DirEntry): boolean {
  return entry.hidden === true || entry.name.startsWith('.') || LEFT_BEHIND.has(entry.name.toLowerCase())
}

/**
 * What is chosen on the drive, as files to share: a file as it is, a folder
 * as every file in it (hidden and system files left behind), each with its
 * folder inside the folder chosen. Throws, said plainly, when a folder has
 * nothing to send or there are more than `most` files.
 */
export async function filesToShare(
  chosen: Chosen[],
  list: (path: string) => Promise<DirEntry[]>,
  most = MOST_SHARE_FILES,
): Promise<ShareFile[]> {
  const files: ShareFile[] = []
  const tooMany = (): Error => new Error(`That’s more than ${most} files. Share the folder in parts, or as a zip.`)
  for (const item of chosen) {
    if (item.kind === 'file') {
      files.push({ name: item.name, size: item.size, path: item.id })
    } else {
      const before = files.length
      // One folder at a time, in name order, so the files come in the order
      // the folder shows them.
      const waiting: { path: string; folder: string }[] = [{ path: item.id, folder: item.name }]
      while (waiting.length > 0) {
        const { path, folder } = waiting.shift()!
        const inside = (await list(path)).filter((e) => !leftBehind(e)).sort((a, b) => a.name.localeCompare(b.name))
        const below: { path: string; folder: string }[] = []
        for (const entry of inside) {
          if (entry.kind === 'dir') {
            below.push({ path: joinPath(path, entry.name), folder: `${folder}/${entry.name}` })
          } else {
            files.push({ name: entry.name, size: entry.size, path: joinPath(path, entry.name), folder })
            if (files.length > most) throw tooMany()
          }
        }
        waiting.unshift(...below)
      }
      if (files.length === before && chosen.length === 1) throw new Error(`“${item.name}” has no files to share.`)
    }
    if (files.length > most) throw tooMany()
  }
  return files
}

/**
 * Files chosen on this device (a folder's included), as files to share.
 * Throws why, said plainly, when there is nothing to send.
 */
export function localToShare(chosen: ChosenFiles): ShareFile[] {
  if (chosen.files.length === 0 && chosen.problem) throw new Error(chosen.problem)
  return chosen.files.map((f) => ({ name: f.name, size: f.size, path: '', source: f.source, ...(f.folder ? { folder: f.folder } : {}) }))
}

/** The top folder of a file in a shared folder, if it is in one. */
export function topOf(file: { folder?: string }): string | null {
  const top = (file.folder ?? '').split('/').find((part) => part.trim() !== '')
  return top ?? null
}

/**
 * The shared folder an offer is, by name, when all its files are in one:
 * "Holiday". Null for files shared on their own, or from several folders.
 */
export function sharedFolder(files: { folder?: string }[]): string | null {
  if (files.length === 0) return null
  const tops = new Set(files.map(topOf))
  if (tops.size !== 1) return null
  const [top] = [...tops]
  return top ?? null
}

/**
 * Where each file of an offer goes on this device: under its shared folder's
 * name here (`roots`, top by top: "Holiday (1)" when a "Holiday" is there
 * already), then its own folders inside. Undefined for a file on its own.
 */
export function withinFor(file: { folder?: string }, roots: Map<string, string>): string | undefined {
  const parts = (file.folder ?? '').split('/').filter((part) => part.trim() !== '')
  if (parts.length === 0) return undefined
  const root = roots.get(parts[0]!) ?? parts[0]!
  return [root, ...parts.slice(1)].join('/')
}

/**
 * The name each shared folder of an offer takes here, top by top, asked of
 * `choose` once per share ("Holiday", or "Holiday (1)" when one is there).
 */
export async function rootsFor(files: { folder?: string }[], choose: (top: string) => Promise<string>): Promise<Map<string, string>> {
  const roots = new Map<string, string>()
  for (const top of new Set(files.map(topOf))) {
    if (top === null) continue
    roots.set(top, await choose(top).catch(() => top))
  }
  return roots
}

/**
 * Where a received shared folder is on this device, to show it: from where
 * its first file landed. Undefined for files shared on their own.
 */
export function receivedFolderPath(files: { folder?: string }[], saved: { path?: string }[], roots: Map<string, string>): string | undefined {
  if (sharedFolder(files) === null) return undefined
  const within = withinFor(files[0]!, roots)
  const path = saved[0]?.path
  return within && path ? rootPathOf(path, within) : undefined
}

/**
 * The folder a received shared folder is in on this device, from where one
 * of its files landed: the file's path less its own folders and name.
 */
export function rootPathOf(filePath: string, within: string): string {
  const depth = within.split('/').filter((part) => part !== '').length
  const parts = filePath.split(/[\\/]/)
  const sep = filePath.includes('\\') ? '\\' : '/'
  // Up past the file's name, and every folder below the top.
  return parts.slice(0, Math.max(1, parts.length - depth)).join(sep)
}
