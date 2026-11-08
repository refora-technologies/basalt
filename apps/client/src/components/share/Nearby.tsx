import { useEffect, useRef, useState } from 'react'
import { Check, Laptop, Loader2, Lock, Monitor, Radio, Send, ShieldAlert, Smartphone, Tablet, Wifi, X } from 'lucide-react'

import type { NearbyDevice, NearbyMe } from '@/lib/api'
import type { Incoming, Nearby, Outgoing } from '@/lib/useNearby'
import { useNearbyDevices } from '@/lib/useNearby'
import { isProgram, titleOf, totalOf, type ShareFile } from '@/lib/share'
import { cn, formatBytes } from '@/lib/utils'
import { Switch } from '@/components/Switch'
import { ShareStatus } from './Share'

/**
 * Sharing with devices nearby, without a host: the devices ready around
 * this one, sending to one (and the code, when one is asked), an offer
 * arriving, and the Nearby screen with its two switches. Reached from the
 * Share sheet, from the Inbox, and before any drive at all.
 */

function formIcon(form: NearbyMe['form']): typeof Laptop {
  switch (form) {
    case 'phone':
      return Smartphone
    case 'tablet':
      return Tablet
    case 'computer':
      return Laptop
    default:
      return Monitor
  }
}

/** "Pixel 8" with its short id beside it, so two of one name are told apart. */
export function NearbyName({ device, className }: { device: NearbyMe; className?: string }): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className="truncate">{device.name}</span>
      <span className="shrink-0 rounded bg-white/[0.08] px-1 font-mono text-[10.5px] font-semibold tracking-[0.08em] text-textDim">
        {device.id}
      </span>
    </span>
  )
}

/** One device nearby, to choose. */
export function NearbyDeviceRow({
  device,
  chosen,
  onClick,
}: {
  device: NearbyDevice
  chosen: boolean
  onClick: () => void
}): React.JSX.Element {
  // Found by its own Wi-Fi, its kind isn't known yet: a neutral mark, not a guess.
  const Icon = device.ssid && !device.form ? Radio : formIcon(device.form)
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors',
        chosen ? 'bg-white/[0.07]' : 'hover:bg-white/[0.03] active:bg-white/[0.05]',
      )}
    >
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-text">
        <Icon size={16} />
        <span
          className={cn('surface-ring absolute -bottom-px -right-px h-2.5 w-2.5 rounded-full', device.ssid ? 'bg-violet-400' : 'bg-sky-400')}
        />
      </span>
      <span className="min-w-0 flex-1">
        <NearbyName device={device} className="text-[14.5px] text-text" />
        <span className="flex items-center gap-1 text-[12px] text-textFaint">
          {device.ssid ? (
            <>
              <Wifi size={11} /> Its own Wi-Fi · a code is asked
            </>
          ) : device.code ? (
            <>
              <Lock size={11} /> Asks for a code
            </>
          ) : (
            'Nearby · asks to accept'
          )}
        </span>
      </span>
      {chosen && (
        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-white text-black">
          <Check size={13} strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

/** The devices nearby, found as it looks: a list to choose from. */
export function NearbyList({
  nearby,
  chosen,
  onChoose,
}: {
  nearby: Nearby
  chosen: string | null
  onChoose: (device: NearbyDevice) => void
}): React.JSX.Element {
  const devices = useNearbyDevices(nearby, true)
  if (devices.length === 0) {
    return (
      <p className="flex items-center gap-2 px-5 py-2.5 text-[12.5px] leading-snug text-textFaint">
        {nearby.looking && <Loader2 size={13} className="shrink-0 animate-spin" />}
        Looking for devices nearby… The other device turns on “Ready to receive from nearby”.
      </p>
    )
  }
  return (
    <>
      {devices.map((d) => (
        <NearbyDeviceRow key={`${d.id}-${d.key}`} device={d} chosen={chosen === `${d.id}-${d.key}`} onClick={() => onChoose(d)} />
      ))}
    </>
  )
}

/** Six boxes for a code; done by itself at the sixth digit. */
export function CodeBoxes({
  onCode,
  busy,
  phone,
}: {
  onCode: (code: string) => void
  busy: boolean
  phone?: boolean
}): React.JSX.Element {
  const [digits, setDigits] = useState('')
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    if (!busy) {
      setDigits('')
      input.current?.focus()
    }
  }, [busy])
  return (
    <label className="relative mx-auto flex w-fit cursor-text gap-2" onClick={() => input.current?.focus()}>
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'flex items-center justify-center rounded-lg border font-mono font-semibold text-text',
            phone ? 'h-12 w-10 text-[22px]' : 'h-11 w-9 text-[20px]',
            i === 3 && 'ml-2',
            i === digits.length ? 'border-white/40' : 'border-white/[0.12]',
          )}
        >
          {digits[i] ?? ''}
        </span>
      ))}
      <input
        ref={input}
        value={digits}
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="The code"
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value.replace(/\D/g, '').slice(0, 6)
          setDigits(next)
          if (next.length === 6) onCode(next)
        }}
        className="absolute inset-0 opacity-0"
      />
    </label>
  )
}

/**
 * An offer sent from here to a device nearby, while it's answered: waiting
 * for Accept, the code to type when one is asked, then on its way.
 */
export function NearbySending({
  nearby,
  sending,
  phone,
  onClose,
}: {
  nearby: Nearby
  sending: Outgoing
  phone?: boolean
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const device = sending.device
  return (
    <div className="px-5 pb-2 pt-3 text-center">
      {sending.state === 'joining' && (
        <>
          <Loader2 size={20} className="mx-auto animate-spin text-textDim" />
          <p className="mt-3 text-[14px] text-text">Joining the Wi-Fi of</p>
          <NearbyName device={device} className="mt-1 justify-center text-[16px] font-semibold text-text" />
          <p className="mt-2 text-[12.5px] leading-snug text-textFaint">
            You have no Wi-Fi in common, so this device joins its own for a moment.
            {phone ? ' Android asks first: choose Connect.' : ' This computer leaves its Wi-Fi until it’s done.'}
          </p>
          <button
            onClick={() => {
              nearby.cancel(sending.offer)
              onClose()
            }}
            className="mt-4 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text"
          >
            Cancel
          </button>
        </>
      )}
      {sending.state === 'asking' && (
        <>
          <Loader2 size={20} className="mx-auto animate-spin text-textDim" />
          <p className="mt-3 text-[14px] text-text">Waiting for an answer on</p>
          <NearbyName device={device} className="mt-1 justify-center text-[16px] font-semibold text-text" />
          <p className="mt-2 text-[12.5px] leading-snug text-textFaint">
            They’re asked to accept {titleOf(sending.files)}. Check it’s the device you mean by its letters.
          </p>
          <button
            onClick={() => {
              nearby.cancel(sending.offer)
              onClose()
            }}
            className="mt-4 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text"
          >
            Cancel
          </button>
        </>
      )}
      {sending.state === 'code' && (
        <>
          <p className="text-[14px] text-text">Type the code shown on</p>
          <NearbyName device={device} className="mt-1 justify-center text-[16px] font-semibold text-text" />
          <p className="mb-4 mt-1.5 text-[12.5px] leading-snug text-textFaint">Ask them for it: only that device can take it then.</p>
          <CodeBoxes
            phone={phone}
            busy={busy}
            onCode={(code) => {
              setBusy(true)
              setSaid(null)
              void nearby
                .typeCode(sending.offer, code)
                .then((answer) => {
                  if (answer.kind === 'wrong')
                    setSaid(answer.left > 0 ? `That isn’t it. ${answer.left} ${answer.left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes: it was stopped.')
                })
                .catch((e: unknown) => setSaid(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false))
            }}
          />
          <p className={cn('mt-3 min-h-[18px] text-[12.5px]', said ? 'text-danger' : 'text-textFaint')}>{said ?? (busy ? 'Checking…' : '')}</p>
          <button
            onClick={() => {
              nearby.cancel(sending.offer)
              onClose()
            }}
            className="mt-2 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Sending files on this device to a device nearby: the list, then the
 * offer's progress. The Share sheet's Nearby part, and the Nearby screen's.
 */
export function NearbyChooser({
  nearby,
  files,
  phone,
  initial,
  onDone,
}: {
  nearby: Nearby
  files: ShareFile[]
  phone?: boolean
  /** Already chosen, in the Share sheet's list. */
  initial?: NearbyDevice
  onDone: () => void
}): React.JSX.Element {
  const [chosen, setChosen] = useState<NearbyDevice | null>(initial ?? null)
  const [offer, setOffer] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sending = offer ? (nearby.outgoing.find((o) => o.offer === offer) ?? null) : null
  if (offer && sending && sending.state !== 'sending') {
    return <NearbySending nearby={nearby} sending={sending} phone={phone} onClose={onDone} />
  }
  if (offer) {
    // Accepted and on its way, or answered: followed to the end.
    const item = nearby.items.find((i) => i.id === offer && i.direction === 'out') ?? null
    return (
      <ShareStatus
        item={item}
        to={chosen ? `${chosen.name} · ${chosen.id}` : 'the other device'}
        progress={item ? nearby.progressOf(item) : null}
        onDone={onDone}
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NearbyList nearby={nearby} chosen={chosen ? `${chosen.id}-${chosen.key}` : null} onChoose={setChosen} />
      </div>
      <div className="border-t border-white/[0.06] px-5 pt-3.5">
        <button
          disabled={!chosen}
          onClick={() => {
            // Once: the window moves on to it at once, so it can't be sent twice.
            if (!chosen || offer) return
            setError(null)
            setOffer(nearby.send(chosen, files))
          }}
          className="w-full rounded-full bg-white py-3 text-[14px] font-semibold text-black transition-transform active:scale-[0.98] disabled:bg-white/[0.06] disabled:text-textFaint"
        >
          {chosen ? `Send to ${chosen.name} · ${chosen.id}` : 'Choose where it goes'}
        </button>
        <p className="mt-2 text-center text-[12px] leading-snug text-textFaint">
          {error ??
            `${
              files.some((f) => !f.source)
                ? 'From the drive, through this device.'
                : chosen?.ssid
                  ? 'On its own Wi-Fi: this device joins it for a moment.'
                  : 'Straight to it, on this Wi-Fi.'
            } ${
              chosen?.code || nearby.alwaysCode ? 'They show a code, and you type it.' : 'They’re asked to accept.'
            }`}
        </p>
      </div>
    </div>
  )
}

/**
 * An offer from a device nearby, for this person: Accept or Decline, then
 * the code to tell the sender when one is asked.
 */
export function NearbyPrompt({
  nearby,
  offer,
  compact,
  onLater,
}: {
  nearby: Nearby
  offer: Incoming
  compact?: boolean
  onLater?: () => void
}): React.JSX.Element {
  const programs = offer.files.filter((f) => isProgram(f.name))
  if (offer.accepted && offer.code) {
    return (
      <div className={cn('text-center', compact ? '' : 'px-5')}>
        <p className="text-[13px] text-textDim">Tell them this code</p>
        <p className="mt-2 font-mono text-[34px] font-semibold tracking-[0.18em] text-text">
          {offer.shown ? `${offer.shown.slice(0, 3)} ${offer.shown.slice(3)}` : '··· ···'}
        </p>
        <p className="mt-1 flex items-center justify-center gap-1 text-[12.5px] text-textFaint">
          They type it on <NearbyName device={offer.from} className="text-textDim" />
        </p>
        {offer.left !== undefined && (
          <p className="mt-2 text-[12.5px] text-danger">
            A wrong code was typed there. {offer.left} {offer.left === 1 ? 'try' : 'tries'} left.
          </p>
        )}
        <button
          onClick={() => nearby.decline(offer.ask)}
          className={cn('mt-4 w-full rounded-full border border-white/[0.12] text-text', compact ? 'py-2 text-[12.5px]' : 'py-2.5 text-[13.5px]')}
        >
          Stop
        </button>
      </div>
    )
  }
  if (offer.accepted) {
    return (
      <p className="flex items-center justify-center gap-2 py-3 text-[13px] text-textDim">
        <Loader2 size={14} className="animate-spin" /> Starting…
      </p>
    )
  }
  return (
    <div className={compact ? '' : 'px-5'}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-400/15 text-sky-300">
          <Radio size={16} />
        </span>
        <span className="min-w-0">
          <span className={cn('block font-semibold text-text', compact ? 'text-[13.5px]' : 'text-[15px]')}>
            A device nearby wants to send you {offer.files.length === 1 ? 'a file' : `${offer.files.length} files`}
          </span>
          <NearbyName device={offer.from} className="text-[12.5px] text-textDim" />
        </span>
      </div>
      <div className="mt-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
        <span className="block truncate text-[14px] text-text">{titleOf(offer.files.map((f) => ({ ...f, path: '' })))}</span>
        <span className="block font-mono text-[11.5px] text-textFaint">
          {formatBytes(totalOf(offer.files.map((f) => ({ ...f, path: '' }))))}
          {offer.code ? ' · a code is asked' : ''}
        </span>
      </div>
      {programs.length > 0 && (
        <p className="mt-2.5 rounded-xl bg-white/[0.04] px-3 py-2 text-[12px] leading-snug text-textDim">
          {programs.length === offer.files.length ? 'This is a program.' : 'There are programs among these.'} Basalt never opens one by
          itself; only accept if you know who sent it.
        </p>
      )}
      <div className={cn('mt-4 flex gap-2.5', compact ? 'flex-row' : 'flex-col')}>
        <button
          onClick={() => nearby.accept(offer.ask)}
          className={cn('rounded-full bg-white font-semibold text-black active:scale-[0.98]', compact ? 'px-4 py-2 text-[12.5px]' : 'py-3 text-[14px]')}
        >
          Accept
        </button>
        <button
          onClick={() => nearby.decline(offer.ask)}
          className={cn('text-textDim', compact ? 'ml-auto px-2 py-2 text-[12.5px]' : 'py-2 text-[13px]')}
        >
          Decline
        </button>
        {onLater && compact && (
          <button onClick={onLater} aria-label="Later" className="px-1 text-textFaint">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

/** "Ready to receive from nearby" and "Always ask for a code", with what they mean. */
export function NearbySwitches({ nearby, className }: { nearby: Nearby; className?: string }): React.JSX.Element {
  const [allowing, setAllowing] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  return (
    <>
      <Switch
        label="Ready to receive from nearby"
        description={
          nearby.me
            ? `Devices nearby see “${nearby.me.name} · ${nearby.me.id}” and can offer you files, on this Wi-Fi or, with none in common, on a small one of this device’s own. You accept each one.`
            : 'Devices nearby can offer you files. You accept each one.'
        }
        checked={nearby.ready}
        onChange={nearby.setReady}
        className={className}
      />
      <Switch
        label="Always ask for a code"
        description="Before anything goes, the receiver shows a code and the sender types it, so you talk first. Asked when either side has this on."
        checked={nearby.alwaysCode}
        onChange={nearby.setAlwaysCode}
        className={className}
      />
      {nearby.ready && nearby.firewall === 'blocked' && (
        <div className="mx-4 my-2 flex items-start gap-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-3.5 py-3">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-300" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-snug text-text">Windows Firewall keeps devices nearby out</p>
            <p className="mt-0.5 text-[12px] leading-snug text-textFaint">
              They can’t offer you files, or take what you send them, until Basalt is let through. Windows asks you first.
            </p>
            {said && <p className="mt-1 text-[12px] text-danger">{said}</p>}
          </div>
          <button
            disabled={allowing}
            onClick={() => {
              setAllowing(true)
              setSaid(null)
              nearby
                .allowFirewall()
                .catch((e: unknown) => setSaid(e instanceof Error ? e.message : String(e)))
                .finally(() => setAllowing(false))
            }}
            className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-black disabled:opacity-60"
          >
            {allowing ? 'Asking…' : 'Let it through'}
          </button>
        </div>
      )}
    </>
  )
}

/**
 * The Nearby screen: this device as others see it, the two switches, and
 * sending files on this device to one nearby. Works before any drive.
 */
export function NearbyScreen({
  nearby,
  phone,
  pickFiles,
}: {
  nearby: Nearby
  phone?: boolean
  /** Files on this device, chosen: none if the person changed their mind. */
  pickFiles: () => Promise<ShareFile[]>
}): React.JSX.Element {
  const [files, setFiles] = useState<ShareFile[] | null>(null)
  return (
    <div className="flex min-h-0 flex-col">
      {nearby.me && (
        <div className="mx-5 mb-3 flex items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3">
          <span className="text-[12px] text-textFaint">Others see this device as</span>
          <NearbyName device={nearby.me} className="ml-auto text-[14px] font-semibold text-text" />
        </div>
      )}
      <NearbySwitches nearby={nearby} className="px-5" />
      {nearby.ready && nearby.wifiNote && (
        <p className="mx-5 mt-1 rounded-xl bg-white/[0.04] px-3 py-2 text-[12px] leading-snug text-textDim">{nearby.wifiNote}</p>
      )}
      <div className="px-5 pb-1 pt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">Send</div>
      {files ? (
        <div className="flex min-h-0 flex-col">
          <div className="px-5 pb-2 text-[13px] text-textDim">
            {titleOf(files)} · {formatBytes(totalOf(files))}
          </div>
          <NearbyChooser nearby={nearby} files={files} phone={phone} onDone={() => setFiles(null)} />
        </div>
      ) : (
        <div className="px-5">
          <button
            onClick={() => void pickFiles().then((chosen) => chosen.length > 0 && setFiles(chosen))}
            className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 text-left hover:bg-white/[0.05] active:bg-white/[0.06]"
          >
            <Send size={17} className="shrink-0 text-textDim" />
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-text">Send files to a device nearby</span>
              <span className="block text-[12px] text-textFaint">Any file on this {phone ? 'phone' : 'computer'}, on the same Wi-Fi, no drive needed</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
