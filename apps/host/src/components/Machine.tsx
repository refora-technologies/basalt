import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, FolderOpen, HardDrive, Pencil, Repeat } from 'lucide-react'
import type { DeviceView, HostStatus } from '@/lib/api'
import { cn, formatBytes, formatRate } from '@/lib/utils'
import { HexMark } from './HexMark'
import { Pill } from './ui/Group'

/**
 * The host itself, at the top of its window: the machine, what it is doing
 * this second, and the drive it shares.
 *
 * The rest of the window is settings, which are visited. This is what is
 * glanced at: whether the host is up, who is on it, whether it is busy, and
 * how much room is left. It moves when the host does — the mark glows while
 * it works, the trace draws the last minute's traffic — so it reads as a
 * machine running, not a form.
 */
export function Machine({
  status,
  devices,
  onOpen,
  onChange,
  onRename,
}: {
  status: HostStatus
  devices: DeviceView[]
  onOpen: () => void
  onChange: () => void
  /** What devices call the drive. */
  onRename: () => void
}): React.JSX.Element {
  const online = devices.filter((d) => d.online).length
  const now = activities(status, devices)
  const working = now.length > 0
  const trace = useTrace(devices)
  const sending = devices.reduce((sum, d) => sum + d.sendRate, 0)
  const receiving = devices.reduce((sum, d) => sum + d.receiveRate, 0)
  const address = status.addresses[0]

  return (
    <section className="glass relative overflow-hidden rounded-lg">
      {/* A light that only comes up while the host works. */}
      <motion.div
        aria-hidden
        animate={{ opacity: working ? 1 : 0 }}
        transition={{ duration: 0.8 }}
        className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,rgba(205,205,214,0.09),transparent)]"
      />
      <div className="relative flex flex-col min-[860px]:flex-row">
        <div className="min-w-0 flex-1 px-6 py-5">
          <div className="flex items-center gap-3.5">
            <motion.span
              animate={working ? { opacity: [0.55, 1, 0.55] } : { opacity: 0.85 }}
              transition={working ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.4 }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-text"
            >
              <HexMark size={24} />
            </motion.span>
            <div className="min-w-0">
              <h1 className="truncate text-[24px] font-semibold leading-tight tracking-tighter text-text">
                {status.hostName}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-textDim">
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      status.serving ? 'bg-emerald-400/80' : 'bg-danger',
                    )}
                  />
                  {status.serving ? 'Sharing' : 'Not sharing'}
                </span>
                <Dot />
                <span className="tnum">
                  {devices.length === 0
                    ? 'No devices yet'
                    : `${online} of ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} connected`}
                </span>
                <Dot />
                <span>on {platformName(status.platform)}</span>
                {address && (
                  <>
                    <Dot />
                    <span className="tnum font-mono text-[11px] text-textFaint" title="Only for reference: devices find this host by themselves">
                      {address}:{status.port}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-end gap-5">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">Now</div>
              <ul className="mt-1.5 space-y-1">
                {now.length === 0 ? (
                  <li className="text-[12.5px] text-textDim">
                    {status.serving
                      ? online > 0
                        ? 'Ready. Nothing is moving right now.'
                        : 'Ready, and waiting for a device.'
                      : 'Not sharing. The note above says why.'}
                  </li>
                ) : (
                  now.slice(0, 3).map((line) => (
                    <li key={line} className="flex items-center gap-2 text-[12.5px] text-text">
                      <span className="h-1.5 w-1.5 shrink-0 animate-breathe rounded-full bg-basalt" />
                      <span className="min-w-0 truncate">{line}</span>
                    </li>
                  ))
                )}
              </ul>
            </div>
            <div className="hidden shrink-0 flex-col items-end min-[560px]:flex">
              <Trace values={trace} />
              <div className="tnum mt-1 flex gap-3 font-mono text-[10px] text-textFaint">
                <span title="Sent to devices">↑ {formatRate(sending)}</span>
                <span title="Received from devices">↓ {formatRate(receiving)}</span>
              </div>
            </div>
          </div>
        </div>

        <Drive status={status} onOpen={onOpen} onChange={onChange} onRename={onRename} />
      </div>
    </section>
  )
}

/** The shared drive: its name, how full, and where it is. */
function Drive({
  status,
  onOpen,
  onChange,
  onRename,
}: {
  status: HostStatus
  onOpen: () => void
  onChange: () => void
  onRename: () => void
}): React.JSX.Element | null {
  const vault = status.vault
  if (!vault) return null
  const used = vault.total > 0 ? (vault.total - vault.free) / vault.total : 0

  return (
    <div className="flex shrink-0 flex-col border-t border-line px-6 py-5 min-[860px]:w-[330px] min-[860px]:border-l min-[860px]:border-t-0">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-textDim">
          <HardDrive size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <button
            onClick={onRename}
            title="Rename this drive: only what devices call it"
            className="group flex min-w-0 max-w-full items-center gap-1.5 text-left"
          >
            <span className="truncate text-[14px] font-semibold text-text">{vault.name}</span>
            <Pencil size={11} className="shrink-0 text-textFaint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
          <div className="truncate font-mono text-[11px] text-textFaint" title={vault.path}>
            {vault.path}
          </div>
        </div>
      </div>

      {!vault.available ? (
        // Missing, rather than empty: the host has not lost its choice, and
        // shares the drive again the moment it is back.
        <div className="mt-4 rounded-md bg-dangerBg px-3.5 py-3">
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            This drive isn’t connected. It’s shared again as soon as it’s plugged back in.
          </p>
        </div>
      ) : (
        <>
          {vault.canAddFiles === false && (
            // Readable but not writable: devices browse and play, and every
            // upload, rename or delete is refused. The fix is the folder's
            // permissions on this computer.
            <div className="mt-4 flex items-start gap-2 rounded-md bg-dangerBg px-3.5 py-3">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
              <p className="text-[12px] leading-relaxed text-danger">
                Basalt Host can’t add files here, so uploads and changes are refused. Give the
                user Basalt Host runs as permission to change this folder.
              </p>
            </div>
          )}
          {vault.total > 0 ? (
            <>
              <div className="mt-4 h-[6px] w-full overflow-hidden rounded-full bg-ink2">
                <motion.div
                  className="h-full rounded-full bg-basaltDeep"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.round(used * 100)}%` }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <div className="tnum mt-2 flex items-baseline justify-between font-mono text-[11px]">
                <span className="text-textDim">{formatBytes(vault.free)} free</span>
                <span className="text-textFaint">of {formatBytes(vault.total)}</span>
              </div>
            </>
          ) : (
            // Some USB enclosures decline to report a size; the gauge would lie.
            <p className="mt-4 font-mono text-[11px] text-textFaint">This drive doesn’t report its size</p>
          )}
        </>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <Pill icon={<FolderOpen size={13} />} onClick={onOpen}>
          {status.platform === 'windows' ? 'Open in Explorer' : 'Open'}
        </Pill>
        <Pill icon={<Repeat size={13} />} onClick={onChange}>
          {vault.available ? 'Share another' : 'Choose another drive'}
        </Pill>
      </div>
    </div>
  )
}

function Dot(): React.JSX.Element {
  return <span className="text-textFaint">·</span>
}

function platformName(platform: HostStatus['platform']): string {
  switch (platform) {
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'macos':
      return 'macOS'
    default:
      return 'this computer'
  }
}

/**
 * What the host is doing right now, in sentences: files moving to and from
 * devices, films being converted, pictures being made, the drive being read.
 * Empty when it is doing nothing.
 */
export function activities(status: HostStatus, devices: DeviceView[]): string[] {
  const lines: string[] = []
  const moving = [...devices]
    .filter((d) => d.sendRate >= 1 || d.receiveRate >= 1)
    .sort((a, b) => b.sendRate + b.receiveRate - (a.sendRate + a.receiveRate))
  for (const device of moving.slice(0, 2)) {
    lines.push(
      device.sendRate >= device.receiveRate
        ? `Sending to ${device.name} at ${formatRate(device.sendRate)}`
        : `Receiving from ${device.name} at ${formatRate(device.receiveRate)}`,
    )
  }
  for (const job of status.conversion.active) {
    lines.push(`Converting ${stem(job.file)} for ${job.device}`)
  }
  if (status.conversion.measuring) lines.push('Measuring how much video it can convert')
  if (status.library.scanning) lines.push('Reading the drive for films, series, music and photos')
  const pictures = status.library.previewsNow
  if (pictures) {
    lines.push(
      pictures.total > 0
        ? `Making timeline pictures: ${stem(pictures.name)} · ${pictures.done + 1} of ${pictures.total}`
        : `Making timeline pictures: ${stem(pictures.name)}`,
    )
  }
  return lines
}

/** A file's name without its folders or kind. */
function stem(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Seconds of traffic the trace draws. */
const TRACE_SECONDS = 60

/**
 * The last minute's traffic, both ways together, one sample a second: the
 * device list is asked for every second, and each answer is a sample.
 */
function useTrace(devices: DeviceView[]): number[] {
  const [samples, setSamples] = useState<number[]>(() => Array(TRACE_SECONDS).fill(0))
  const total = devices.reduce((sum, d) => sum + d.sendRate + d.receiveRate, 0)
  const last = useRef<DeviceView[] | null>(null)
  useEffect(() => {
    if (last.current === devices) return
    last.current = devices
    setSamples((s) => [...s.slice(1), total])
  }, [devices, total])
  return samples
}

/** The traffic as a line, scaled to its own busiest second. */
function Trace({ values }: { values: number[] }): React.JSX.Element {
  const width = 180
  const height = 38
  const peak = Math.max(...values, 1)
  const quiet = Math.max(...values) < 1
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width
      const y = height - 2 - (v / peak) * (height - 6)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Traffic in the last minute">
      <line x1={0} y1={height - 1.5} x2={width} y2={height - 1.5} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      {!quiet && (
        <polyline
          points={points}
          fill="none"
          stroke="rgba(214,214,222,0.75)"
          strokeWidth={1.4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
