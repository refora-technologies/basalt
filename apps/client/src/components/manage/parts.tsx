import { createContext, useContext, useEffect, useState } from 'react'
import { ChevronRight, Loader2, type LucideIcon } from 'lucide-react'
import { profileColor } from '@/lib/useIdentity'
import { cn } from '@/lib/utils'

/**
 * The pieces "Manage host" is built from, sized for where it is shown.
 *
 * One set of pieces for the phone and the computer, so the two say the same
 * things in the same order; only their size changes. A phone gets the larger
 * type and taller rows a thumb needs, a computer the denser layout of the rest
 * of its settings.
 */

export type Layout = 'phone' | 'desktop'

export const LayoutContext = createContext<Layout>('phone')

export function useLayout(): Layout {
  return useContext(LayoutContext)
}

/** A heading over a group of cards, in the small capitals the app uses. */
export function GroupLabel({
  children,
  aside,
}: {
  children: React.ReactNode
  aside?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between px-1 pb-2">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-textFaint">
        {children}
      </span>
      {aside && <span className="font-mono text-[10.5px] text-textFaint">{aside}</span>}
    </div>
  )
}

/**
 * A titled group of settings. On a phone, a label over a card, as the rest of
 * its More tab is; on a computer, a panel with its title in a header bar, as
 * its Settings are.
 */
export function Group({
  icon: Icon,
  title,
  aside,
  children,
  tone,
}: {
  icon: LucideIcon
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
  tone?: 'plain' | 'raised'
}): React.JSX.Element {
  const layout = useLayout()
  if (layout === 'phone') {
    return (
      <section>
        <GroupLabel aside={aside}>{title}</GroupLabel>
        <Card tone={tone}>{children}</Card>
      </section>
    )
  }
  return (
    <section className="glass overflow-hidden rounded-lg">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <Icon size={15} className="text-textDim" />
        <span className="text-sm font-semibold tracking-tight text-text">{title}</span>
        {aside && <span className="tnum ml-auto text-[11px] text-textFaint">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** A fact, not a setting: what it is, and its value. */
export function Fact({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}): React.JSX.Element {
  const layout = useLayout()
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 px-4',
        layout === 'phone' ? 'py-3.5' : 'py-2.5',
      )}
    >
      <span className={cn('shrink-0 text-textDim', layout === 'phone' ? 'text-[14px]' : 'text-[12.5px]')}>
        {label}
      </span>
      <span
        className={cn(
          'tnum min-w-0 text-right text-text',
          mono ? 'font-mono text-[12px]' : layout === 'phone' ? 'text-[14px]' : 'text-[12.5px]',
        )}
      >
        {value}
      </span>
    </div>
  )
}

export function Card({
  children,
  tone = 'plain',
  className,
}: {
  children: React.ReactNode
  /** `raised` stands out (a device waiting to join), `danger` warns. */
  tone?: 'plain' | 'raised' | 'danger'
  className?: string
}): React.JSX.Element {
  const layout = useLayout()
  return (
    <div
      className={cn(
        'overflow-hidden border',
        layout === 'phone' ? 'rounded-2xl' : 'rounded-lg',
        tone === 'plain' && 'border-white/[0.07] bg-[#141416]',
        tone === 'raised' && 'border-white/[0.16] bg-[#1a1a1d] shadow-lift',
        tone === 'danger' && 'border-danger/25 bg-dangerBg',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Rows inside a card, with hairlines between them. */
export function Rows({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="divide-y divide-white/[0.05]">{children}</div>
}

/**
 * One line of a card: what it is, a line under it, and what is at its end.
 * Tappable when it opens something, with a chevron saying so.
 */
export function Row({
  icon,
  title,
  sub,
  end,
  onClick,
  chevron,
  danger,
  disabled,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  sub?: React.ReactNode
  end?: React.ReactNode
  onClick?: () => void
  chevron?: boolean
  danger?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const layout = useLayout()
  const Element = onClick ? 'button' : 'div'
  return (
    <Element
      type={onClick ? 'button' : undefined}
      onClick={disabled ? undefined : onClick}
      disabled={onClick ? disabled : undefined}
      className={cn(
        'flex w-full items-center text-left',
        layout === 'phone' ? 'min-h-[60px] gap-3.5 px-4 py-3' : 'min-h-[48px] gap-3 px-4 py-2.5',
        onClick && !disabled && (layout === 'phone' ? 'active:bg-white/[0.04]' : 'hover:bg-white/[0.03]'),
        disabled && 'opacity-50',
      )}
    >
      {icon && (
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-xl',
            layout === 'phone' ? 'h-10 w-10' : 'h-8 w-8 rounded-lg',
            danger ? 'bg-danger/[0.12] text-danger' : 'bg-white/[0.05] text-textDim',
          )}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate',
            layout === 'phone' ? 'text-[15px]' : 'text-[13px]',
            danger ? 'text-danger' : 'text-text',
          )}
        >
          {title}
        </span>
        {sub && (
          <span
            className={cn(
              'mt-0.5 block leading-snug text-textFaint',
              layout === 'phone' ? 'text-[12.5px]' : 'text-[11.5px]',
            )}
          >
            {sub}
          </span>
        )}
      </span>
      {end}
      {chevron && <ChevronRight size={16} className="shrink-0 text-textFaint" />}
    </Element>
  )
}

/**
 * An on/off setting the host keeps. It moves the moment it is tapped, and
 * settles on the host's answer: back, if the host said no.
 */
export function Toggle({
  title,
  description,
  checked,
  onChange,
  ask,
  disabled,
  warn,
}: {
  title: string
  description?: React.ReactNode
  checked: boolean
  /** Resolves whether the host took it. */
  onChange: (next: boolean) => Promise<boolean> | void
  /** A question to answer first; the switch stays put until it is. */
  ask?: (next: boolean) => Promise<boolean>
  disabled?: boolean
  /** The description is a warning about the state it is in. */
  warn?: boolean
}): React.JSX.Element {
  const layout = useLayout()
  const [pending, setPending] = useState<boolean | null>(null)
  // The host's answer arrived: it is what is shown from now on.
  useEffect(() => setPending(null), [checked])
  const shown = pending ?? checked

  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      disabled={disabled}
      onClick={() => {
        const next = !shown
        void (async () => {
          if (ask && !(await ask(next))) return
          setPending(next)
          const took = await onChange(next)
          if (took === false) setPending(null)
        })()
      }}
      className={cn(
        'flex w-full items-center text-left',
        layout === 'phone' ? 'min-h-[60px] gap-4 px-4 py-3' : 'gap-4 px-4 py-3',
        layout === 'phone' ? 'active:bg-white/[0.03]' : 'hover:bg-white/[0.02]',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={cn('block text-text', layout === 'phone' ? 'text-[15px]' : 'text-[13px]')}>
          {title}
        </span>
        {description && (
          <span
            className={cn(
              'mt-0.5 block leading-snug',
              layout === 'phone' ? 'text-[12.5px]' : 'text-[11.5px]',
              warn ? 'text-danger' : 'text-textFaint',
            )}
          >
            {description}
          </span>
        )}
      </span>
      <span
        className={cn(
          'relative shrink-0 rounded-full transition-colors duration-150',
          layout === 'phone' ? 'h-[26px] w-[44px]' : 'h-[22px] w-[38px]',
          shown ? 'bg-basalt' : 'bg-white/15',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] rounded-full transition-[left,background-color] duration-150',
            layout === 'phone' ? 'h-5 w-5' : 'h-4 w-4',
            shown
              ? cn('bg-ink', layout === 'phone' ? 'left-[21px]' : 'left-[19px]')
              : 'left-[3px] bg-white/70',
          )}
        />
      </span>
    </button>
  )
}

/** A choice of a few, side by side: the chosen one lit. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  fit,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  label: string
  /** Each as wide as its words need, rather than all alike. */
  fit?: boolean
}): React.JSX.Element {
  const layout = useLayout()
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-full gap-1 rounded-full border border-white/[0.07] bg-white/[0.04] p-1"
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-w-0 truncate rounded-full px-2 transition-colors duration-150',
              fit ? 'flex-auto' : 'flex-1',
              layout === 'phone' ? 'py-2 text-[13px]' : 'py-1.5 text-[12px]',
              on ? 'bg-basalt font-medium text-ink' : 'text-textDim hover:text-text',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A rounded button for a secondary action, in a card. */
export function Pill({
  children,
  onClick,
  busy,
  disabled,
  icon,
}: {
  children: React.ReactNode
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  icon?: React.ReactNode
}): React.JSX.Element {
  const layout = useLayout()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full border border-white/[0.12] text-text transition-colors disabled:opacity-50',
        layout === 'phone' ? 'px-4 py-2.5 text-[13.5px] active:bg-white/[0.06]' : 'px-3.5 py-1.5 text-[12px] hover:bg-white/[0.05]',
      )}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

/** A small label on a row: "manages", "read only". */
export function Tag({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-white/15 bg-white/[0.04] px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-textDim">
      {icon}
      {children}
    </span>
  )
}

/** Whether a device is there now: lit when it is. */
export function Presence({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', on ? 'bg-emerald-400/80' : 'bg-white/20')}
    />
  )
}

/** A profile's round letter, in its colour. */
export function Avatar({
  name,
  color,
  size,
}: {
  name: string
  color: number
  size: number
}): React.JSX.Element {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, background: profileColor(color) }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** How long ago, as people say it: "just now", "3h ago", "12 Sep". */
export function ago(seconds: number, now = Date.now() / 1000): string {
  if (!seconds) return 'never'
  const gone = Math.max(0, now - seconds)
  if (gone < 60) return 'just now'
  if (gone < 3600) return `${Math.floor(gone / 60)}m ago`
  if (gone < 86400) return `${Math.floor(gone / 3600)}h ago`
  if (gone < 86400 * 7) return `${Math.floor(gone / 86400)}d ago`
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
