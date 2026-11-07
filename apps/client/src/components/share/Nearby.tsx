import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Smartphone, Wifi } from 'lucide-react'

import { api, onNearby, type NearbyEvent } from '@/lib/api'
import { newOfferId, titleOf, totalOf, isProgram, type ShareFile, type ShareItem } from '@/lib/share'
import type { Inbox } from '@/lib/useInbox'
import { cn, formatBytes } from '@/lib/utils'

/**
 * Sending to a device nearby by a code (05, 13e): the code, big, until
 * someone types it on their device; then who, and how it went. Only for
 * files on this device: they go straight across, not through the host.
 */
export function SendWithCode({ files, onDone }: { files: ShareFile[]; onDone: () => void }): React.JSX.Element {
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const connected = useRef(false)

  useEffect(() => {
    const offer = newOfferId()
    let gone = false
    let stop: (() => void) | null = null
    void onNearby(({ offer: about, event }) => {
      if (about !== offer) return
      said(event)
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    const said = (event: NearbyEvent): void => {
      if (event.kind === 'connected') {
        connected.current = true
        setTo(event.to)
        setNote(null)
      } else if (event.kind === 'wrongCode') {
        setNote(`A wrong code was typed: ${event.left} ${event.left === 1 ? 'try' : 'tries'} left.`)
      } else if (event.kind === 'spent') {
        setError('Too many wrong codes. Start again for a new one.')
      } else if (event.kind === 'answered') {
        setEnded(event.answer)
      }
    }
    api
      .nearbySend(
        offer,
        files.map((f) => ({ source: f.source ?? '', name: f.name, size: f.size })),
      )
      .then((c) => !gone && setCode(c))
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      gone = true
      stop?.()
      // Still waiting for someone: nobody can take it now. Taking it, it
      // carries on to the end.
      if (!connected.current) void api.nearbyStop().catch(() => {})
    }
    // Started once for the files this window opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="px-5 pb-1 pt-2 text-center">
      {error ? (
        <p className="py-6 text-[13px] leading-relaxed text-danger">{error}</p>
      ) : !to ? (
        <>
          <p className="text-[13px] text-textDim">Type this code on the other device</p>
          <div className="mt-3 font-mono text-[40px] font-semibold tracking-[0.18em] text-text">
            {code ? `${code.slice(0, 3)} ${code.slice(3)}` : <Loader2 size={28} className="mx-auto animate-spin text-textFaint" />}
          </div>
          <p className="mx-auto mt-3 flex max-w-[300px] items-center justify-center gap-1.5 text-[12px] leading-snug text-textFaint">
            <Wifi size={13} className="shrink-0" />
            Both need to be on the same Wi-Fi. It goes straight across, not through the host.
          </p>
          {note && <p className="mt-2 text-[12px] text-danger">{note}</p>}
        </>
      ) : (
        <div className="py-3">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06] text-textDim">
            {ended === 'done' ? <Check size={20} /> : <Smartphone size={20} />}
          </div>
          <p className="mt-3 text-[15px] font-semibold text-text">
            {ended === 'done'
              ? `${to} has it`
              : ended === 'declined'
                ? `${to} said no`
                : ended
                  ? `It didn’t reach ${to}`
                  : `Connected to ${to}`}
          </p>
          <p className="mt-1 text-[12.5px] text-textFaint">
            {titleOf(files)} · {formatBytes(totalOf(files))}
            {ended ? '' : ' · sending straight across, on this Wi-Fi'}
          </p>
        </div>
      )}
      <button
        onClick={onDone}
        className="mt-3 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text"
      >
        {ended || error ? 'Done' : to ? 'Close: it carries on' : 'Cancel'}
      </button>
    </div>
  )
}

/**
 * Receiving with a code (13a-d): six digits, typed; then who it's from and
 * how it's going, as the Inbox's Received shows it too.
 */
export function ReceiveWithCode({ inbox, onClose, phone }: { inbox: Inbox; onClose: () => void; phone?: boolean }): React.JSX.Element {
  const [digits, setDigits] = useState('')
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [itemId, setItemId] = useState<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const item: ShareItem | null = itemId ? (inbox.items.find((i) => i.id === itemId && i.direction === 'in') ?? null) : null

  useEffect(() => {
    input.current?.focus()
  }, [])

  const look = (code: string): void => {
    setLooking(true)
    setError(null)
    api
      .nearbyReceive(code)
      .then((offer) => setItemId(inbox.takeNearby(offer).id))
      .catch((e: unknown) => {
        // A wrong code says so and clears (13a).
        setError(plainNearby(e instanceof Error ? e.message : String(e)))
        setDigits('')
        input.current?.focus()
      })
      .finally(() => setLooking(false))
  }

  if (item) {
    const program = item.state === 'waiting' && item.files.some((f) => isProgram(f.name))
    return (
      <div className="px-5 pb-2 pt-2 text-center">
        <p className="text-[13px] text-textDim">
          {item.state === 'done' ? 'Received' : item.state === 'failed' ? 'Didn’t arrive' : 'Connected'}
        </p>
        <p className="mt-2 text-[16px] font-semibold text-text">
          {item.state === 'done'
            ? `${titleOf(item.files)} is here`
            : `${item.peer.name} is sending you ${titleOf(item.files)}`}
        </p>
        <p className="mt-1 text-[12.5px] text-textFaint">
          {formatBytes(totalOf(item.files))} · {item.files.length} {item.files.length === 1 ? 'file' : 'files'}
          {item.state === 'done' && item.savedAs ? ` · ${item.savedAs}` : ''}
        </p>
        {item.state === 'moving' && (
          <p className="mt-3 flex items-center justify-center gap-2 text-[12.5px] text-textDim">
            <Loader2 size={14} className="animate-spin" /> Receiving, straight across. It shows in Received too.
          </p>
        )}
        {item.state === 'failed' && <p className="mt-3 text-[12.5px] text-danger">{item.reason}</p>}
        {program && (
          <div className="mt-3 flex gap-2">
            <button onClick={() => inbox.accept(item)} className="flex-1 rounded-full bg-white py-2.5 text-[13.5px] font-semibold text-black">
              It’s a program: accept
            </button>
            <button onClick={() => inbox.decline(item)} className="flex-1 rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text">
              Decline
            </button>
          </div>
        )}
        <button onClick={onClose} className="mt-4 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text">
          {item.state === 'moving' ? 'Close: it carries on' : 'Done'}
        </button>
      </div>
    )
  }

  return (
    <div className="px-5 pb-2 pt-2 text-center">
      <p className="text-[13px] leading-relaxed text-textDim">Type the code shown on the other device. Both need to be on the same Wi-Fi.</p>
      <label className="relative mx-auto mt-4 flex w-fit cursor-text gap-2" onClick={() => input.current?.focus()}>
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={cn(
              'flex items-center justify-center rounded-lg border font-mono font-semibold text-text',
              phone ? 'h-12 w-10 text-[22px]' : 'h-11 w-9 text-[20px]',
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
          disabled={looking}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 6)
            setDigits(next)
            setError(null)
            // On by itself at the sixth digit: no button to press.
            if (next.length === 6) look(next)
          }}
          className="absolute inset-0 opacity-0"
        />
      </label>
      <p className={cn('mt-3 min-h-[18px] text-[12.5px]', error ? 'text-danger' : 'text-textFaint')}>
        {error ?? (looking ? 'Looking for it on this Wi-Fi…' : '')}
      </p>
      <button onClick={onClose} className="mt-2 w-full rounded-full border border-white/[0.12] py-2.5 text-[13.5px] text-text">
        Cancel
      </button>
    </div>
  )
}

/** Why a code didn't work, plainly. */
export function plainNearby(message: string): string {
  if (/isn.t right/.test(message)) return 'That code isn’t right. Check it on the other device.'
  if (/no device sending/.test(message)) return 'No device sending with a code was found on this Wi-Fi.'
  if (/couldn.t be reached/.test(message)) return 'The other device was found, but couldn’t be reached.'
  return message
}
