import { useMemo } from 'react'

import { Thumb } from '@/components/MediaViews'
import { thumbUrl } from '@/lib/thumbs'
import { cn } from '@/lib/utils'

/**
 * An album's cover: the picture the host found for it (inside a song, or
 * beside the songs in their folder), else one drawn for it.
 *
 * The drawn one is basalt seen from above: the six-sided columns the stone
 * cools into, each shaded a little differently, in a tint taken from the
 * album's name. Every album gets its own, it is the same on every device,
 * and it says Basalt without a word. The name sits on it, as on a sleeve.
 */
export function Cover({
  base,
  path,
  mtime,
  name,
  size = 320,
  round,
  className,
  label = true,
}: {
  base: string
  /** A song whose thumbnail is the cover, or null to draw one. */
  path: string | null
  mtime?: number
  /** What it is a cover of, for the drawing and the picture's description. */
  name: string
  /** The size asked of the host, in pixels. */
  size?: number
  /** An artist: a circle, with initials on a drawn one. */
  round?: boolean
  className?: string
  /** The name on a drawn cover; off where the name is right beside it. */
  label?: boolean
}): React.JSX.Element {
  const src = path ? thumbUrl(base, path, mtime ?? 0, size) : ''
  return (
    <div
      className={cn('relative aspect-square overflow-hidden', round ? 'rounded-full' : 'rounded-lg', className)}
      // The name is sized to the cover, not the screen: see the label.
      style={{ containerType: 'inline-size' }}
    >
      <Columns name={name} />
      {label && (
        <div
          className={cn(
            'pointer-events-none absolute inset-0 flex p-[8%] font-semibold leading-tight text-white/90 [text-shadow:0_1px_8px_rgba(0,0,0,0.45)]',
            round ? 'items-center justify-center text-[clamp(11px,30cqw,44px)]' : 'items-end text-[clamp(8px,10.5cqw,26px)]',
          )}
        >
          <span className="line-clamp-3 break-words">{round ? initials(name) : name}</span>
        </div>
      )}
      {src && <Thumb src={src} alt={name} className="absolute inset-0 h-full w-full bg-transparent" />}
    </div>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => [...w][0]!.toUpperCase())
    .slice(0, 2)
    .join('')
}

/** A whole number from a name: the same name, the same drawing. */
function seedOf(name: string): number {
  let h = 2166136261
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

/** Numbers in [0, 1) following from a seed. */
function stream(seed: number): () => number {
  let s = seed || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

/** Basalt columns from above, tinted by `name`. */
function Columns({ name }: { name: string }): React.JSX.Element {
  const drawing = useMemo(() => {
    const seed = seedOf(name || '?')
    const next = stream(seed)
    const hue = seed % 360
    // Quiet colours, as the app is: a little tint over dark stone.
    const tint = (light: number): string => `hsl(${hue} ${10 + Math.round(next() * 14)}% ${light}%)`
    const r = 10
    const w = Math.sqrt(3) * r
    const cells: string[] = []
    for (let row = -1; row < 100 / (1.5 * r) + 1; row++) {
      for (let col = -1; col < 100 / w + 1; col++) {
        const cx = col * w + (row % 2 ? w / 2 : 0)
        const cy = row * 1.5 * r
        // Each column a little smaller than its place: the joints between.
        const k = r * (0.9 + next() * 0.06)
        const points = [0, 1, 2, 3, 4, 5]
          .map((i) => {
            const a = (Math.PI / 3) * i - Math.PI / 6
            return `${(cx + k * Math.cos(a)).toFixed(1)},${(cy + k * Math.sin(a)).toFixed(1)}`
          })
          .join(' ')
        const light = 16 + Math.round(next() * 18) + Math.round((1 - cy / 100) * 6)
        cells.push(`<polygon points="${points}" fill="${tint(light)}"/>`)
      }
    }
    const glow = `hsl(${(hue + 30) % 360} 30% 40%)`
    return { cells: cells.join(''), glow, angle: 120 + (seed % 90), id: `basalt-${seed.toString(36)}` }
  }, [name])

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden>
      <rect width="100" height="100" fill="#0e0e10" />
      <g dangerouslySetInnerHTML={{ __html: drawing.cells }} />
      <defs>
        <linearGradient id={drawing.id} gradientTransform={`rotate(${drawing.angle - 90} 0.5 0.5)`}>
          <stop offset="0" stopColor={drawing.glow} stopOpacity="0.28" />
          <stop offset="1" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${drawing.id})`} />
    </svg>
  )
}
