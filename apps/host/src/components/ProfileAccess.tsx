import { AnimatePresence, motion } from 'framer-motion'
import { Lock, ShieldCheck, UserPlus } from 'lucide-react'
import type { ProfileRules } from '@/lib/api'
import { Switch } from './ui/Switch'
import { cn } from '@/lib/utils'

/**
 * Who may use the drive, and who may add the people who use it.
 *
 * Both rules are off by default, which is how a household drive has always
 * worked: anyone using it may add a profile, and a device may use the drive
 * as itself. Turned on together they make a drive private: everyone has a
 * profile of their own with a PIN only they know, and the owner decides who
 * those people are.
 *
 * The host enforces both. What devices offer only follows: a device that
 * tried anyway is refused here.
 */
export function ProfileAccess({
  rules,
  profileCount,
  error,
  onRequireProfile,
  onOwnerAddsProfiles,
}: {
  rules: ProfileRules
  profileCount: number
  /** What the last change was refused for, said under the card. */
  error: string | null
  onRequireProfile: (require: boolean) => void
  onOwnerAddsProfiles: (ownerOnly: boolean) => void
}): React.JSX.Element {
  // A drive nobody could open is not a setting anyone means.
  const cannotRequire = profileCount === 0 && !rules.requireProfile
  const private_ = rules.requireProfile && rules.ownerAddsProfiles

  return (
    <div className="mb-3">
      <div className="rounded-lg glass divide-y divide-line">
        <div className="flex items-start gap-3.5 px-5 py-4">
          <RuleIcon on={rules.requireProfile}>
            <Lock size={14} />
          </RuleIcon>
          <div
            className={cn('min-w-0 flex-1', !cannotRequire && 'cursor-pointer select-none')}
            onClick={cannotRequire ? undefined : () => onRequireProfile(!rules.requireProfile)}
          >
            <div className="text-[13px] font-medium text-text">Require a profile</div>
            <Detail
              text={
                cannotRequire
                  ? 'Add a profile first. With none, nobody could sign in.'
                  : rules.requireProfile
                    ? 'Every device signs in to a profile. Nobody uses the drive as just a device.'
                    : 'Devices can also continue as themselves, keeping their own history and stars.'
              }
            />
          </div>
          <div className="mt-0.5 shrink-0">
            <Switch
              checked={rules.requireProfile}
              onChange={onRequireProfile}
              disabled={cannotRequire}
              label="Require a profile"
            />
          </div>
        </div>

        <div className="flex items-start gap-3.5 px-5 py-4">
          <RuleIcon on={rules.ownerAddsProfiles}>
            <UserPlus size={14} />
          </RuleIcon>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[13px] font-medium text-text">Who can add profiles</div>
              <Segmented
                value={rules.ownerAddsProfiles ? 'host' : 'anyone'}
                options={[
                  { value: 'anyone', label: 'Anyone using the drive' },
                  { value: 'host', label: 'Only this host' },
                ]}
                onChange={(value) => onOwnerAddsProfiles(value === 'host')}
              />
            </div>
            <Detail
              text={
                rules.ownerAddsProfiles
                  ? 'Profiles are added here. Each person chooses their own PIN the first time they sign in.'
                  : 'A new profile can be made from any paired device, by whoever is using it.'
              }
            />
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {(private_ || error) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {error ? (
              <p className="px-1 pt-2 text-[11.5px] text-danger">{error}</p>
            ) : (
              <p className="flex items-center gap-1.5 px-1 pt-2 text-[11.5px] text-textDim">
                <ShieldCheck size={13} className="shrink-0 text-basalt" />
                A private drive: only the people you add here can use it, each with their own PIN.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function RuleIcon({ on, children }: { on: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className={cn(
        'mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors duration-200',
        on ? 'border-white/20 bg-white/[0.08] text-text' : 'border-line bg-panel2 text-textFaint',
      )}
    >
      {children}
    </span>
  )
}

function Detail({ text }: { text: string }): React.JSX.Element {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.p
        key={text}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="mt-1 text-[11.5px] leading-relaxed text-textFaint"
      >
        {text}
      </motion.p>
    </AnimatePresence>
  )
}

/**
 * Two choices side by side, the chosen one lit. The light slides between
 * them rather than jumping, so the change reads as a change.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" className="flex shrink-0 rounded-md border border-line bg-ink2 p-0.5">
      {options.map((option) => {
        const on = option.value === value
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={on}
            onClick={() => !on && onChange(option.value)}
            className={cn(
              'relative rounded-[5px] px-3 py-1 text-[11.5px] transition-colors duration-150',
              on ? 'text-ink' : 'text-textDim hover:text-text',
            )}
          >
            {on && (
              <motion.span
                layoutId="profile-access-choice"
                transition={{ type: 'spring', stiffness: 520, damping: 38 }}
                className="absolute inset-0 rounded-[5px] bg-basalt"
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}
