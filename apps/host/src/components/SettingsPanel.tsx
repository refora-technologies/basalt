import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, Film, Image as ImageIcon, Music, Pencil, RefreshCw, Tv, Video } from 'lucide-react'
import type { HostStatus, Sections } from '@/lib/api'
import { About } from './About'
import { ConversionPanel, conversionDetail } from './ConversionPanel'
import { Switch } from './ui/Switch'
import { cn, formatAgo } from '@/lib/utils'

/**
 * The settings this app has.
 *
 * Everything else a network share usually asks for — addresses, share names,
 * user accounts, firewall rules, permissions — is either decided by the
 * protocol or not a decision at all.
 *
 * Two of the four are off by default and say what turning them on means,
 * because both do something on the user's behalf that they did not ask for at
 * install time: one lets strangers on the network read the drive, the other
 * reads every folder on it.
 */
export function SettingsPanel({
  status,
  onRequirePin,
  onStartWithWindows,
  onLibrary,
  onRescan,
  onPosters,
  onTmdbKey,
  onSections,
  onRename,
  onConversion,
  onConversionAtOnce,
  onMeasureConversion,
  build,
  onOpenLog,
}: {
  status: HostStatus
  onRequirePin: (require: boolean) => void
  onStartWithWindows: (enabled: boolean) => void
  onLibrary: (enabled: boolean) => void
  onRescan: () => void
  onPosters: (enabled: boolean) => void
  onTmdbKey: (key: string) => void
  onSections: (sections: Sections) => void
  onRename: (name: string) => void
  onConversion: (enabled: boolean) => void
  onConversionAtOnce: (atOnce: number | null) => void
  onMeasureConversion: () => void
  /** Which build this is, for telling one install from another. */
  build: string
  onOpenLog: () => void
}): React.JSX.Element {
  const [editingName, setEditingName] = useState(false)
  const [draft, setDraft] = useState(status.hostName)

  const commitName = (): void => {
    const name = draft.trim()
    setEditingName(false)
    if (name && name !== status.hostName) onRename(name)
    else setDraft(status.hostName)
  }

  return (
    <div className="rounded-lg glass divide-y divide-line">
      <Row
        onToggle={() => onRequirePin(!status.requirePin)}
        title="Ask for a PIN when pairing"
        detail={
          status.requirePin
            ? 'A new device shows up here with a number to type. Nobody joins without being let in.'
            : 'Any device on this network can join and open the drive without a PIN.'
        }
        warn={!status.requirePin}
        control={
          <Switch
            checked={status.requirePin}
            onChange={onRequirePin}
            label="Ask for a PIN when pairing"
          />
        }
      />

      <Row
        onToggle={() => onLibrary(!status.library.enabled)}
        title="Recognise films and series"
        detail={
          status.library.enabled
            ? libraryDetail(status)
            : 'Off. Your devices see folders and files exactly as they are on the drive.'
        }
        control={
          <Switch
            checked={status.library.enabled}
            onChange={onLibrary}
            label="Recognise films and series"
          />
        }
        extra={
          status.library.enabled ? (
            <>
              <button
                onClick={onRescan}
                disabled={status.library.scanning}
                className="mt-2.5 flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] text-textFaint transition-colors hover:bg-panel2 hover:text-textDim disabled:opacity-50"
              >
                <RefreshCw size={11} className={status.library.scanning ? 'animate-spin' : ''} />
                {status.library.scanning ? 'Scanning…' : 'Scan again'}
              </button>
              <Artwork status={status} onPosters={onPosters} onSave={onTmdbKey} />
            </>
          ) : null
        }
      />

      <Row
        onToggle={
          status.conversion.available ? () => onConversion(!status.conversion.enabled) : undefined
        }
        title="Convert video for devices that can’t play it"
        detail={conversionDetail(status.conversion)}
        control={
          status.conversion.available ? (
            <Switch
              checked={status.conversion.enabled}
              onChange={onConversion}
              label="Convert video for devices that can’t play it"
            />
          ) : undefined
        }
        extra={
          <ConversionPanel
            conversion={status.conversion}
            onAtOnce={onConversionAtOnce}
            onMeasure={onMeasureConversion}
          />
        }
      />

      <Row
        title="Sections on your devices"
        detail="What each device shows under Library. Hiding a section only tidies the list. Every file is still in Files."
        extra={
          <SectionPicker
            sections={status.sections}
            library={status.library}
            onChange={onSections}
          />
        }
      />

      <Row
        onToggle={() => onStartWithWindows(!status.startWithWindows)}
        title={status.platform === 'windows' ? 'Start when Windows starts' : 'Start when you log in'}
        detail={
          status.platform === 'windows'
            ? 'Opens in the notification area at login, so the drive is there before you go looking for it.'
            : 'Opens in the background at login, so the drive is there before you go looking for it.'
        }
        control={
          <Switch
            checked={status.startWithWindows}
            onChange={onStartWithWindows}
            label={status.platform === 'windows' ? 'Start when Windows starts' : 'Start when you log in'}
          />
        }
      />

      <Row
        title="This host’s name"
        detail="What your devices see in their list, before they pair."
        control={
          editingName ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={draft}
                maxLength={48}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') {
                    setDraft(status.hostName)
                    setEditingName(false)
                  }
                }}
                onBlur={commitName}
                className="w-[160px] rounded-sm border border-lineBright bg-ink2 px-2 py-1 font-mono text-[12px] text-text outline-none"
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={commitName}
                aria-label="Save the name"
                className="rounded-sm p-1.5 text-textDim transition-colors hover:bg-panel2 hover:text-text"
              >
                <Check size={13} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setDraft(status.hostName)
                setEditingName(true)
              }}
              className="flex items-center gap-2 rounded-sm px-2 py-1 font-mono text-[12px] text-textDim transition-colors hover:bg-panel2 hover:text-text"
            >
              {status.hostName}
              <Pencil size={11} />
            </button>
          )
        }
      />

      <div className="px-5 py-3.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">
          Address
        </div>
        <div className="tnum mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px] text-textDim">
          {status.addresses.length > 0 ? (
            <>
              {/* The network the computer actually uses comes first. The
                  rest are usually adapters other software adds — VirtualBox,
                  WSL — and are shown quietly after it. */}
              <span>
                {status.addresses[0]}
                <span className="text-textFaint">:{status.port}</span>
              </span>
              {status.addresses.length > 1 && (
                <span className="text-textFaint">also {status.addresses.slice(1).join(', ')}</span>
              )}
            </>
          ) : (
            <span className="text-textFaint">No network connection</span>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-textFaint">
          {/* Shown because it is occasionally useful to know, and never
              because anyone has to type it. */}
          Only for reference. Your devices find this host by themselves, even when its
          address changes.
        </p>

        {/* Which build this is, and where it writes its log. Both exist
            because "am I running the new one?" and "where do I look when it
            misbehaves?" each cost a round trip to answer once. */}
        <div className="tnum mt-3 border-t border-line pt-3 font-mono text-[10px] text-textFaint">
          <div>{build || 'build unknown'}</div>
          <button
            onClick={onOpenLog}
            className="mt-1 underline decoration-dotted underline-offset-2 transition-colors hover:text-textDim"
          >
            open the log folder
          </button>
        </div>
      </div>

      <div id="host-about" className="scroll-mt-6">
        <About product="Basalt Host" platform={status.platform} />
      </div>
    </div>
  )
}

/**
 * What the index found, or what it is doing.
 *
 * A scan in progress says so rather than reporting zero, which would read as
 * "nothing on your drive" at exactly the moment that is least likely to be
 * true.
 */
function libraryDetail(status: HostStatus): string {
  const { scanning, films, series, uncertain, scannedAt } = status.library
  if (scanning) return 'Scanning the drive…'
  if (films === 0 && series === 0) {
    return 'Nothing recognised yet. Films and series show up in their own sections on your devices.'
  }

  const parts = [
    `${films} ${films === 1 ? 'film' : 'films'}`,
    `${series} ${series === 1 ? 'series' : 'series'}`,
  ]
  const found = `${parts.join(' and ')}, last checked ${formatAgo(scannedAt)}.`
  return uncertain > 0
    ? `${found} ${uncertain} ${uncertain === 1 ? 'is a guess' : 'are guesses'}.`
    : found
}

/**
 * The poster downloads, and the key that unlocks them.
 *
 * Folded under the library switch rather than given a row of its own, because
 * it is a refinement of that setting and meaningless without it.
 *
 * The key is never displayed once saved. The host reports whether one is set,
 * not what it is, so there is nothing here that could read it back out.
 */
function Artwork({
  status,
  onPosters,
  onSave,
}: {
  status: HostStatus
  onPosters: (enabled: boolean) => void
  onSave: (key: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const { posters, hasKey, withArt, films, series } = status.library
  const total = films + series

  return (
    <div className="mt-2.5 border-t border-line pt-2.5">
      <div className="flex items-start gap-3">
        <div
          className="min-w-0 flex-1 cursor-pointer select-none"
          onClick={() => onPosters(!posters)}
        >
          <div className="text-[12px] text-textDim">Download posters</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-textFaint">
            {/* Said plainly, because this is the actual cost of the switch and
                no key is required any more to make somebody think about it. */}
            {posters
              ? `Each recognised title is looked up online for its poster. ${withArt} of ${total} have one.`
              : 'Off. Covers are made from the title. When on, the titles of recognised films and series are sent to an online service to find their posters.'}
          </p>
        </div>
        <div className="mt-0.5 shrink-0">
          <Switch checked={posters} onChange={onPosters} label="Download posters" />
        </div>
      </div>

      {!posters ? null : !open ? (
        <button
          onClick={() => {
            setDraft('')
            setOpen(true)
          }}
          className="mt-1.5 flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] text-textFaint transition-colors hover:bg-panel2 hover:text-textDim"
        >
          <ImageIcon size={11} />
          {hasKey ? 'A TMDb key is saved' : 'Add a TMDb key to find more posters…'}
        </button>
      ) : (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="mt-1 rounded-md border border-line bg-ink2 p-3">
            <p className="text-[11px] leading-relaxed text-textFaint">
              {/* The key is genuinely optional now. Saying so matters: asking
                  for one when none is needed is how an app trains people to
                  paste credentials they were never required to have. */}
              Posters already work without this. A free TMDb key is only
              consulted for titles the default source has never heard of, so it
              widens coverage and nothing more.
            </p>
            <div className="mt-2.5 flex items-center gap-1.5">
              <input
                autoFocus
                type="password"
                value={draft}
                placeholder={hasKey ? 'A key is saved. Paste a new one to replace it.' : 'TMDb API key'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onSave(draft)
                    setOpen(false)
                  }
                  if (e.key === 'Escape') setOpen(false)
                }}
                className="min-w-0 flex-1 rounded-sm border border-line bg-panel px-2 py-1.5 font-mono text-[11.5px] text-text outline-none transition-colors placeholder:text-textFaint focus:border-lineBright"
              />
              <button
                onClick={() => {
                  onSave(draft)
                  setOpen(false)
                }}
                className="rounded-sm px-2.5 py-1.5 text-[11px] text-textDim transition-colors hover:bg-panel2 hover:text-text"
              >
                Save
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded-sm px-2 py-1.5 text-[11px] text-textFaint transition-colors hover:text-textDim"
              >
                Cancel
              </button>
            </div>
            {hasKey && (
              <button
                onClick={() => {
                  onSave('')
                  setOpen(false)
                }}
                className="mt-2 text-[10.5px] text-textFaint transition-colors hover:text-danger"
              >
                Remove the key
              </button>
            )}
          </div>
        </motion.div>
      )}
    </div>
  )
}

function Row({
  title,
  detail,
  control,
  warn,
  extra,
  onToggle,
}: {
  title: string
  detail: string
  /** For a row whose control is a switch: clicking the words flips it too,
   *  as clicking a label does anywhere else. */
  onToggle?: () => void
  control?: React.ReactNode
  warn?: boolean
  /** Rendered under the detail, for a control the row itself cannot hold. */
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div
          onClick={onToggle}
          className={onToggle ? 'group cursor-pointer select-none' : undefined}
        >
        <div className="text-[13px] font-medium text-text">{title}</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={detail}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={
              warn
                ? 'mt-1 text-[11.5px] leading-relaxed text-danger'
                : 'mt-1 text-[11.5px] leading-relaxed text-textFaint'
            }
          >
            {detail}
          </motion.p>
        </AnimatePresence>
        </div>
        {extra}
      </div>
      <div className="mt-0.5 shrink-0">{control}</div>
    </div>
  )
}

interface SectionCard {
  key: keyof Sections
  label: string
  icon: typeof Film
  /** How much is in it. */
  amount: (library: HostStatus['library']) => number
  /** Filled by recognising films and series, which can be switched off. */
  recognised?: boolean
}

const SECTION_CARDS: SectionCard[] = [
  { key: 'movies', label: 'Movies', icon: Film, recognised: true, amount: (l) => l.films },
  { key: 'series', label: 'TV Series', icon: Tv, recognised: true, amount: (l) => l.series },
  { key: 'videos', label: 'Videos', icon: Video, amount: (l) => l.videos },
  { key: 'music', label: 'Music', icon: Music, amount: (l) => l.music },
  { key: 'photos', label: 'Photos', icon: ImageIcon, amount: (l) => l.photos },
]

/**
 * The five sections in one strip: each its icon over its name, with how much
 * is in it, lit with a short line under it while devices show it.
 *
 * One row, so it never takes more room than the setting is worth, and the
 * same strip the Basalt app shows a device that manages this host. The whole
 * cell is the control.
 */
function SectionPicker({
  sections,
  library,
  onChange,
}: {
  sections: Sections
  library: HostStatus['library']
  onChange: (sections: Sections) => void
}): React.JSX.Element {
  const shown = SECTION_CARDS.filter((c) => sections[c.key]).length

  return (
    <div className="mt-3.5">
      <div className="grid grid-cols-5 overflow-hidden rounded-[14px] border border-white/[0.08] bg-white/[0.02]">
        {SECTION_CARDS.map((card, i) => {
          const on = sections[card.key]
          const waiting = card.recognised && !library.enabled
          const Icon = card.icon
          return (
            <button
              key={card.key}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`Show ${card.label} on devices`}
              title={waiting ? 'Filled once films and series are recognised' : undefined}
              onClick={() => onChange({ ...sections, [card.key]: !on })}
              className={cn(
                'relative flex min-w-0 flex-col items-center gap-1.5 px-1 pb-[11px] pt-3 transition-colors duration-200 hover:bg-white/[0.03]',
                i > 0 && 'border-l border-white/[0.06]',
                on ? 'bg-white/[0.065] text-text' : 'text-[#5c5c62]',
              )}
            >
              <Icon size={17} />
              <span className="max-w-full truncate text-[11.5px]">{card.label}</span>
              <span className={cn('tnum font-mono text-[10px]', on ? 'text-textFaint' : 'text-[#55555b]')}>
                {!on ? 'hidden' : waiting ? '–' : card.amount(library).toLocaleString()}
              </span>
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-0 left-1/2 -ml-[11px] h-[2px] w-[22px] rounded-full bg-basalt transition-transform duration-200',
                  on ? 'scale-x-100' : 'scale-x-0',
                )}
              />
            </button>
          )
        })}
      </div>
      <p className="mt-2.5 text-[11px] text-textFaint">
        {shown === SECTION_CARDS.length
          ? 'Every section is shown.'
          : shown === 0
            ? 'Devices show Files, Recent and Starred only.'
            : `${shown} of ${SECTION_CARDS.length} sections shown. Changes reach connected devices at once.`}
      </p>
    </div>
  )
}
