import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Check,
  Cpu,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  Library as LibraryIcon,
  Loader2,
  Monitor,
  Music,
  Pencil,
  RefreshCw,
  Tv,
  Video,
} from 'lucide-react'
import type { HostStatus, PreviewsWhen, Sections } from '@/lib/api'
import { About } from './About'
import { ConversionPanel, conversionDetail } from './ConversionPanel'
import { Segmented } from './ProfileAccess'
import { Switch } from './ui/Switch'
import { ActionRow, Group, SettingRow } from './ui/Group'
import { cn, formatAgo } from '@/lib/utils'

/**
 * The settings this app has, in four panels: what the host does with the
 * library, converting video, what devices show, and this computer.
 *
 * Everything else a network share usually asks for — addresses, share names,
 * user accounts, firewall rules, permissions — is either decided by the
 * protocol or not a decision at all.
 *
 * What does something on the person's behalf that they did not ask for at
 * install time says so: a switch that lets strangers on the network join, and
 * those that send names to an online service.
 */
export function LibrarySettings({
  status,
  onLibrary,
  onRescan,
  onPosters,
  onTmdbKey,
  onPreviews,
  onPreviewsWhen,
  onMakeMissingPreviews,
  onMusicCovers,
}: {
  status: HostStatus
  onLibrary: (enabled: boolean) => void
  onRescan: () => void
  onPosters: (enabled: boolean) => void
  onTmdbKey: (key: string) => void
  onPreviews: (enabled: boolean) => void
  onPreviewsWhen: (when: PreviewsWhen) => void
  onMakeMissingPreviews: () => void
  onMusicCovers: (enabled: boolean) => void
}): React.JSX.Element {
  const { library } = status
  return (
    <Group icon={LibraryIcon} title="Library">
      <SettingRow
        onToggle={() => onLibrary(!library.enabled)}
        title="Recognise films and series"
        detail={
          library.enabled
            ? libraryDetail(status)
            : 'Off. Your devices see folders and files exactly as they are on the drive.'
        }
        control={<Switch checked={library.enabled} onChange={onLibrary} label="Recognise films and series" />}
      />
      {library.enabled && (
        <ActionRow
          icon={<RefreshCw size={14} className={library.scanning ? 'animate-spin' : ''} />}
          title={library.scanning ? 'Scanning the drive…' : 'Scan again'}
          detail="For files just copied to the drive that haven’t appeared yet."
          onClick={onRescan}
          disabled={library.scanning}
        />
      )}
      {library.enabled && <Artwork status={status} onPosters={onPosters} onSave={onTmdbKey} />}
      <AlbumCovers status={status} onChange={onMusicCovers} />
      <TimelinePictures
        status={status}
        onChange={onPreviews}
        onWhen={onPreviewsWhen}
        onMakeMissing={onMakeMissingPreviews}
      />
    </Group>
  )
}

export function ConversionSettings({
  status,
  onConversion,
  onConversionAtOnce,
  onMeasureConversion,
}: {
  status: HostStatus
  onConversion: (enabled: boolean) => void
  onConversionAtOnce: (atOnce: number | null) => void
  onMeasureConversion: () => void
}): React.JSX.Element {
  const { conversion } = status
  return (
    <Group
      icon={Cpu}
      title="Video conversion"
      aside={conversion.active.length > 0 ? `${conversion.active.length} converting now` : undefined}
    >
      <SettingRow
        onToggle={conversion.available ? () => onConversion(!conversion.enabled) : undefined}
        title="Convert video for devices that can’t play it"
        detail={conversionDetail(conversion)}
        control={
          conversion.available ? (
            <Switch
              checked={conversion.enabled}
              onChange={onConversion}
              label="Convert video for devices that can’t play it"
            />
          ) : undefined
        }
        extra={
          <ConversionPanel conversion={conversion} onAtOnce={onConversionAtOnce} onMeasure={onMeasureConversion} />
        }
      />
    </Group>
  )
}

export function SectionSettings({
  status,
  onSections,
}: {
  status: HostStatus
  onSections: (sections: Sections) => void
}): React.JSX.Element {
  return (
    <Group icon={LayoutGrid} title="Sections on your devices">
      <div className="px-4 py-3">
        <p className="text-[11.5px] leading-snug text-textFaint">
          What each device shows under Library. Hiding a section only tidies the list. Every file is
          still in Files.
        </p>
        <SectionPicker sections={status.sections} library={status.library} onChange={onSections} />
      </div>
    </Group>
  )
}

export function ComputerSettings({
  status,
  onRequirePin,
  onStartWithWindows,
  onRename,
  build,
  onOpenLog,
}: {
  status: HostStatus
  onRequirePin: (require: boolean) => void
  onStartWithWindows: (enabled: boolean) => void
  onRename: (name: string) => void
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
  const startLabel = status.platform === 'windows' ? 'Start when Windows starts' : 'Start when you log in'

  return (
    <Group icon={Monitor} title="This computer">
      <SettingRow
        onToggle={() => onRequirePin(!status.requirePin)}
        title="Ask for a PIN when pairing"
        detail={
          status.requirePin
            ? 'A new device shows up here with a number to type. Nobody joins without being let in.'
            : 'Any device on this network can join and open the drive without a PIN.'
        }
        warn={!status.requirePin}
        control={<Switch checked={status.requirePin} onChange={onRequirePin} label="Ask for a PIN when pairing" />}
      />

      <SettingRow
        onToggle={() => onStartWithWindows(!status.startWithWindows)}
        title={startLabel}
        detail={
          status.platform === 'windows'
            ? 'Opens in the notification area at login, so the drive is there before you go looking for it.'
            : 'Opens in the background at login, so the drive is there before you go looking for it.'
        }
        control={<Switch checked={status.startWithWindows} onChange={onStartWithWindows} label={startLabel} />}
      />

      <SettingRow
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
                className="w-[160px] rounded-md border border-lineBright bg-ink2 px-2 py-1 font-mono text-[12px] text-text outline-none"
              />
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={commitName}
                aria-label="Save the name"
                className="rounded-md p-1.5 text-textDim transition-colors hover:bg-white/[0.06] hover:text-text"
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
              className="flex max-w-[200px] items-center gap-2 rounded-md px-2 py-1 font-mono text-[12px] text-textDim transition-colors hover:bg-white/[0.06] hover:text-text"
            >
              <span className="truncate">{status.hostName}</span>
              <Pencil size={11} className="shrink-0" />
            </button>
          )
        }
      />

      <div className="px-4 py-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[13px] text-text">Address</span>
          <span className="tnum min-w-0 truncate font-mono text-[12px] text-textDim">
            {status.addresses.length > 0 ? (
              <>
                {status.addresses[0]}
                <span className="text-textFaint">:{status.port}</span>
              </>
            ) : (
              <span className="text-textFaint">No network connection</span>
            )}
          </span>
        </div>
        {/* The network the computer actually uses comes first. The rest are
            usually adapters other software adds (VirtualBox, WSL), shown
            quietly after it. */}
        {status.addresses.length > 1 && (
          <div className="tnum mt-1 truncate text-right font-mono text-[10.5px] text-textFaint">
            also {status.addresses.slice(1).join(', ')}
          </div>
        )}
        <p className="mt-1.5 text-[11.5px] leading-snug text-textFaint">
          Only for reference. Your devices find this host by themselves, even when its address changes.
        </p>
        {/* Which build this is, and where it writes its log: "am I running
            the new one?" and "where do I look when it misbehaves?" each cost
            a round trip to answer once. */}
        <div className="tnum mt-2.5 flex items-center justify-between gap-3 font-mono text-[10px] text-textFaint">
          <span className="truncate">{build || 'build unknown'}</span>
          <button
            onClick={onOpenLog}
            className="shrink-0 underline decoration-dotted underline-offset-2 transition-colors hover:text-textDim"
          >
            open the log folder
          </button>
        </div>
      </div>

      <div id="host-about" className="scroll-mt-6">
        <About product="Basalt Host" platform={status.platform} />
      </div>
    </Group>
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
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div
          className="min-w-0 flex-1 cursor-pointer select-none"
          onClick={() => onPosters(!posters)}
        >
          <div className="text-[13px] text-text">Download posters</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-textFaint">
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

/**
 * Timeline pictures: small pictures along each film's timeline, made here
 * and kept in the host's own folder. Nothing leaves the computer, so it is
 * on unless turned off; the switch is for the disk space and the work.
 */
const PREVIEWS_WHEN: Array<{ value: PreviewsWhen; label: string; explained: string }> = [
  {
    value: 'arrive',
    label: 'As they arrive',
    explained: 'Made as soon as a film or episode is on the drive, even while something plays.',
  },
  {
    value: 'idle',
    label: 'While idle',
    explained: 'Made when nothing has been watched or converted for a minute, one film at a time.',
  },
  {
    value: 'play',
    label: 'When played',
    explained: 'Made only for a film when somebody first plays it. Nothing in the background.',
  },
]

function TimelinePictures({
  status,
  onChange,
  onWhen,
  onMakeMissing,
}: {
  status: HostStatus
  onChange: (enabled: boolean) => void
  onWhen: (when: PreviewsWhen) => void
  onMakeMissing: () => void
}): React.JSX.Element | null {
  const { previews: on, previewsWhen, previewsNow } = status.library
  // A host before these existed reports nothing to switch.
  if (on === undefined) return null
  const when = previewsWhen ?? 'idle'
  const running = previewsNow != null && previewsNow.total > 0
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 cursor-pointer select-none" onClick={() => onChange(!on)}>
          <div className="text-[13px] text-text">Timeline pictures</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-textFaint">
            {on
              ? 'Small pictures along each film’s timeline, made on this computer and kept with the host’s own files, up to 2 GB. A film played for the first time gets them then.'
              : 'Off. Moving along a film’s timeline shows the time only.'}
          </p>
        </div>
        <div className="mt-0.5 shrink-0">
          <Switch checked={on} onChange={onChange} label="Timeline pictures" />
        </div>
      </div>
      {on && previewsWhen !== undefined && (
        <div className="mt-2.5 space-y-2.5">
          <div className="flex flex-col items-start">
            <Segmented<PreviewsWhen>
              id="previews-when-choice"
              value={when}
              options={PREVIEWS_WHEN.map(({ value, label }) => ({ value, label }))}
              onChange={onWhen}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-textFaint">
              {PREVIEWS_WHEN.find((w) => w.value === when)?.explained}
            </p>
          </div>
          {previewsNow && (
            <div className="flex items-center gap-2 text-[11px] text-textDim">
              <Loader2 size={11} className="shrink-0 animate-spin text-basalt" />
              <span className="min-w-0 truncate">
                Making timeline pictures: {previewsNow.name}
                {running && ` · ${previewsNow.done + 1} of ${previewsNow.total}`}
              </span>
            </div>
          )}
          <button
            onClick={onMakeMissing}
            disabled={running}
            className="rounded-full border border-white/[0.12] px-3.5 py-1.5 text-[12px] text-text transition-colors hover:bg-white/[0.05] disabled:opacity-50"
          >
            {running ? 'Making the missing ones…' : 'Make the missing ones now'}
          </button>
        </div>
      )}
    </div>
  )
}

/** Album covers from the internet, for albums whose songs carry none. */
function AlbumCovers({
  status,
  onChange,
}: {
  status: HostStatus
  onChange: (enabled: boolean) => void
}): React.JSX.Element | null {
  const on = status.library.musicCovers
  if (on === undefined) return null
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 cursor-pointer select-none" onClick={() => onChange(!on)}>
          <div className="text-[13px] text-text">Download album covers</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-textFaint">
            {on
              ? 'Albums whose songs have no cover are looked up on MusicBrainz, and their covers fetched from the Cover Art Archive.'
              : 'Off. Albums without a cover get one drawn. When on, the names of albums and who they are by are sent to MusicBrainz to find their covers.'}
          </p>
        </div>
        <div className="mt-0.5 shrink-0">
          <Switch checked={on} onChange={onChange} label="Download album covers" />
        </div>
      </div>
    </div>
  )
}
