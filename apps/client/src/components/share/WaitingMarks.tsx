import { isAndroid } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * What waiting looks like while sharing (1.6.4), drawn for each wait rather
 * than one spinner for all: the offer on its way to the other device and
 * waiting there, this device joining another's Wi-Fi, and looking around.
 * Each is in the text colour, so it sits on any surface; with reduced
 * motion asked for, each stands still.
 */

type Form = 'phone' | 'computer'

/** How a device's kind is drawn; `null` is this device. */
export function markForm(form: string | null | undefined): Form {
  if (form === null) return isAndroid() ? 'phone' : 'computer'
  return form === 'phone' || form === 'tablet' || form === undefined ? 'phone' : 'computer'
}

/** A device, drawn small: a phone upright, or a computer's screen on its stand. */
function DeviceGlyph({ form, x, y }: { form: Form; x: number; y: number }): React.JSX.Element {
  if (form === 'computer') {
    return (
      <g transform={`translate(${x} ${y})`}>
        <rect x={-12} y={-9} width={24} height={16} rx={2.5} />
        <path d="M-6 11.5h12" />
      </g>
    )
  }
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-8} y={-12} width={16} height={24} rx={3.5} />
      <path d="M-2.5 8.5h5" />
    </g>
  )
}

/**
 * The offer on its way and waiting: a light goes over from this device to
 * theirs, again and again, and theirs answers with a ring each time it lands.
 */
export function HandoffMark({
  from = 'phone',
  to = 'phone',
  className,
}: {
  from?: Form
  to?: Form
  className?: string
}): React.JSX.Element {
  const arc = 'M27 30 Q48 8 69 30'
  return (
    <svg
      viewBox="0 0 96 48"
      className={cn('handoff-mark h-12 w-24', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={arc} strokeDasharray="0.1 5" strokeWidth={1.6} className="opacity-30" />
      <g className="opacity-55">
        <DeviceGlyph form={from} x={14} y={30} />
      </g>
      <circle cx={82} cy={30} r={15} className="handoff-ring" strokeWidth={1.2} />
      <g className="handoff-to">
        <DeviceGlyph form={to} x={82} y={30} />
      </g>
      {[0, 0.12, 0.22].map((delay, i) => (
        <circle key={delay} r={i === 0 ? 2.8 : i === 1 ? 2 : 1.4} fill="currentColor" stroke="none" className="handoff-light" opacity={i === 0 ? 1 : i === 1 ? 0.5 : 0.25}>
          <animateMotion dur="1.8s" begin={`${delay}s`} repeatCount="indefinite" path={arc} keyPoints="0;1;1" keyTimes="0;0.62;1" calcMode="spline" keySplines="0.45 0 0.3 1;0 0 1 1" />
        </circle>
      ))}
    </svg>
  )
}

/** Joining a device's own Wi-Fi: the arcs light one after another, outwards. */
export function JoiningMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 48 40"
      className={cn('joining-mark h-11 w-[53px]', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx={24} cy={33} r={2.6} fill="currentColor" stroke="none" className="joining-dot" />
      <path d="M17.5 26.5a9.2 9.2 0 0 1 13 0" className="joining-arc joining-arc-1" />
      <path d="M11.5 20.5a17.7 17.7 0 0 1 25 0" className="joining-arc joining-arc-2" />
      <path d="M5.5 14.5a26.2 26.2 0 0 1 37 0" className="joining-arc joining-arc-3" />
    </svg>
  )
}

/** Looking around: three dots in a slow wave, for a line of text to sit beside. */
export function LookingDots({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={cn('looking-dots inline-flex shrink-0 items-center gap-[3px]', className)} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  )
}
