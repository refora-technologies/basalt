import { ApiError } from './api'
import type { ManageAction, ManageView } from './manage'

/**
 * A host to manage in the browser preview, changed by every action as the
 * real one is, so each screen and each refusal can be looked at without one.
 *
 * `?owner` opens the preview as a device that manages its host.
 */

const now = (): number => Math.floor(Date.now() / 1000)
const GB = 1024 ** 3

const sample: ManageView = {
  // `?update`: a new version waiting; `?docker`: a host that cannot update itself.
  update: {
    version: '1.5.0',
    method:
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('docker') ? 'container' : 'service',
    canInstall: !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('docker')),
    automatic: true,
    available:
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('update')
        ? { version: '1.5.1', notes: '## Fixed\n\n* Posters for films with a year in brackets.', pageUrl: '' }
        : null,
    stage: { kind: 'idle' },
    checkedAt: now() - 2 * 3600,
    command:
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('docker')
        ? 'docker compose pull && docker compose up -d'
        : null,
    outcome: null,
  },
  // Whichever of the two the preview is: `?mobile` is the phone.
  you:
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mobile')
      ? 'd-phone'
      : 'd-laptop',
  status: {
    hostId: 'b7423f0a9c1e5d2e8b6f4a3c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e',
    hostName: 'Living room PC',
    port: 7742,
    requirePin: true,
    vault: { path: 'E:\\', name: 'Media Drive', free: 1.2 * 1024 * GB, total: 3.6 * 1024 * GB, available: true },
    addresses: ['192.168.1.20'],
    deviceCount: 4,
    library: {
      enabled: true,
      scanning: false,
      films: 214,
      series: 38,
      uncertain: 3,
      withArt: 240,
      posters: true,
      hasKey: false,
      videos: 86,
      music: 1240,
      photos: 3912,
      scannedAt: now() - 3600,
    },
    profiles: [
      {
        id: 'p-maya',
        name: 'Maya',
        color: 0,
        hasPin: true,
        createdAt: now() - 86400 * 40,
        lastUsed: now() - 120,
        devices: [
          { name: 'Maya’s phone', remembered: true, lastUsed: now() - 120 },
          { name: 'Maya’s laptop', remembered: true, lastUsed: now() - 7200 },
        ],
      },
      {
        id: 'p-sam',
        name: 'Sam',
        color: 3,
        hasPin: true,
        createdAt: now() - 86400 * 12,
        lastUsed: now() - 86400,
        devices: [{ name: 'Kitchen tablet', remembered: true, lastUsed: now() - 86400 }],
      },
      {
        id: 'p-leo',
        name: 'Leo',
        color: 5,
        hasPin: false,
        createdAt: now() - 86400 * 3,
        lastUsed: 0,
        devices: [],
      },
    ],
    profileRules: { requireProfile: false, ownerAddsProfiles: false },
    sections: { movies: true, series: true, videos: true, music: true, photos: true },
    serving: true,
    problem: null,
    conversion: {
      enabled: true,
      available: true,
      detected: true,
      measured: { by: 'NVIDIA graphics', atOnce: 3, speed: 6.4, at: now() - 86400 * 2 },
      measuring: false,
      note: null,
      byHand: null,
      limit: 3,
      active: [{ device: 'Kitchen tablet', file: 'Films/The Long Light (2019)/The.Long.Light.2019.2160p.mkv', since: now() - 900 }],
    },
    endorsement: { by: 'Maya’s phone', until: now() + 86400 * 26 },
    platform: 'windows',
  },
  devices: [
    {
      id: 'd-phone',
      name: 'Maya’s phone',
      pairedAt: now() - 86400 * 60,
      lastSeen: now(),
      writable: true,
      online: true,
      connections: 2,
      sent: 41 * GB,
      received: 2 * GB,
      keyed: true,
      keyKind: 'chip',
      owner: true,
    },
    {
      id: 'd-laptop',
      name: 'Maya’s laptop',
      pairedAt: now() - 86400 * 58,
      lastSeen: now() - 7200,
      writable: true,
      online: false,
      connections: 0,
      sent: 12 * GB,
      received: 4 * GB,
      keyed: true,
      keyKind: 'chip',
      owner: true,
    },
    {
      id: 'd-tablet',
      name: 'Kitchen tablet',
      pairedAt: now() - 86400 * 12,
      lastSeen: now(),
      writable: false,
      online: true,
      connections: 1,
      sent: 3 * GB,
      received: 0,
      keyed: true,
      keyKind: 'system',
      owner: false,
    },
    {
      id: 'd-old',
      name: 'Old laptop',
      pairedAt: now() - 86400 * 200,
      lastSeen: now() - 86400 * 9,
      writable: true,
      online: false,
      connections: 0,
      sent: 80 * GB,
      received: 6 * GB,
      keyed: false,
      keyKind: null,
      owner: false,
    },
  ],
  pairings: [{ id: 'r-1', deviceName: 'Sam’s phone', pin: '482915', secondsLeft: 104 }],
  drives: null,
  // `?link`: a profile from another drive asking to be let in.
  profileLinks:
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('link')
      ? [
          {
            id: 'l-1',
            deviceName: 'Nina’s phone',
            name: 'Nina',
            color: 6,
            home: 'Study Drive',
            secondsLeft: 540,
          },
        ]
      : [],
}

// This device is here: it is the one asking.
for (const device of sample.devices) {
  if (device.id === sample.you) {
    device.online = true
    device.lastSeen = now()
    device.connections = Math.max(1, device.connections)
  }
}

const drives: NonNullable<ManageView['drives']> = [
  { path: 'C:\\', name: 'Windows (C:)', label: 'Windows', kind: 'fixed', free: 74 * GB, total: 476 * GB, ready: true },
  { path: 'E:\\', name: 'Media Drive (E:)', label: 'Media Drive', kind: 'fixed', free: 1.2 * 1024 * GB, total: 3.6 * 1024 * GB, ready: true },
  { path: 'F:\\', name: 'Backup (F:)', label: 'Backup', kind: 'removable', free: 600 * GB, total: 1024 * GB, ready: true },
  { path: 'G:\\', name: 'Card reader (G:)', label: '', kind: 'removable', free: 0, total: 0, ready: false },
]

function lastManager(id: string): boolean {
  const managers = sample.devices.filter((d) => d.owner)
  return managers.length === 1 && managers[0]!.id === id
}

function apply(action: ManageAction): boolean {
  const status = sample.status
  const device = (id: string) => {
    const found = sample.devices.find((d) => d.id === id)
    if (!found) throw new ApiError('notfound', 'that device was not found')
    return found
  }
  switch (action.do) {
    case 'view':
      break
    case 'renameDevice':
      device(action.id).name = action.name.trim()
      break
    case 'setWritable':
      device(action.id).writable = action.writable
      break
    case 'setManages': {
      const d = device(action.id)
      if (action.manages && !d.keyed) {
        throw new ApiError(
          'error',
          'only a device signing in with a key can manage the host; it moves to one the next time it connects with an up-to-date Basalt',
        )
      }
      if (!action.manages && lastManager(action.id)) {
        throw new ApiError('denied', 'this is the only device that manages this host; let another device manage it first')
      }
      d.owner = action.manages
      break
    }
    case 'removeDevice':
      if (lastManager(action.id)) {
        throw new ApiError('denied', 'this is the only device that manages this host; let another device manage it first')
      }
      sample.devices = sample.devices.filter((d) => d.id !== action.id)
      status.deviceCount = sample.devices.length
      break
    case 'denyPairing':
      sample.pairings = sample.pairings.filter((p) => p.id !== action.id)
      break
    case 'setRequirePin':
      status.requirePin = action.require
      break
    case 'setHostName':
      status.hostName = action.name.trim()
      break
    case 'setLibrary':
      status.library.enabled = action.enabled
      break
    case 'rescan':
      status.library.scanning = true
      setTimeout(() => {
        status.library.scanning = false
        status.library.scannedAt = now()
      }, 4000)
      break
    case 'setPosters':
      status.library.posters = action.enabled
      break
    case 'setTmdbKey':
      status.library.hasKey = action.key.trim() !== ''
      break
    case 'setConversion':
      status.conversion.enabled = action.enabled
      break
    case 'setConversionAtOnce':
      status.conversion.byHand = action.atOnce
      status.conversion.limit = action.atOnce ?? status.conversion.measured?.atOnce ?? 1
      break
    case 'measureConversion':
      if (new URLSearchParams(window.location.search).has('lowmem')) {
        throw new ApiError(
          'error',
          'Not measured: it needs about 2.5 GB of free memory, and this computer has 1.4 GB free. Close other apps, or give it more memory, and measure again.',
        )
      }
      status.conversion.measuring = true
      setTimeout(() => {
        status.conversion.measuring = false
        status.conversion.measured = { by: 'NVIDIA graphics', atOnce: 3, speed: 6.6, at: now() }
      }, 3500)
      break
    case 'setSections':
      status.sections = action.sections
      break
    case 'addProfile': {
      const name = action.name.trim()
      if (status.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        throw new ApiError('exists', `there is already a profile called ${name}`)
      }
      status.profiles.push({
        id: `p-${Date.now()}`,
        name,
        color: action.color,
        hasPin: false,
        createdAt: now(),
        lastUsed: 0,
        devices: [],
      })
      break
    }
    case 'removeProfile':
      status.profiles = status.profiles.filter((p) => p.id !== action.id)
      if (status.profiles.length === 0) status.profileRules.requireProfile = false
      break
    case 'resetProfilePin': {
      const profile = status.profiles.find((p) => p.id === action.id)
      if (profile) {
        profile.hasPin = false
        profile.devices = []
      }
      break
    }
    case 'setRequireProfile':
      if (action.require && status.profiles.length === 0) {
        throw new ApiError('error', 'add a profile first; with none, nobody could sign in')
      }
      status.profileRules.requireProfile = action.require
      break
    case 'setOwnerAddsProfiles':
      status.profileRules.ownerAddsProfiles = action.ownerOnly
      break
    case 'listDrives':
      return true
    case 'listFolders': {
      const listed = MOCK_FOLDERS[action.path || '/']
      if (!listed) throw new ApiError('notfound', `${action.path}: the host can't open it (no such folder)`)
      const path = action.path || '/'
      const up = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'
      sample.folders = {
        path,
        parent: up,
        folders: listed.map((name) => ({ name, path: `${path === '/' ? '' : path}/${name}` })),
      }
      return false
    }
    case 'checkForUpdate':
      if (sample.update) sample.update.checkedAt = now()
      break
    case 'installUpdate':
      if (sample.update?.available) sample.update.stage = { kind: 'downloading', percent: 35 }
      break
    case 'setAutomaticUpdates':
      if (sample.update) sample.update.automatic = action.enabled
      break
    case 'renameDrive':
      if (!action.name.trim()) throw new ApiError('error', 'a drive needs a name')
      if (status.vault) status.vault.name = action.name.trim()
      break
    case 'approveProfileLink': {
      const link = sample.profileLinks?.find((l) => l.id === action.id)
      if (!link) throw new ApiError('notfound', 'that request (it may have lapsed) was not found')
      sample.profileLinks = sample.profileLinks?.filter((l) => l.id !== action.id)
      status.profiles.push({
        id: `p-${Date.now()}`,
        name: link.name,
        color: link.color,
        hasPin: false,
        createdAt: now(),
        lastUsed: now(),
        devices: [{ name: link.deviceName, remembered: true, lastUsed: now() }],
        home: link.home,
      })
      break
    }
    case 'denyProfileLink':
      sample.profileLinks = sample.profileLinks?.filter((l) => l.id !== action.id)
      break
    case 'chooseDrive': {
      const drive = drives.find((d) => d.path === action.path)
      if (!drive || !drive.ready) {
        throw new ApiError('notfound', `${action.path} is not there any more. Plug it back in, or pick another drive.`)
      }
      status.vault = { path: drive.path, name: action.name || drive.label, free: drive.free, total: drive.total, available: true }
      break
    }
  }
  return false
}

/** A small file system for the preview's folder browser. */
const MOCK_FOLDERS: Record<string, string[]> = {
  '/': ['home', 'media', 'mnt', 'srv'],
  '/home': ['maya'],
  '/home/maya': ['Documents', 'Pictures', 'Videos'],
  '/home/maya/Documents': [],
  '/home/maya/Pictures': [],
  '/home/maya/Videos': [],
  '/media': [],
  '/mnt': ['backup'],
  '/mnt/backup': [],
  '/srv': ['media'],
  '/srv/media': ['Films', 'Music', 'Photos', 'TV'],
  '/srv/media/Films': [],
  '/srv/media/Music': [],
  '/srv/media/Photos': [],
  '/srv/media/TV': [],
}

export function mockManage(action: ManageAction): ManageView {
  const withDrives = apply(action)
  // The pairing request counts down, as the host's does.
  sample.pairings = sample.pairings
    .map((p) => ({ ...p, secondsLeft: Math.max(0, p.secondsLeft - 3) }))
    .filter((p) => p.secondsLeft > 0)
  return structuredClone({ ...sample, drives: withDrives ? drives : null })
}
