import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowRight,
  HardDrive,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { HexMark } from './HexMark'
import { useConfirm } from './ui/ConfirmDialog'
import { type MenuAction, useContextMenu } from './ui/ContextMenu'
import { ActionSheet } from '@/mobile/Sheet'
import { ApiError, api, type DiscoveredHost, type Status } from '@/lib/api'
import { useLongPress } from '@/lib/useLongPress'
import { isMobileShell, isTv } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { wrongHostText } from '@/lib/wrongHost'
import { useBack } from '@/mobile/useBack'
import { LOOPS } from '@/lib/motion'

const PIN_LENGTH = 6

const TOUCH = isMobileShell()
const TV = isTv()

/** A drive as the list names it: its drive, or the computer when none is shared. */
function driveName(host: DiscoveredHost): string {
  return host.hasVault && host.vault.trim() ? host.vault : host.hostName
}

/**
 * First contact.
 *
 * **There is no address to type.** The client asks the network which Basalt
 * hosts are there and lists them by name; picking one is the whole of step one.
 * That is the point of the discovery work — an address is something a router
 * changes without telling anyone, and having to go and look it up again is the
 * frustration this app exists to remove.
 *
 * Step two is the PIN, and only when the host is asking for one. The number is
 * on the host's screen, next to the name of this device — so typing it proves
 * the person can see that machine.
 *
 * The identity is shown at both steps on purpose. It is the value that gets
 * pinned, and after this it is never asked about again, so this is the only
 * moment anyone could notice it being wrong.
 */
export function PairingView({
  onPaired,
  notice,
  onBack,
  currentHostId,
  onHowItWorks,
}: {
  onPaired: (status: Status) => void
  /** Said above the list: why the app is back here, such as a host removing it. */
  notice?: string | null
  /**
   * Opened to change drives rather than as the first screen: there is a way
   * back, and a drive already paired opens straight away.
   */
  onBack?: () => void
  /** The drive in use, marked as such when changing drives. */
  currentHostId?: string | null
  /** Shows the introduction again: what Basalt is, and how to get the host. */
  onHowItWorks?: () => void
}): React.JSX.Element {
  const [hosts, setHosts] = useState<DiscoveredHost[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [chosen, setChosen] = useState<DiscoveredHost | null>(null)
  const [needsPin, setNeedsPin] = useState(false)
  // The host has no screen and nobody managing it: what is typed is its
  // setup code, and this device will manage it.
  const [setup, setSetup] = useState(false)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Tracks whether this component is still mounted, so a scan that finishes
  // after the user has already paired does not write into state that is gone.
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  // How many looks in a row each host has been missing from: one that does
  // not answer one look is kept, as a single look can miss a host on a busy
  // network, and only one gone from two in a row leaves the list.
  const missed = useRef(new Map<string, number>())

  const look = useCallback(async (quietly: boolean) => {
    if (!quietly) {
      setScanning(true)
      setError(null)
    }
    try {
      const found = await api.discover()
      if (!live.current) return
      // The previous list stays on screen until the new one arrives. Clearing
      // it first would make every rescan flash the empty state.
      setHosts((before) => {
        // The paired hosts the search missed come last, from the device's
        // own record. One just missed once stays where it was instead, as
        // any other host does.
        const here = found.filter((h) => h.seen !== false)
        const away = found.filter((h) => h.seen === false)
        const seen = new Set(here.map((h) => h.hostId))
        for (const id of seen) missed.current.delete(id)
        const kept = (before ?? []).filter((h) => {
          if (h.seen === false || seen.has(h.hostId)) return false
          const times = (missed.current.get(h.hostId) ?? 0) + 1
          missed.current.set(h.hostId, times)
          return times < 2
        })
        const keptIds = new Set(kept.map((h) => h.hostId))
        return [...here, ...kept, ...away.filter((h) => !keptIds.has(h.hostId))]
      })
    } catch (e) {
      if (live.current && !quietly) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (live.current && !quietly) setScanning(false)
    }
  }, [])
  const scan = useCallback(() => look(false), [look])

  useEffect(() => {
    void scan()
  }, [scan])

  // Kept listening while the list is open: a host that missed the first
  // look, or was started just now, appears without "Look again".
  useEffect(() => {
    if (chosen || busy) return undefined
    const timer = setInterval(() => void look(true), 3500)
    return () => clearInterval(timer)
  }, [chosen, busy, look])

  /**
   * Picking a host opens a request on it, and asks whether it wants a PIN. A
   * host this device has already paired with needs neither: it connects.
   */
  const choose = useCallback(
    async (host: DiscoveredHost) => {
      if (busy) return
      if (host.hostId && host.hostId === currentHostId && onBack) {
        onBack()
        return
      }
      setBusy(true)
      setError(null)
      if (host.paired && host.hostId) {
        try {
          onPaired(await api.connectTo(host.hostId, host.address))
        } catch (e) {
          if (!live.current) return
          setError(
            e instanceof ApiError && e.kind === 'wronghost'
              ? wrongHostText(host.hostName, { retrying: false })
              : e instanceof Error
                ? e.message
                : String(e),
          )
          // Removed by that host: it is no longer paired, so the list is
          // looked at again and it shows as a new host to pair with.
          if (e instanceof ApiError && e.kind === 'removed') void scan()
        } finally {
          if (live.current) setBusy(false)
        }
        return
      }
      // A TV leaves managing the host to a phone or computer, so it must not
      // be the device that sets one up: it would become the host's only
      // manager, with no way to choose the drive or let anyone else manage.
      if (TV && host.needsSetup && !host.paired) {
        setError(
          `${host.hostName} isn’t set up yet. Set it up from Basalt on your phone or computer, then choose it here.`,
        )
        setBusy(false)
        return
      }
      try {
        const start = await api.beginPairing(host.address)
        if (!live.current) return
        setChosen(host)
        setNeedsPin(start.requiresPin)
        setSetup(start.setup)
        setPin('')

        // Nothing left to ask. Finish straight away rather than showing an
        // empty PIN screen with a button that only says "continue".
        if (!start.requiresPin) {
          onPaired(await api.finishPairing(''))
        }
      } catch (e) {
        if (!live.current) return
        setChosen(null)
        setError(
          e instanceof ApiError && e.kind === 'offline'
            ? `${host.hostName} stopped answering. It may have gone to sleep.`
            : e instanceof Error
              ? e.message
              : String(e),
        )
      } finally {
        if (live.current) setBusy(false)
      }
    },
    [busy, onPaired, onBack, currentHostId, scan],
  )

  const { confirm, dialog } = useConfirm()

  /**
   * A paired drive taken off this device's list. Only this device forgets it:
   * the host still lists the device until its owner removes it there, and
   * the files are not touched. Using it again means pairing with the PIN.
   */
  const forget = useCallback(
    async (host: DiscoveredHost) => {
      const name = driveName(host)
      const ok = await confirm({
        title: `Forget ${name}?`,
        message: `This device stops using ${name} on ${host.hostName}. Nothing on that computer changes. To use it again, pair with its PIN.`,
        confirmLabel: 'Forget',
        danger: true,
      })
      if (!ok || !live.current) return
      try {
        await api.forgetHost(host.hostId)
        if (!live.current) return
        missed.current.delete(host.hostId)
        setHosts((before) => before?.filter((h) => h.hostId !== host.hostId) ?? before)
        // Still on the network, it comes back as a host to pair with.
        void look(true)
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : String(e))
      }
    },
    [confirm, look],
  )

  /**
   * An address typed in. Asked who answers there first, so a host this device
   * has paired with is reconnected to, as choosing it from the list would.
   * It used to start a new pairing every time, PIN and all, which on a
   * network where hosts cannot be found was the only way back to a host.
   */
  const chooseAddress = useCallback(
    async (address: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      let host: DiscoveredHost
      try {
        host = await api.identifyHost(address)
      } catch (e) {
        if (!live.current) return
        setError(
          e instanceof ApiError && e.kind === 'offline'
            ? `Nothing answered at ${address}. The address is shown in Basalt Host’s window.`
            : e instanceof Error
              ? e.message
              : String(e),
        )
        setBusy(false)
        return
      }
      if (!live.current) return
      setBusy(false)
      await choose(host)
    },
    [busy, choose],
  )

  const submitPin = useCallback(
    async (value: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        onPaired(await api.finishPairing(value))
      } catch (e) {
        if (!live.current) return
        setPin('')
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (live.current) setBusy(false)
      }
    },
    [busy, onPaired],
  )

  const back = useCallback(() => {
    // Tell the host to take the card down rather than leaving this device's
    // name on its screen for three minutes after a change of mind.
    void api.cancelPairing().catch(() => {})
    setChosen(null)
    setNeedsPin(false)
    setSetup(false)
    setPin('')
    setError(null)
  }, [])

  const picking = !chosen

  // On a phone, back from the PIN goes back to the list, as the button
  // below does; it used to put the whole app away.
  useBack(!picking, () => {
    back()
    return true
  })

  return (
    <div className="relative flex h-full flex-col items-center justify-center px-8 py-8">
      <div className="backdrop" />
      {dialog}

      {/* As tall as the window and no taller: with many drives the list
          scrolls between the title and the buttons, which stay in view. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 flex max-h-full w-full max-w-[400px] flex-col"
      >
        <div className="mb-6 flex shrink-0 flex-col items-center text-center">
          <motion.span
            animate={{ opacity: [0.55, 1, 0.55] }}
            transition={{ duration: 4, repeat: LOOPS, ease: 'easeInOut' }}
            className="text-basalt"
          >
            <HexMark size={34} />
          </motion.span>
          <h1 className="mt-4 font-display text-[19px] font-semibold tracking-tighter text-text">
            {picking
              ? onBack
                ? 'Change drive'
                : 'Choose your drive'
              : setup
                ? 'Set up this host'
                : 'Enter the PIN'}
          </h1>
          <p className="mt-1.5 max-w-[320px] text-[12px] leading-relaxed text-textDim">
            {picking
              ? onBack
                ? 'Basalt hosts on this network. One you’ve paired with opens straight away.'
                : 'Basalt hosts on this network. Choose yours.'
              : setup
                ? `${chosen.hostName} has no screen. Type its setup code, and this device will manage it.`
                : `Type the six digits shown on ${chosen.hostName}. You only do this once.`}
          </p>
        </div>

        {notice && picking && (
          <div className="mb-4 shrink-0 rounded-lg border border-danger/25 bg-dangerBg px-3.5 py-3 text-[12px] leading-relaxed text-danger">
            {notice}
          </div>
        )}

        {picking ? (
          <>
            <HostList
              hosts={hosts}
              scanning={scanning}
              busy={busy}
              currentHostId={currentHostId ?? null}
              onChoose={(host) => void choose(host)}
              onForget={(host) => void forget(host)}
              onAddress={(address) => void chooseAddress(address)}
              onRescan={() => void scan()}
            />
            {onHowItWorks && (
              <button
                onClick={onHowItWorks}
                className="mt-1 flex w-full shrink-0 items-center justify-center gap-1.5 py-2 text-[11px] text-textFaint transition-colors hover:text-textDim"
              >
                New to Basalt? See how it works
                <ArrowRight size={11} />
              </button>
            )}
            {onBack && (
              <button
                onClick={onBack}
                className="mt-2 flex w-full shrink-0 items-center justify-center gap-1.5 rounded-md py-2 text-[11.5px] text-textDim transition-colors hover:text-text"
              >
                <ArrowLeft size={12} />
                Back
              </button>
            )}
          </>
        ) : (
          <motion.div
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="min-h-0 overflow-y-auto"
          >
            {needsPin && setup ? (
              <SetupCodeInput value={pin} onChange={setPin} onSubmit={submitPin} busy={busy} />
            ) : needsPin ? (
              <PinInput value={pin} onChange={setPin} onComplete={submitPin} busy={busy} />
            ) : (
              <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-textDim">
                <Loader2 size={13} className="animate-spin" />
                Connecting…
              </div>
            )}

            <div className="mt-6 rounded-lg border border-white/[0.07] bg-panel/70 p-3.5">
              <div className="flex items-center gap-2.5">
                <ShieldCheck size={14} className="shrink-0 text-basaltDeep" />
                <span className="truncate text-[12px] font-medium text-text">
                  {chosen.hostName}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-textFaint">
                  {chosen.hostId.slice(0, 8)}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-textDim">
                {setup ? (
                  <>
                    A new host. Check that this identity matches the one the host shows.
                    After this, this device trusts it and won’t ask again.
                  </>
                ) : (
                  <>
                    {/* Not "Sharing ." for a host with no drive shared yet. */}
                    {chosen.hasVault && chosen.vault.trim() && (
                      <>
                        Sharing <span className="text-text">{chosen.vault}</span>.{' '}
                      </>
                    )}
                    Check that this identity matches the one the host shows. After this,
                    this device trusts it and won’t ask again.
                  </>
                )}
              </p>
            </div>

            <button
              onClick={back}
              className="mt-3 w-full rounded-md py-1.5 text-[11px] text-textFaint transition-colors hover:text-textDim"
            >
              Choose a different host
            </button>
          </motion.div>
        )}

        <AnimatePresence>
          {error && (
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="mt-4 shrink-0 text-center text-[11px] leading-relaxed text-danger"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}

/**
 * The hosts on this network, and the drives this device has paired with.
 *
 * In groups once there is more than one kind: drives this device uses, hosts
 * new to it, and paired drives not found just now, greyed, last. Only the
 * list scrolls, so with many drives the title and the buttons stay in view.
 *
 * A paired drive can be forgotten from here: right-click, or the button that
 * shows on hover, on a computer; a long press on a phone.
 *
 * The empty state is the one that matters: somebody staring at it has a host
 * they believe is running, so it says what to check rather than only that
 * nothing was found.
 */
function HostList({
  hosts,
  scanning,
  busy,
  currentHostId,
  onChoose,
  onForget,
  onAddress,
  onRescan,
}: {
  hosts: DiscoveredHost[] | null
  scanning: boolean
  busy: boolean
  currentHostId: string | null
  onChoose: (host: DiscoveredHost) => void
  onForget: (host: DiscoveredHost) => void
  onAddress: (address: string) => void
  onRescan: () => void
}): React.JSX.Element {
  const menu = useContextMenu()
  const [sheet, setSheet] = useState<DiscoveredHost | null>(null)
  // Which ends of the list have more past them, for a fade there: without
  // it a list cut at a row boundary looked complete.
  const scroller = useRef<HTMLDivElement | null>(null)
  const [more, setMore] = useState({ above: false, below: false })
  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const above = el.scrollTop > 2
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 2
    setMore((was) => (was.above === above && was.below === below ? was : { above, below }))
  }, [])
  useEffect(() => {
    measure()
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  })

  if (hosts === null) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 size={16} className="animate-spin text-textFaint" />
        <span className="text-[11.5px] text-textFaint">Looking for hosts…</span>
      </div>
    )
  }

  const current = (h: DiscoveredHost): boolean => !!currentHostId && h.hostId === currentHostId
  const groups = groupHosts(hosts, currentHostId)
  const titled = groups.length > 1

  /** What a drive offers besides opening: forgetting it, when paired and not in use. */
  const actionsFor = (host: DiscoveredHost): MenuAction[] =>
    host.paired && !current(host)
      ? [
          { id: 'open', label: 'Open', icon: ArrowRight, run: () => onChoose(host) },
          {
            id: 'forget',
            label: 'Forget this drive…',
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            run: () => onForget(host),
          },
        ]
      : []

  return (
    <>
      {menu.node}
      <div
        ref={scroller}
        onScroll={measure}
        className="-mx-1 min-h-0 overflow-y-auto px-1"
        style={{
          maskImage: `linear-gradient(to bottom, ${more.above ? 'transparent' : 'black'}, black 28px, black calc(100% - 28px), ${more.below ? 'transparent' : 'black'})`,
        }}
      >
        {groups.map((group, g) => (
          <div key={group.title}>
            {titled && (
              <div className="mb-1.5 mt-3 px-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-textFaint first:mt-0">
                {group.title}
              </div>
            )}
            <AnimatePresence initial={false}>
              {group.hosts.map((host, i) => {
                const actions = actionsFor(host)
                return (
                  <motion.div
                    key={host.hostId}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <HostRow
                      host={host}
                      busy={busy}
                      current={current(host)}
                      first={g === 0 && i === 0}
                      onChoose={() => onChoose(host)}
                      onMenu={
                        actions.length === 0
                          ? undefined
                          : (at) => (TOUCH ? setSheet(host) : menu.open(at, actions))
                      }
                    />
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        ))}

        {hosts.length === 0 && (
          <div className="rounded-lg border border-dashed border-white/[0.09] px-4 py-7 text-center">
            <p className="text-[12.5px] text-textDim">No hosts on this network.</p>
            <p className="mx-auto mt-2 max-w-[300px] text-[11px] leading-relaxed text-textFaint">
              Check that Basalt Host is running on the other computer (look for its
              icon near the clock) and that both are on the same network.
            </p>
          </div>
        )}
      </div>

      <div className="shrink-0">
        <button
          onClick={onRescan}
          disabled={scanning}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md py-2 text-[11px] text-textFaint transition-colors hover:text-textDim disabled:opacity-50"
        >
          <RefreshCw size={11} className={cn(scanning && 'animate-spin')} />
          {scanning ? 'Looking…' : 'Look again'}
        </button>

        <AddressEntry busy={busy} onAddress={onAddress} />
      </div>

      {TOUCH && (
        <ActionSheet
          open={sheet !== null}
          onClose={() => setSheet(null)}
          title={sheet ? driveName(sheet) : undefined}
          subtitle={sheet?.hostName}
          actions={sheet ? actionsFor(sheet) : []}
        />
      )}
    </>
  )
}

/**
 * The list in its groups, those with nothing in them left out: drives this
 * device uses (the one in use first), hosts new to it, and paired drives the
 * search did not find just now.
 */
export function groupHosts(
  hosts: DiscoveredHost[],
  currentHostId: string | null,
): Array<{ title: string; hosts: DiscoveredHost[] }> {
  const current = (h: DiscoveredHost): boolean => !!currentHostId && h.hostId === currentHostId
  const here = hosts.filter((h) => h.seen !== false || current(h))
  const yours = here.filter((h) => h.paired || current(h))
  yours.sort((a, b) => Number(current(b)) - Number(current(a)))
  return [
    { title: 'Your drives', hosts: yours },
    { title: 'New on this network', hosts: here.filter((h) => !h.paired && !current(h)) },
    { title: 'Not found right now', hosts: hosts.filter((h) => h.seen === false && !current(h)) },
  ].filter((group) => group.hosts.length > 0)
}

/**
 * The host by its address or its computer's name, for when looking for it
 * finds nothing.
 *
 * Some networks do not pass the broadcasts hosts announce themselves with —
 * guest Wi-Fi, some mesh systems, a phone emulator. The address is shown in
 * Basalt Host's own window; the computer's name is often easier, and the
 * router or Windows usually knows it. Pairing goes on exactly as it would have: the PIN,
 * and then the host's key, are what is trusted, never the address.
 */
function AddressEntry({
  busy,
  onAddress,
}: {
  busy: boolean
  onAddress: (address: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const trimmed = address.trim()
  const withPort = trimmed && !/:\d+$/.test(trimmed) ? `${trimmed}:7742` : trimmed

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-1 flex w-full items-center justify-center py-2 text-[11px] text-textFaint underline decoration-white/15 underline-offset-4 transition-colors hover:text-textDim"
      >
        Enter the address or computer name
      </button>
    )
  }
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!withPort || busy) return
        onAddress(withPort)
      }}
    >
      <input
        autoFocus
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="192.168.1.20 or LIVING-ROOM-PC"
        aria-label="Host address"
        className="min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-2.5 font-mono text-[13px] text-text placeholder:text-textFaint focus:border-white/25"
      />
      <button
        type="submit"
        disabled={!withPort || busy}
        className="shrink-0 rounded-md bg-basalt px-4 text-[12.5px] font-medium text-ink transition-opacity disabled:opacity-40"
      >
        Connect
      </button>
    </form>
  )
}

function HostRow({
  host,
  busy,
  current = false,
  first = false,
  onChoose,
  onMenu,
}: {
  host: DiscoveredHost
  busy: boolean
  /** The drive this device is using now. */
  current?: boolean
  /** At the top of the list: where a TV remote starts. */
  first?: boolean
  onChoose: () => void
  /** What else it offers, opened at a point: absent when nothing. */
  onMenu?: (at: { clientX: number; clientY: number }) => void
}): React.JSX.Element {
  // A host with no drive chosen yet has nothing to offer. Listed anyway,
  // because seeing the machine and being told why it is unavailable beats an
  // empty list and no explanation. One with no screen waiting to be set up
  // is the exception: setting it up is done from here.
  const setup = host.needsSetup && !host.paired
  const ready = host.hasVault || setup
  const disabled = busy || !ready
  // Paired, and not found by the search just now: dimmed, and still chosen
  // with a tap, which tries everywhere it might be.
  const away = host.seen === false
  // A long press on a phone, as everywhere else in the app; a tap opens it.
  const press = useLongPress(
    () => onMenu?.({ clientX: 0, clientY: 0 }),
    () => {
      if (!disabled) onChoose()
    },
  )
  const touchMenu = TOUCH && onMenu

  return (
    <div className="group relative mb-2">
    <motion.button
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      onClick={disabled || touchMenu ? undefined : onChoose}
      {...(touchMenu ? press : {})}
      onContextMenu={(e) => {
        e.preventDefault()
        if (onMenu && !TOUCH) onMenu(e)
      }}
      disabled={disabled}
      data-remote-first={first ? '' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-white/[0.07] bg-panel2 px-3.5 py-3 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:border-white/[0.16]',
        away && !disabled && 'opacity-60 hover:opacity-100',
      )}
    >
      <span className="shrink-0 text-textFaint">
        <HardDrive size={15} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text">
            {host.hasVault ? host.vault : host.hostName}
          </span>
          {setup && (
            <span className="shrink-0 rounded-[4px] border border-basalt/40 bg-basalt/10 px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.1em] text-basalt">
              new
            </span>
          )}
          {(current || host.paired) && (
            <span className="shrink-0 rounded-[4px] border border-white/[0.12] px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.1em] text-textFaint">
              {current ? 'in use' : 'paired'}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-textFaint">
          <span className="truncate">
            {setup
              ? TV
                ? 'set it up from your phone or computer'
                : 'set it up from here'
              : host.hasVault
                ? host.hostName
                : 'no drive shared yet'}
          </span>
          <span className="shrink-0">·</span>
          {/* In place of the id: the name needs the room more. */}
          <span className="shrink-0">{away ? 'not found right now' : host.hostId.slice(0, 8)}</span>
        </div>
      </div>

      {ready && (
        <span className={cn('shrink-0 text-textFaint', onMenu && !TOUCH && 'group-hover:invisible')}>
          {setup ? (
            <ArrowRight size={14} />
          ) : host.requiresPin && !host.paired ? (
            <span
              title="This host asks for a PIN"
              className="font-mono text-[9px] uppercase tracking-[0.1em]"
            >
              pin
            </span>
          ) : (
            <ArrowRight size={14} />
          )}
        </span>
      )}
    </motion.button>
    {/* On a computer: only on hover or focus, over the arrow, so the list
        reads as it always did. */}
    {onMenu && !TOUCH && (
      <button
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect()
          onMenu({ clientX: box.right - 4, clientY: box.bottom + 2 })
        }}
        aria-label={`More for ${driveName(host)}`}
        className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-textFaint opacity-0 transition-opacity hover:bg-white/[0.08] hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal size={15} />
      </button>
    )}
    </div>
  )
}

/** Letters and digits a setup code is made of: none that look alike. */
const SETUP_ALPHABET = /[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g
const SETUP_LENGTH = 8

/**
 * A host's setup code: eight letters and digits, read off its log.
 *
 * One field rather than boxes: it is copied from a terminal as often as it
 * is typed, and a paste must land whole. Shown as `K7QM-4XPR`, as the log
 * writes it; what is kept is only the eight characters. Letters that are not
 * in a code (O, I, L) are dropped as they are typed rather than refused at
 * the end, and where to find the code is said beside it.
 */
function SetupCodeInput({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  busy: boolean
}): React.JSX.Element {
  const shown = value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value
  const complete = value.length === SETUP_LENGTH

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (complete && !busy) onSubmit(value)
      }}
    >
      <input
        autoFocus
        value={shown}
        onChange={(e) => {
          const next = e.target.value.toUpperCase().replace(SETUP_ALPHABET, '').slice(0, SETUP_LENGTH)
          onChange(next)
        }}
        disabled={busy}
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="one-time-code"
        spellCheck={false}
        placeholder="XXXX-XXXX"
        aria-label="Setup code"
        className="h-14 w-full rounded-lg border border-line bg-panel text-center font-mono text-[24px] tracking-[0.18em] text-text placeholder:text-white/15 focus:border-white/25 disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={!complete || busy}
        className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-basalt text-[13px] font-medium text-ink transition-opacity disabled:opacity-40"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        Set up and manage this host
      </button>
      <div className="mt-4 rounded-lg border border-white/[0.07] bg-panel/70 px-3.5 py-3 text-[11px] leading-relaxed text-textDim">
        <div className="text-[11.5px] text-text">Where to find the code</div>
        <div className="mt-1.5 space-y-1">
          <div>
            On the host, run{' '}
            <span className="whitespace-nowrap font-mono text-[10.5px] text-textFaint">sudo basalt-host status</span>
          </div>
          <div>
            With Docker:{' '}
            <span className="whitespace-nowrap font-mono text-[10.5px] text-textFaint">docker logs basalt</span>
          </div>
        </div>
      </div>
    </form>
  )
}

/**
 * Six boxes that behave like one field.
 *
 * A single text input would be simpler, but a PIN is read off another screen
 * one digit at a time and separated boxes make it obvious where you are. One
 * hidden input does the actual typing so paste, backspace and mobile keyboards
 * all keep working; the boxes are decoration over it.
 */
function PinInput({
  value,
  onChange,
  onComplete,
  busy,
}: {
  value: string
  onChange: (value: string) => void
  onComplete: (value: string) => void
  busy: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div
      className="relative flex justify-center gap-2"
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        disabled={busy}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH)
          onChange(digits)
          if (digits.length === PIN_LENGTH) onComplete(digits)
        }}
        className="absolute inset-0 z-10 h-full w-full cursor-default opacity-0"
        aria-label="Pairing PIN"
      />

      {Array.from({ length: PIN_LENGTH }, (_, i) => {
        const filled = i < value.length
        const active = focused && i === value.length && !busy
        return (
          <div
            key={i}
            className={cn(
              'tnum flex h-12 w-11 items-center justify-center rounded-lg border font-mono text-[17px] transition-colors',
              filled
                ? 'border-white/20 bg-panel2 text-text'
                : 'border-white/[0.08] bg-ink2 text-textFaint',
              active && 'border-white/35',
              busy && 'opacity-50',
            )}
          >
            {filled ? (
              <motion.span
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 600, damping: 30 }}
              >
                {value[i]}
              </motion.span>
            ) : active ? (
              <motion.span
                animate={{ opacity: [1, 0.15, 1] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                className="h-4 w-px bg-basalt"
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
