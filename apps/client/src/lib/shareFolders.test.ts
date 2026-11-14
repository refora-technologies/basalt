import { describe, expect, it } from 'vitest'

import type { DirEntry } from './api'
import { filesToShare, rootPathOf, sharedFolder, topOf, withinFor } from './shareFolders'
import { titleOf } from './share'

/** A drive: each folder's path, and what is in it. */
function drive(tree: Record<string, DirEntry[]>): (path: string) => Promise<DirEntry[]> {
  return async (path) => tree[path] ?? []
}

const file = (name: string, size = 1, hidden = false): DirEntry => ({ name, kind: 'file', size, mtime: 0, readonly: false, hidden })
const dir = (name: string): DirEntry => ({ name, kind: 'dir', size: 0, mtime: 0, readonly: false })

describe('sharing a folder on the drive', () => {
  const tree = {
    'Photos/Holiday': [file('b.jpg', 2), dir('Day 1'), file('desktop.ini'), file('.hidden'), file('secret', 1, true)],
    'Photos/Holiday/Day 1': [file('a.jpg', 3), dir('Morning')],
    'Photos/Holiday/Day 1/Morning': [file('c.jpg', 4)],
    'Photos/Empty': [dir('Inside')],
  }

  it('is every file in it, each with its folder inside it, as the folder shows them', async () => {
    const files = await filesToShare(
      [
        { id: 'Photos/Holiday', name: 'Holiday', kind: 'dir', size: 0 },
        { id: 'notes.txt', name: 'notes.txt', kind: 'file', size: 5 },
      ],
      drive(tree),
    )
    expect(files).toEqual([
      { name: 'b.jpg', size: 2, path: 'Photos/Holiday/b.jpg', folder: 'Holiday' },
      { name: 'a.jpg', size: 3, path: 'Photos/Holiday/Day 1/a.jpg', folder: 'Holiday/Day 1' },
      { name: 'c.jpg', size: 4, path: 'Photos/Holiday/Day 1/Morning/c.jpg', folder: 'Holiday/Day 1/Morning' },
      { name: 'notes.txt', size: 5, path: 'notes.txt' },
    ])
  })

  it('says so plainly when there is nothing to send, or too much', async () => {
    await expect(filesToShare([{ id: 'Photos/Empty', name: 'Empty', kind: 'dir', size: 0 }], drive(tree))).rejects.toThrow(
      '“Empty” has no files to share.',
    )
    await expect(filesToShare([{ id: 'Photos/Holiday', name: 'Holiday', kind: 'dir', size: 0 }], drive(tree), 2)).rejects.toThrow(
      'more than 2 files',
    )
  })
})

describe('a shared folder, as it is shown and where it lands', () => {
  const holiday = [
    { name: 'b.jpg', size: 2, path: '', folder: 'Holiday' },
    { name: 'a.jpg', size: 3, path: '', folder: 'Holiday/Day 1' },
  ]

  it('is called by its name and how many files it has', () => {
    expect(sharedFolder(holiday)).toBe('Holiday')
    expect(titleOf(holiday)).toBe('Holiday (2 files)')
    expect(titleOf([holiday[0]!])).toBe('Holiday (1 file)')
    // Files on their own, or from two folders, are called as files are.
    expect(sharedFolder([{ folder: '' }, { folder: 'Holiday' }])).toBeNull()
    expect(titleOf([{ name: 'x.txt', size: 1, path: '' }, { name: 'y.txt', size: 1, path: '' }])).toBe('x.txt and 1 more')
  })

  it('lands under the name chosen for it here, its own folders inside', () => {
    const roots = new Map([['Holiday', 'Holiday (1)']])
    expect(withinFor({ folder: 'Holiday/Day 1' }, roots)).toBe('Holiday (1)/Day 1')
    expect(withinFor({ folder: 'Holiday' }, roots)).toBe('Holiday (1)')
    expect(withinFor({ folder: '' }, roots)).toBeUndefined()
    expect(withinFor({}, roots)).toBeUndefined()
    expect(topOf({ folder: '/Holiday/Day 1' })).toBe('Holiday')
  })

  it('is shown in its folder from where any of its files landed', () => {
    expect(rootPathOf('C:\\Users\\You\\Downloads\\Basalt\\Holiday (1)\\Day 1\\a.jpg', 'Holiday (1)/Day 1')).toBe(
      'C:\\Users\\You\\Downloads\\Basalt\\Holiday (1)',
    )
    expect(rootPathOf('/home/you/Downloads/Basalt/Holiday/b.jpg', 'Holiday')).toBe('/home/you/Downloads/Basalt/Holiday')
  })
})
