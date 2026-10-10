import { motion } from 'framer-motion'
import { HardDrive, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Connected to a host that shares nothing yet.
 *
 * Where a host set up from this device lands: it has a name and a manager and
 * no drive. For the device that manages it this is one button away from done;
 * for anyone else it says who has to do what, rather than showing an empty
 * folder that looks broken.
 */
export function NoDrive({
  hostName,
  canManage,
  onManage,
  large = false,
}: {
  hostName: string
  canManage: boolean
  /** Opens Manage host on its drive step. */
  onManage: () => void
  /** The phone's sizes. */
  large?: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-w-[380px] flex-col items-center text-center"
      >
        <span
          className={cn(
            'flex items-center justify-center bg-white/[0.06] text-textDim',
            large ? 'h-16 w-16 rounded-2xl' : 'h-12 w-12 rounded-xl',
          )}
        >
          <HardDrive size={large ? 26 : 20} />
        </span>
        <h2 className={cn('mt-4 font-semibold tracking-tight text-text', large ? 'text-[20px]' : 'text-[16px]')}>
          {hostName} isn’t sharing anything yet
        </h2>
        <p className={cn('mt-2 leading-relaxed text-textDim', large ? 'text-[14px]' : 'text-[12.5px]')}>
          {canManage
            ? 'Choose the drive or folder to share. Its files then open here, and on every device you pair.'
            : 'The device that manages this host chooses what it shares. This screen opens the drive as soon as it does.'}
        </p>
        {canManage && (
          <button
            onClick={onManage}
            className={cn(
              'mt-5 flex items-center justify-center gap-2 bg-basalt font-medium text-ink transition-opacity hover:opacity-90 active:opacity-80',
              large ? 'h-12 rounded-xl px-6 text-[15px]' : 'h-9 rounded-md px-4 text-[13px]',
            )}
          >
            <SlidersHorizontal size={large ? 17 : 14} />
            Choose what it shares
          </button>
        )}
      </motion.div>
    </div>
  )
}
