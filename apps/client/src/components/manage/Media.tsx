import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  Cpu,
  Film,
  Images,
  KeyRound,
  LayoutGrid,
  Library,
  Loader2,
  Music,
  RefreshCw,
  Sparkles,
  Tv,
  Video,
  type LucideIcon,
} from 'lucide-react'
import type { LibrarySections, ManagedHostStatus } from '@/lib/manage'
import { cn } from '@/lib/utils'
import { Group, Pill, Row, Rows, Segmented, Toggle, ago, useLayout } from './parts'
import type { Tools } from './tools'

type Conversion = ManagedHostStatus['conversion']

/** Films and series recognised on the drive, and their posters. */
export function LibraryGroup({ m, view, prompt, confirm }: Tools): React.JSX.Element {
  const phone = useLayout() === 'phone'
  const { library } = view.status
  const scanning = library.scanning || m.busy === 'rescan'

  return (
    <Group icon={Library} title="Library">
      <Rows>
        <Toggle
          title="Recognise films and series"
          description={
            library.enabled
              ? libraryDetail(view.status)
              : 'Off. Your devices see folders and files exactly as they are on the drive.'
          }
          checked={library.enabled}
          onChange={(enabled) => m.act({ do: 'setLibrary', enabled })}
        />
        {library.enabled && (
          <Row
            icon={<RefreshCw size={phone ? 17 : 14} className={scanning ? 'animate-spin' : ''} />}
            title={scanning ? 'Scanning the drive…' : 'Scan again'}
            sub={
              scanning
                ? 'New films and series show up on your devices as they are found.'
                : 'For something just copied on that has not shown up yet.'
            }
            disabled={scanning}
            onClick={() => void m.act({ do: 'rescan' })}
          />
        )}
        {library.enabled && (
          <Toggle
            title="Download posters"
            description={
              library.posters
                ? `Each recognised title is looked up for its artwork. ${library.withArt} of ${library.films + library.series} have it.`
                : 'Off. Covers are drawn from the title. On, each recognised title is sent to a lookup service.'
            }
            checked={library.posters}
            onChange={(enabled) => m.act({ do: 'setPosters', enabled })}
          />
        )}
        {library.enabled && library.posters && (
          <Row
            icon={<KeyRound size={phone ? 17 : 14} />}
            title="TMDb key"
            sub={library.hasKey ? 'Saved. It is never shown again.' : 'Optional: your own key finds artwork for more titles.'}
            end={
              <span className="flex shrink-0 gap-1.5">
                {library.hasKey && (
                  <Pill
                    onClick={() =>
                      void confirm({
                        title: 'Remove the TMDb key?',
                        message: 'Posters carry on, found the built-in way.',
                        confirmLabel: 'Remove',
                        danger: true,
                      }).then((ok) => ok && m.act({ do: 'setTmdbKey', key: '' }))
                    }
                  >
                    Remove
                  </Pill>
                )}
                <Pill
                  onClick={() =>
                    prompt({
                      title: 'Your TMDb key',
                      value: '',
                      confirmLabel: 'Save key',
                      onConfirm: (key) => void m.act({ do: 'setTmdbKey', key }),
                    })
                  }
                >
                  {library.hasKey ? 'Replace' : 'Add'}
                </Pill>
              </span>
            }
          />
        )}
      </Rows>
    </Group>
  )
}

/**
 * What the index found, or what it is doing. A scan under way says so, rather
 * than reporting nothing found at the moment that is least likely to be true.
 */
function libraryDetail(status: ManagedHostStatus): string {
  const { scanning, films, series, uncertain, scannedAt } = status.library
  if (scanning) return 'Scanning the drive…'
  if (films === 0 && series === 0) {
    return 'Nothing recognised yet. Films and series show up in their own sections on your devices.'
  }
  const found = `${films} ${films === 1 ? 'film' : 'films'} and ${series} series, last checked ${ago(scannedAt)}.`
  return uncertain > 0 ? `${found} ${uncertain} ${uncertain === 1 ? 'is a guess' : 'are guesses'}.` : found
}

const SECTIONS: Array<{
  key: keyof LibrarySections
  label: string
  icon: LucideIcon
  amount: (l: ManagedHostStatus['library']) => number
}> = [
  { key: 'movies', label: 'Movies', icon: Film, amount: (l) => l.films },
  { key: 'series', label: 'TV Series', icon: Tv, amount: (l) => l.series },
  { key: 'videos', label: 'Videos', icon: Video, amount: (l) => l.videos },
  { key: 'music', label: 'Music', icon: Music, amount: (l) => l.music },
  { key: 'photos', label: 'Photos', icon: Images, amount: (l) => l.photos },
]

/** Which sections every device lists under Library. */
export function SectionsGroup({ m, view }: Tools): React.JSX.Element {
  const layout = useLayout()
  const phone = layout === 'phone'
  const { sections, library } = view.status

  return (
    <Group icon={LayoutGrid} title="Sections on your devices">
      <div className="p-3">
        <div className="grid grid-cols-3 gap-2">
          {SECTIONS.map((section) => {
            const on = sections[section.key]
            const Icon = section.icon
            const waiting = (section.key === 'movies' || section.key === 'series') && !library.enabled
            return (
              <motion.button
                key={section.key}
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`Show ${section.label} on devices`}
                whileTap={{ scale: 0.96 }}
                onClick={() => void m.act({ do: 'setSections', sections: { ...sections, [section.key]: !on } })}
                className={cn(
                  'relative flex flex-col items-start overflow-hidden border text-left transition-[background-color,border-color] duration-200',
                  phone ? 'rounded-xl p-3' : 'rounded-lg p-2.5',
                  on ? 'border-white/[0.16] bg-white/[0.055]' : 'border-white/[0.06] bg-transparent',
                )}
              >
                <span className="flex w-full items-start justify-between">
                  <Icon size={phone ? 18 : 15} className={on ? 'text-text' : 'text-textFaint'} />
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-full transition-colors',
                      phone ? 'h-[18px] w-[18px]' : 'h-4 w-4',
                      on ? 'bg-basalt text-ink' : 'border border-white/20',
                    )}
                  >
                    {on && <Check size={phone ? 12 : 10} strokeWidth={3} />}
                  </span>
                </span>
                <span className={cn('mt-2.5 truncate', phone ? 'text-[13.5px]' : 'text-[12px]', on ? 'text-text' : 'text-textDim')}>
                  {section.label}
                </span>
                <span className="tnum mt-0.5 truncate font-mono text-[10.5px] text-textFaint">
                  {waiting ? 'needs recognising' : section.amount(library).toLocaleString()}
                </span>
              </motion.button>
            )
          })}
        </div>
        <p className={cn('mt-3 px-1 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
          Hiding a section only tidies the list. Every file stays reachable under Files.
        </p>
      </div>
    </Group>
  )
}

/** Converting 4K for devices that can't play it, and how much at once. */
export function ConversionGroup({ m, view }: Tools): React.JSX.Element {
  const layout = useLayout()
  const phone = layout === 'phone'
  const c = view.status.conversion
  const measuring = c.measuring || m.busy === 'measureConversion'
  const on = c.enabled && c.available

  return (
    <Group icon={Sparkles} title="Conversion">
      <Toggle
        title="Convert video for devices that can’t play it"
        description={conversionDetail(c)}
        checked={c.enabled}
        disabled={!c.available}
        onChange={(enabled) => m.act({ do: 'setConversion', enabled })}
      />

      <AnimatePresence initial={false}>
        {on && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="divide-y divide-white/[0.05] border-t border-white/[0.05]">
              <div className="flex items-center gap-3.5 px-4 py-3.5">
                <span
                  className={cn(
                    'flex shrink-0 items-center justify-center bg-white/[0.05] text-textDim',
                    phone ? 'h-11 w-11 rounded-xl' : 'h-9 w-9 rounded-lg',
                  )}
                >
                  {measuring ? <Loader2 size={17} className="animate-spin" /> : <Cpu size={17} strokeWidth={1.8} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className={cn('tnum font-semibold leading-none text-text', phone ? 'text-[24px]' : 'text-[20px]')}>
                      {c.limit}
                    </span>
                    <span className={cn('text-textDim', phone ? 'text-[13px]' : 'text-[12px]')}>
                      {c.limit === 1 ? 'device at once' : 'devices at once'}
                    </span>
                  </div>
                  <p className={cn('mt-1 leading-snug text-textFaint', phone ? 'text-[12px]' : 'text-[11px]')}>
                    {measuring
                      ? 'Measuring: converting a 4K sample, one at a time, then more.'
                      : c.measured
                        ? `Measured ${ago(c.measured.at)} on ${c.measured.by}: one at ${c.measured.speed}× real time${
                            c.measured.memory ? ', as many as memory allows' : ''
                          }.`
                        : (c.note ?? 'Not measured yet.')}
                  </p>
                </div>
                <Pill onClick={() => void m.act({ do: 'measureConversion' })} busy={measuring}>
                  {measuring ? 'Measuring' : c.measured ? 'Measure again' : 'Measure'}
                </Pill>
              </div>

              <div className="px-4 py-3.5">
                <div className={cn('mb-2 text-text', phone ? 'text-[15px]' : 'text-[13px]')}>At once</div>
                <Segmented<number>
                  fit
                  label="How many devices at once"
                  value={c.byHand ?? 0}
                  options={[
                    { value: 0, label: 'Auto' },
                    ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })),
                  ]}
                  onChange={(n) => void m.act({ do: 'setConversionAtOnce', atOnce: n === 0 ? null : n })}
                />
                <p className={cn('mt-2 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
                  {c.byHand === null
                    ? `As many as the host was measured to keep up with${c.measured ? `: ${c.measured.atOnce}` : ''}.`
                    : c.measured && c.byHand > c.measured.atOnce
                      ? 'More than it was measured to keep up with: pictures may stutter when that many watch at once.'
                      : 'Chosen by hand. Fewer leaves the host’s computer freer for other things.'}
                </p>
              </div>

              <div className="px-4 py-3.5">
                <div className={cn('text-text', phone ? 'text-[15px]' : 'text-[13px]')}>Converting now</div>
                {c.active.length === 0 ? (
                  <p className={cn('mt-1 text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>Nothing at the moment.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {c.active.map((a, i) => (
                      <li key={`${a.device}-${a.since}-${i}`} className="flex items-center gap-2.5">
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="absolute inset-0 animate-ping rounded-full bg-basalt/50" />
                          <span className="relative h-2 w-2 rounded-full bg-basalt" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block truncate text-text', phone ? 'text-[13.5px]' : 'text-[12px]')}>
                            {a.file.split('/').pop()}
                          </span>
                          <span className="block truncate text-[11.5px] text-textFaint">
                            for {a.device || 'a device'} · {since(a.since)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Group>
  )
}

function conversionDetail(c: Conversion): string {
  if (!c.detected) return 'Looking at what the host can convert video with…'
  if (!c.available) {
    return 'The host’s computer has nothing to convert video with. A device that can’t play a file plays it in a lighter mode.'
  }
  if (!c.enabled) return 'Off. A device that can’t play a file as it is plays it in a lighter mode instead.'
  if (c.measured === null && c.measuring) return 'Measuring how many devices the host can convert for at once…'
  if (c.limit === 0) {
    return 'The host’s computer is too slow to convert 4K as it is watched. Devices play it in a lighter mode instead.'
  }
  return 'A phone that can’t play a 4K film gets it converted to 1080p as it watches.'
}

/** How long it has been going: "12 min", "1 h 5 min". */
function since(unixSeconds: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - unixSeconds) / 60))
  if (minutes < 1) return 'just started'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
