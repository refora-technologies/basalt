import { useState } from 'react'
import { ArrowDown, ArrowUp, Gauge, Loader2, Timer } from 'lucide-react'

import { api, type SpeedResult } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * How fast the connection between this device and the host is: download,
 * upload, and the delay, with what that means for films in a sentence.
 *
 * For the person to know, and nothing else: no setting changes because of
 * it. Measured over the connection films and uploads use, so it is what
 * they get — the network, not the internet, and not the drive.
 */
export function SpeedTest({ padded }: { padded?: boolean }): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<SpeedResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setTesting(true)
    setFailed(null)
    try {
      setResult(await api.speedTest())
    } catch (e) {
      setFailed(
        e instanceof Error && /unknown|unsupported|not.*know/i.test(e.message)
          ? 'This host is too old to test. Update it to Basalt Host 1.6.3 or later.'
          : 'The test could not finish. Check the connection and try again.',
      )
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-3', padded ? 'px-4 pb-4 pt-3' : 'py-2')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('text-[13px]', padded ? 'text-textDim' : 'text-text')}>Connection speed</div>
          <div className="mt-0.5 text-[11px] text-textFaint">Between this device and the host</div>
        </div>
        <button
          onClick={() => void run()}
          disabled={testing}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 text-[12.5px] text-textDim transition-colors hover:border-lineBright hover:text-text disabled:opacity-60"
        >
          {testing ? <Loader2 size={13} className="animate-spin" /> : <Gauge size={13} />}
          {testing ? 'Testing…' : result ? 'Test again' : 'Test'}
        </button>
      </div>
      {testing && <div className="text-[11.5px] leading-relaxed text-textFaint">About ten seconds. A film playing elsewhere slows a little meanwhile.</div>}
      {failed && !testing && <div className="text-[12px] text-danger">{failed}</div>}
      {result && !testing && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Figure icon={ArrowDown} label="Download" value={mbps(result.downMbps)} />
            <Figure icon={ArrowUp} label="Upload" value={mbps(result.upMbps)} />
            <Figure icon={Timer} label="Delay" value={`${result.delayMs < 10 ? result.delayMs.toFixed(1) : Math.round(result.delayMs)} ms`} />
          </div>
          <div className="text-[12px] leading-relaxed text-textDim">{meaning(result.downMbps)}</div>
        </>
      )}
    </div>
  )
}

function Figure({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Gauge
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg bg-white/[0.04] px-3 py-2.5">
      <div className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.12em] text-textFaint">
        <Icon size={11} />
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-[14px] text-text">{value}</div>
    </div>
  )
}

function mbps(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)} Gbit/s`
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} Mbit/s`
}

/** What the download speed means for films, in a sentence. */
function meaning(down: number): string {
  if (down >= 100) return 'Fast: any film plays as it is, and copying files is quick.'
  if (down >= 40) return 'Good: nearly every film plays as it is.'
  if (down >= 15) return 'Fine for most films. The largest 4K files may need converting by the host.'
  return 'Slow for films. Moving closer to the router, or using a cable, would help.'
}
