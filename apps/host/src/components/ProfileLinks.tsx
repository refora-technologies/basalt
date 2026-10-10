import { AnimatePresence, motion } from 'framer-motion'
import { Check, X } from 'lucide-react'
import type { LinkView } from '@/lib/api'
import { Avatar } from './ProfileList'

/**
 * Profiles from other drives asking to be let in here.
 *
 * Someone signed in to their profile on another drive (Maya, on the Living
 * Room Drive) wants to use it here too. Let in once, she is a profile here
 * like any other, with no PIN: hers is checked on her own drive, and this one
 * never sees it. Her history and stars here are this drive's.
 */
export function ProfileLinks({
  links,
  onApprove,
  onDeny,
}: {
  links: LinkView[]
  onApprove: (link: LinkView) => void
  onDeny: (link: LinkView) => void
}): React.JSX.Element {
  return (
    <AnimatePresence initial={false}>
      {links.map((link) => (
        <motion.div
          key={link.id}
          layout
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="mb-2 flex items-center gap-4 rounded-md border border-lineBright bg-panel2 p-4">
            <Avatar name={link.name} color={link.color} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold tracking-tight text-text">
                {link.name} <span className="font-normal text-textDim">from {link.home}</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-textDim">
                {link.deviceName} asks to use this profile here. It signs in on its own drive, with no
                PIN here, and keeps its own history and stars on this one.
              </div>
            </div>
            <button
              onClick={() => onDeny(link)}
              className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] text-textFaint transition-colors hover:bg-dangerBg hover:text-danger"
            >
              <X size={12} />
              Decline
            </button>
            <button
              onClick={() => onApprove(link)}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-basalt/40 bg-basalt/15 px-3 py-1.5 text-[11.5px] text-text transition-colors hover:bg-basalt/25"
            >
              <Check size={12} />
              Let in
            </button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}
