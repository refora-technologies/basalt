import { AnimatePresence, motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The pieces the host window is built from: the same panels, rows and tags
 * as Manage host in the Basalt app (`components/manage/parts.tsx` there), so
 * the host reads the same wherever it is managed from.
 */

/** A titled panel: its title in a header bar, its rows under it. */
export function Group({
  icon: Icon,
  title,
  aside,
  action,
  children,
}: {
  icon: LucideIcon
  title: string
  /** Quiet words at the header's end: "2 of 3 connected". */
  aside?: React.ReactNode
  /** A control at the header's end, after `aside`. */
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="glass overflow-hidden rounded-lg">
      <div className="flex min-h-[46px] items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Icon size={15} className="shrink-0 text-textDim" />
        <h2 className="text-sm font-semibold tracking-tight text-text">{title}</h2>
        <span className="ml-auto flex items-center gap-3">
          {aside && <span className="tnum text-[11px] text-textFaint">{aside}</span>}
          {action}
        </span>
      </div>
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  )
}

/**
 * One setting: what it is, a line saying what it does now, and its control.
 * Clicking the words flips a switch too, as clicking a label does anywhere.
 */
export function SettingRow({
  icon,
  title,
  detail,
  control,
  warn,
  extra,
  onToggle,
  sub,
}: {
  icon?: React.ReactNode
  title: string
  detail?: string
  control?: React.ReactNode
  warn?: boolean
  /** Under the row, across it, for what the row itself cannot hold. */
  extra?: React.ReactNode
  onToggle?: () => void
  /** A step under another setting: indented, smaller. */
  sub?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('px-4 py-3', sub && 'pl-8')}>
      <div className="flex items-start gap-3">
      {icon && (
        <span className="mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-textDim">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div onClick={onToggle} className={onToggle ? 'cursor-pointer select-none' : undefined}>
          <div className={cn('text-text', sub ? 'text-[12.5px]' : 'text-[13px]')}>{title}</div>
          {detail && (
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={detail}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className={cn(
                  'mt-0.5 text-[11.5px] leading-snug',
                  warn ? 'text-danger' : 'text-textFaint',
                )}
              >
                {detail}
              </motion.p>
            </AnimatePresence>
          )}
        </div>
      </div>
      {control && <div className="mt-0.5 shrink-0">{control}</div>}
      </div>
      {/* Across the whole row, under the words and the control both. */}
      {extra && <div className={cn(icon && 'pl-11')}>{extra}</div>}
    </div>
  )
}

/** A row that does something when clicked: "Scan again", "Add a profile". */
export function ActionRow({
  icon,
  title,
  detail,
  onClick,
  disabled,
  end,
}: {
  icon: React.ReactNode
  title: string
  detail?: string
  onClick: () => void
  disabled?: boolean
  end?: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-textDim">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-text">{title}</span>
        {detail && <span className="mt-0.5 block text-[11.5px] leading-snug text-textFaint">{detail}</span>}
      </span>
      {end}
    </button>
  )
}

/** A small label on a row: "manages", "read only". */
export function Tag({
  children,
  icon,
  title,
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-[5px] border border-white/15 bg-white/[0.04] px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-textDim"
    >
      {icon}
      {children}
    </span>
  )
}

/** A rounded button for a secondary action. */
export function Pill({
  children,
  onClick,
  icon,
  disabled,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  icon?: React.ReactNode
  disabled?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center justify-center gap-1.5 rounded-full border border-white/[0.12] px-3.5 py-1.5 text-[12px] text-text transition-colors hover:bg-white/[0.05] disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  )
}
