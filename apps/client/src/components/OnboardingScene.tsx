import { useId } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Laptop, Monitor, Smartphone } from 'lucide-react'
import { HexMark } from './HexMark'
import type { DiscoveredHost } from '@/lib/api'

/**
 * The picture above the introduction's words.
 *
 * Built from the same few pieces on every page, which move rather than being
 * swapped: tiles for the computer and this device, in the style of app
 * icons; files of every kind as small cards; a line between the tiles with light running
 * along it; rings while the network is searched.
 *
 * Everything is placed on a 360 by 200 grid around one centre line, and every
 * caption sits on the same baseline, so whatever is on screen is balanced.
 * Monochrome, like the rest of the app: emphasis is light, never colour.
 */

const W = 360
const H = 210
const CX = W / 2
/** Where the tiles' centres sit. */
const ROW = 100
/** The tiles' half-width. */
const R = 30
/** Left and right tile positions, an equal distance either side of the centre. */
const LEFT = CX - 92
const RIGHT = CX + 92
/** Caption baselines, under every tile alike. */
const TITLE_Y = ROW + R + 22
const SUB_Y = TITLE_Y + 13

/** How much of either side is left out of view: only empty dots are there. */
const VIEW_X = 40

const SPRING = { type: 'spring', stiffness: 140, damping: 22, mass: 0.9 } as const
const EASE = [0.22, 1, 0.36, 1] as const

export function OnboardingScene({
  step,
  phone,
  hosts,
}: {
  step: number
  phone: boolean
  hosts: DiscoveredHost[] | null
}): React.JSX.Element {
  const uid = useId().replace(/:/g, '')
  const id = (name: string): string => `${uid}-${name}`

  const searching = step === 4
  const found = hosts !== null && hosts.length > 0

  // Where each piece is on this page.
  const hub = step === 0
  const pcShown = step >= 1 && step <= 3 ? true : searching && found
  const pcX = step === 1 ? CX : LEFT
  const deviceShown = step >= 2
  const deviceX = searching && !found ? CX : RIGHT
  const linked = step === 2 || step === 3 || (searching && found)
  const paired = step === 3 || (searching && found)

  const pcTitle = searching
    ? found
      ? hosts.length === 1
        ? hosts[0]!.hostName
        : `${hosts.length} computers`
      : ''
    : step >= 2
      ? 'Basalt Host'
      : 'Your computer'
  const pcSub = searching ? 'BASALT HOST' : step >= 2 ? 'ON YOUR COMPUTER' : 'YOUR FILES STAY HERE'
  const deviceTitle = 'Basalt'
  const deviceSub = phone ? 'THIS PHONE' : 'THIS COMPUTER'
  // While searching, the rings say it, and the words below; a caption under
  // the tile would sit across the rings.
  const deviceCaptioned = !(searching && !found)

  return (
    <svg
      // Cropped to what is drawn: the outer ring's edge either side.
      viewBox={`${VIEW_X} 0 ${W - VIEW_X * 2} ${H}`}
      className="block h-full max-h-[330px] w-full"
      role="img"
      aria-label="Basalt Host on your computer, sharing its drive with this device"
    >
      <defs>
        {/* A fine grid of dots, fading out from the middle. */}
        <pattern id={id('dots')} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="0.7" fill="#ffffff" fillOpacity="0.09" />
        </pattern>
        <radialGradient id={id('fade')} cx="50%" cy="46%" r="55%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <mask id={id('vignette')}>
          <rect width={W} height={H} fill={`url(#${id('fade')})`} />
        </mask>

        {/* Light under whatever is in focus. */}
        <radialGradient id={id('glow')}>
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.11" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>

        {/* The tiles. */}
        <linearGradient id={id('tile')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#26262b" />
          <stop offset="100%" stopColor="#161618" />
        </linearGradient>
        <linearGradient id={id('edge')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="50%" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <filter id={id('shadow')} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="10" stdDeviation="9" floodColor="#000000" floodOpacity="0.55" />
        </filter>

        {/* The posters. */}
        {ITEMS.map((p, i) => (
          <linearGradient key={i} id={id(`item-${i}`)} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor={p.top} />
            <stop offset="100%" stopColor={p.bottom} />
          </linearGradient>
        ))}

        {/* The light that runs along the line. */}
        <linearGradient id={id('beam')} gradientUnits="userSpaceOnUse" x1={LEFT} y1={ROW} x2={LEFT + 90} y2={ROW}>
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          <animate attributeName="x1" values={`${LEFT - 60};${RIGHT}`} dur="2.2s" repeatCount="indefinite" />
          <animate attributeName="x2" values={`${LEFT + 30};${RIGHT + 90}`} dur="2.2s" repeatCount="indefinite" />
        </linearGradient>

        <radialGradient id={id('ringfade')} cx="50%" cy="50%" r="50%">
          <stop offset="62%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <mask id={id('rings')}>
          <circle cx={CX} cy={ROW} r={104} fill={`url(#${id('ringfade')})`} />
        </mask>
      </defs>

      <rect width={W} height={H} fill={`url(#${id('dots')})`} mask={`url(#${id('vignette')})`} />

      {/* Searching: rings from this device, fading before they reach an edge. */}
      <AnimatePresence>
        {searching && !found && (
          <motion.g
            key="rings"
            mask={`url(#${id('rings')})`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            {[0, 1, 2, 3].map((i) => (
              <motion.circle
                key={i}
                cx={CX}
                cy={ROW}
                r={46 + i * 20}
                fill="#ffffff"
                fillOpacity={0.012}
                stroke="#ffffff"
                strokeOpacity={0.16 - i * 0.035}
                strokeWidth={1}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                animate={{ scale: [1, 0.94, 1] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
              />
            ))}
            {/* One wave moving outward, so the search reads as active. */}
            <motion.circle
              cx={CX}
              cy={ROW}
              fill="none"
              stroke="#ffffff"
              strokeWidth={1.2}
              initial={{ r: 38, strokeOpacity: 0.5 }}
              animate={{ r: 104, strokeOpacity: 0 }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeOut' }}
            />
          </motion.g>
        )}
      </AnimatePresence>

      {/* The first page: the mark, with files on a slowly turning ring. */}
      <motion.g
        initial={false}
        animate={{ opacity: hub ? 1 : 0 }}
        transition={{ duration: 0.4 }}
        style={{ pointerEvents: 'none' }}
      >
        <motion.circle
          cx={CX}
          cy={ROW}
          r={74}
          fill="none"
          stroke="#ffffff"
          strokeOpacity={0.12}
          strokeDasharray="1.5 5"
          strokeLinecap="round"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          animate={{ rotate: 360 }}
          transition={{ duration: 60, repeat: Infinity, ease: 'linear' }}
        />
        <circle cx={CX} cy={ROW} r={108} fill="none" stroke="#ffffff" strokeOpacity={0.05} />
      </motion.g>

      {/* Light under the tiles in view. */}
      <motion.ellipse
        rx={44}
        ry={38}
        fill={`url(#${id('glow')})`}
        initial={false}
        animate={{ cx: hub ? CX : pcShown && !deviceShown ? CX : pcShown ? LEFT : deviceX, cy: ROW + 6 }}
        transition={SPRING}
      />
      <motion.ellipse
        rx={44}
        ry={38}
        fill={`url(#${id('glow')})`}
        initial={false}
        animate={{ cx: deviceX, cy: ROW + 6, opacity: deviceShown && pcShown ? 1 : 0 }}
        transition={SPRING}
      />

      {/* The line between them, and the light running along it. */}
      <motion.g initial={false} animate={{ opacity: linked ? 1 : 0 }} transition={{ duration: 0.3, delay: linked ? 0.3 : 0 }}>
        <motion.line
          x1={LEFT + R + 8}
          y1={ROW}
          x2={RIGHT - R - 8}
          y2={ROW}
          stroke="#ffffff"
          strokeOpacity={0.14}
          strokeWidth={1.5}
          strokeLinecap="round"
          initial={false}
          animate={{ pathLength: linked ? 1 : 0 }}
          transition={{ duration: 0.6, ease: EASE, delay: linked ? 0.3 : 0 }}
        />
        <line
          x1={LEFT + R + 8}
          y1={ROW}
          x2={RIGHT - R - 8}
          y2={ROW}
          stroke={`url(#${id('beam')})`}
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* The ends, so the line is fixed to something. */}
        <circle cx={LEFT + R + 8} cy={ROW} r={2.2} fill="#ffffff" fillOpacity={0.5} />
        <circle cx={RIGHT - R - 8} cy={ROW} r={2.2} fill="#ffffff" fillOpacity={0.5} />
      </motion.g>

      {/* The PIN, over the line, a digit at a time. */}
      <AnimatePresence>
        {step === 3 && <Pin key="pin" />}
      </AnimatePresence>

      {/* Files: on the ring, then fanned out of the computer, then put away in it. */}
      {ITEMS.map((p, i) => {
        const fanned = step === 1 && p.fan !== null
        const x = hub ? CX + p.ring[0] : fanned ? CX + p.fan![0] : pcX
        const y = hub ? ROW + p.ring[1] : fanned ? ROW + p.fan![1] : ROW
        const shown = hub || fanned
        return (
          <motion.g
            key={i}
            initial={false}
            animate={{
              x,
              y,
              rotate: hub ? p.tilt : fanned ? p.fan![2] : 0,
              scale: shown ? 1 : 0.4,
              opacity: shown ? 1 : 0,
            }}
            transition={{ ...SPRING, delay: fanned ? 0.12 + i * 0.04 : 0 }}
          >
            <motion.g
              animate={hub ? { y: [0, -3, 0] } : { y: 0 }}
              transition={hub ? { duration: 3 + i * 0.35, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.3 }}
            >
              <ItemCard index={i} id={id} />
            </motion.g>
          </motion.g>
        )
      })}

      {/* The mark, on the first page. */}
      <Tile
        id={id}
        x={CX}
        shown={hub}
        size={1.25}
        icon={<HexMark size={30} className="text-white" />}
      />

      {/* The computer with the files. */}
      <Tile
        id={id}
        x={pcX}
        shown={pcShown}
        icon={<Monitor width={26} height={26} strokeWidth={1.5} color="#f4f4f5" />}
        badge={step >= 2 && pcShown ? 'host' : null}
        title={pcTitle}
        sub={pcSub}
      />

      {/* This device. */}
      <Tile
        id={id}
        x={deviceX}
        shown={deviceShown}
        icon={
          phone ? (
            <Smartphone width={26} height={26} strokeWidth={1.5} color="#f4f4f5" />
          ) : (
            <Laptop width={26} height={26} strokeWidth={1.5} color="#f4f4f5" />
          )
        }
        badge={paired ? 'paired' : null}
        title={deviceCaptioned ? deviceTitle : ''}
        sub={deviceCaptioned ? deviceSub : ''}
      />
    </svg>
  )
}

/** One of the app-icon tiles, with its caption. */
function Tile({
  id,
  x,
  shown,
  size = 1,
  icon,
  badge = null,
  title,
  sub,
}: {
  id: (name: string) => string
  x: number
  shown: boolean
  size?: number
  icon: React.ReactNode
  badge?: 'host' | 'paired' | null
  title?: string
  sub?: string
}): React.JSX.Element {
  const half = R * size
  return (
    <motion.g
      initial={false}
      animate={{ x, y: ROW, opacity: shown ? 1 : 0, scale: shown ? 1 : 0.82 }}
      transition={SPRING}
      style={{ pointerEvents: 'none' }}
    >
      <rect
        x={-half}
        y={-half}
        width={half * 2}
        height={half * 2}
        rx={half * 0.56}
        fill={`url(#${id('tile')})`}
        filter={`url(#${id('shadow')})`}
      />
      <rect
        x={-half + 0.5}
        y={-half + 0.5}
        width={half * 2 - 1}
        height={half * 2 - 1}
        rx={half * 0.56 - 0.5}
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.09}
      />
      {/* A lit top edge, as on a real object under a light. */}
      <line
        x1={-half + half * 0.5}
        y1={-half + 0.6}
        x2={half - half * 0.5}
        y2={-half + 0.6}
        stroke={`url(#${id('edge')})`}
        strokeWidth={1}
      />
      <g transform={`translate(${-13 * (size > 1 ? 1.15 : 1)} ${-13 * (size > 1 ? 1.15 : 1)})`}>{icon}</g>

      <AnimatePresence>
        {badge && (
          <motion.g
            key={badge}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={{ ...SPRING, delay: badge === 'paired' ? 1.5 : 0.35 }}
            style={{ x: half - 3, y: -half + 3 }}
          >
            <circle r={9.5} fill="#0b0b0c" />
            <circle r={8} fill="#f4f4f5" />
            {badge === 'host' ? (
              <g transform="translate(-6 -6)">
                <HexMark size={12} className="text-black" />
              </g>
            ) : (
              <path
                d="M -3.4 0.2 L -1 2.6 L 3.6 -2.4"
                fill="none"
                stroke="#0b0b0c"
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </motion.g>
        )}
      </AnimatePresence>

      {title !== undefined && title !== '' && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.g
            key={`${title}|${sub}`}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.2 }}
          >
            <text
              y={TITLE_Y - ROW}
              textAnchor="middle"
              className="font-sans"
              fontSize={11.5}
              fontWeight={600}
              fill="#f4f4f5"
            >
              {title.length > 20 ? `${title.slice(0, 19)}…` : title}
            </text>
            {sub && (
              <text
                y={SUB_Y - ROW}
                textAnchor="middle"
                className="font-mono"
                fontSize={7.5}
                letterSpacing={1.4}
                fill="#6e6e75"
              >
                {sub}
              </text>
            )}
          </motion.g>
        </AnimatePresence>
      )}
    </motion.g>
  )
}

/**
 * What is on the drive: not only films. Each kind is drawn as the thing
 * itself, small and plain: a film's card with its initials (as the library
 * draws a film with no artwork), a photo, a record, a page, a folder, a
 * video. `ring` is its place on the first page, `fan` its place spread out
 * above the computer (three of them), with the angle it leans at.
 */
type Kind = 'film' | 'photo' | 'music' | 'doc' | 'folder' | 'video'

const ITEMS: Array<{
  kind: Kind
  top: string
  bottom: string
  tilt: number
  ring: [number, number]
  fan: [number, number, number] | null
}> = [
  { kind: 'photo', top: '#3a3a40', bottom: '#18181b', tilt: -10, ring: [-76, -2], fan: [-34, -40, -13] },
  { kind: 'film', top: '#3b3833', bottom: '#171614', tilt: 6, ring: [-40, -64], fan: [0, -50, 0] },
  { kind: 'music', top: '#2f2f36', bottom: '#131315', tilt: -6, ring: [44, -62], fan: [34, -40, 13] },
  { kind: 'doc', top: '#38383d', bottom: '#1a1a1d', tilt: 8, ring: [76, 4], fan: null },
  { kind: 'folder', top: '#34343a', bottom: '#17171a', tilt: -5, ring: [-32, 66], fan: null },
  { kind: 'video', top: '#363431', bottom: '#151413', tilt: 6, ring: [36, 66], fan: null },
]

function ItemCard({ index, id }: { index: number; id: (name: string) => string }): React.JSX.Element {
  const item = ITEMS[index]!
  const fill = `url(#${id(`item-${index}`)})`
  const clip = id(`clip-${index}`)
  const edge = { fill: 'none', stroke: '#ffffff', strokeOpacity: 0.12, strokeWidth: 0.6 }

  switch (item.kind) {
    case 'film':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <rect x={-12} y={-17} width={24} height={34} rx={3} fill={fill} />
          <text
            y={3}
            textAnchor="middle"
            className="font-display"
            fontSize={8.5}
            fontWeight={700}
            letterSpacing={0.3}
            fill="#ffffff"
            fillOpacity={0.45}
          >
            TL
          </text>
          <rect x={-12} y={-17} width={24} height={34} rx={3} {...edge} />
        </g>
      )
    case 'photo':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <clipPath id={clip}>
            <rect x={-16} y={-12} width={32} height={24} rx={3} />
          </clipPath>
          <g clipPath={`url(#${clip})`}>
            <rect x={-16} y={-12} width={32} height={24} fill={fill} />
            <circle cx={8} cy={-4} r={3.2} fill="#ffffff" fillOpacity={0.55} />
            <path d="M -16 9 L -7 0 L -1 5 L 5 -1 L 16 8 L 16 12 L -16 12 Z" fill="#000000" fillOpacity={0.4} />
          </g>
          <rect x={-16} y={-12} width={32} height={24} rx={3} {...edge} />
        </g>
      )
    case 'music':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <rect x={-13} y={-13} width={26} height={26} rx={4} fill={fill} />
          {/* A record in its sleeve. */}
          <circle r={8.5} fill="#0e0e10" />
          <circle r={6} fill="none" stroke="#ffffff" strokeOpacity={0.1} strokeWidth={0.5} />
          <circle r={2.6} fill="#ffffff" fillOpacity={0.6} />
          <rect x={-13} y={-13} width={26} height={26} rx={4} {...edge} />
        </g>
      )
    case 'doc':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <path d="M -11 -15 H 4 L 11 -8 V 13 Q 11 15 9 15 H -9 Q -11 15 -11 13 V -13 Q -11 -15 -9 -15 Z" fill={fill} />
          <path d="M 4 -15 V -10 Q 4 -8 6 -8 H 11 Z" fill="#ffffff" fillOpacity={0.18} />
          <rect x={-7} y={-3} width={14} height={1.6} rx={0.8} fill="#ffffff" fillOpacity={0.4} />
          <rect x={-7} y={1.5} width={14} height={1.6} rx={0.8} fill="#ffffff" fillOpacity={0.28} />
          <rect x={-7} y={6} width={9} height={1.6} rx={0.8} fill="#ffffff" fillOpacity={0.28} />
          <path d="M -11 -15 H 4 L 11 -8 V 13 Q 11 15 9 15 H -9 Q -11 15 -11 13 V -13 Q -11 -15 -9 -15 Z" {...edge} />
        </g>
      )
    case 'folder':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <path d="M -16 -9 Q -16 -12 -13 -12 H -5 L -2 -9 H 13 Q 16 -9 16 -6 V 9 Q 16 12 13 12 H -13 Q -16 12 -16 9 Z" fill={fill} />
          <line x1={-15} y1={-5.5} x2={15} y2={-5.5} stroke="#ffffff" strokeOpacity={0.14} strokeWidth={0.6} />
          <path d="M -16 -9 Q -16 -12 -13 -12 H -5 L -2 -9 H 13 Q 16 -9 16 -6 V 9 Q 16 12 13 12 H -13 Q -16 12 -16 9 Z" {...edge} />
        </g>
      )
    case 'video':
      return (
        <g filter={`url(#${id('shadow')})`}>
          <rect x={-16} y={-10} width={32} height={20} rx={3} fill={fill} />
          <circle r={5.5} fill="#ffffff" fillOpacity={0.14} />
          <path d="M -1.6 -2.8 L 3 0 L -1.6 2.8 Z" fill="#ffffff" fillOpacity={0.8} />
          <rect x={-12} y={6} width={24} height={1.2} rx={0.6} fill="#ffffff" fillOpacity={0.15} />
          <rect x={-12} y={6} width={9} height={1.2} rx={0.6} fill="#ffffff" fillOpacity={0.6} />
          <rect x={-16} y={-10} width={32} height={20} rx={3} {...edge} />
        </g>
      )
  }
}

/** The six digits, over the line, as the host shows them. */
function Pin(): React.JSX.Element {
  const digits = '418207'
  const cell = 10.5
  const gap = 2.5
  const split = 6
  const width = digits.length * cell + (digits.length - 1) * gap + split + 18
  const left = CX - width / 2
  return (
    <motion.g
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.35, ease: EASE, delay: 0.2 }}
    >
      <rect x={left} y={ROW - 56} width={width} height={24} rx={8} fill="#141416" stroke="#ffffff" strokeOpacity={0.12} />
      {/* A short stem down to the line, so the code belongs to it. */}
      <line x1={CX} y1={ROW - 32} x2={CX} y2={ROW - 6} stroke="#ffffff" strokeOpacity={0.14} strokeDasharray="2 3" />
      {digits.split('').map((d, i) => {
        const x = left + 9 + i * (cell + gap) + (i >= 3 ? split : 0) + cell / 2
        return (
          <motion.text
            key={i}
            x={x}
            y={ROW - 40.5}
            textAnchor="middle"
            className="font-mono"
            fontSize={10}
            fontWeight={500}
            fill="#f4f4f5"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 + i * 0.13, duration: 0.22 }}
          >
            {d}
          </motion.text>
        )
      })}
    </motion.g>
  )
}
