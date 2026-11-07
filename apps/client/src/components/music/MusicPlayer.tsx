import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ApiError,
  api,
  inTauri,
  onChannel,
  onMusicNow,
  onPresence,
  type Listening,
  type MusicCommand,
  type MusicGroup,
  type MusicGroupRequest,
  type NowReport,
  type NowSession,
} from '@/lib/api'
import { groupPosition, groupSong, isHostGroup, stepFor } from '@/lib/musicGroup'
import {
  MusicClockContext,
  MusicPlayerContext,
  type MusicClock,
  type MusicPlayerApi,
} from '@/lib/musicPlayer'
import {
  type Queue,
  addToQueue as queueAdd,
  current as currentOf,
  cycleRepeat as cycleRepeatOf,
  fromListening,
  moveUpNext as queueMove,
  next as nextOf,
  playNext as queuePlayNext,
  previous as previousOf,
  queueOf,
  removeUpNext as queueRemove,
  setShuffle as shuffleOf,
  toListening,
} from '@/lib/queue'
import { claimPress, pressForKey } from '@/lib/systemMedia'
import * as mpvBackend from '@/lib/mpvBackend'
import { useMpv } from '@/lib/useMpv'
import { rememberVolume, rememberedVolume } from '@/lib/volumes'
import {
  type ClockSample,
  type Estimate,
  type Reading,
  SEEK_ABOVE_SECONDS,
  bestOffset,
  keepInStep,
  livePosition,
  smoothed,
  songOf as remoteSong,
  startOf,
} from '@/lib/musicNow'

/**
 * The music player for the whole app.
 *
 * Music has a player of its own, separate from the one films open full
 * screen, so it can go on playing while somebody browses: the bar at the
 * bottom shows it, and opens the full player. There is one mpv, so the two
 * never play at once: `onStarts` tells the app music began (it closes any
 * film), and the app calls `stop` before a film opens.
 *
 * mpv is held only while there is a queue (see `Engine`): with nothing to
 * play, the film player has it to itself, as it always did.
 */
export function MusicPlayer({
  onStarts,
  onListening,
  who,
  connected,
  children,
}: {
  onStarts: () => void
  /** What is playing, to keep for Continue listening; often while playing. */
  onListening: (listening: Listening) => void
  /**
   * The host and profile this device plays as: what it plays is shared with
   * that profile's other devices, and theirs with it. Null on its own.
   */
  who: string | null
  /** Whether the host is reachable, as the app knows it. */
  connected: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [queue, setQueue] = useState<Queue | null>(null)
  // ---- The host out of reach ----
  /** A song would not open because the host was out of reach: waiting for it, not skipping. */
  const [reconnecting, setReconnecting] = useState(false)
  /** Opening the same song again, from where it was, once the host is back. */
  const [again, setAgain] = useState(0)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  /** Where the song was when the host went: it carries on from there. */
  const waitFrom = useRef(0)
  // Waiting: the song is tried again when the app has the host back, and
  // every few seconds in case it has not noticed.
  useEffect(() => {
    if (!reconnecting) return undefined
    const tryAgain = (): void => {
      void hostReachable(connectedRef.current).then((reachable) => {
        if (!reachable) return
        setReconnecting(false)
        startAt.current = waitFrom.current
        setAgain((n) => n + 1)
      })
    }
    if (connected) tryAgain()
    const timer = setInterval(tryAgain, RETRY_HOST_MS)
    return () => clearInterval(timer)
  }, [reconnecting, connected])
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** Where to start the next song loaded: a song carried on from elsewhere. */
  const startAt = useRef(0)
  const controls = useRef<EngineControls | null>(null)
  const [clock, setClock] = useState({ position: 0, duration: 0, volume: 100 })
  const clockRef = useRef(clock)
  clockRef.current = clock
  /** When the clock last moved: the player tells it a few times a second. */
  const clockMoved = useRef(0)
  const clockChanged = useCallback((next: { position: number; duration: number; volume: number }) => {
    if (next.position !== clockRef.current.position) clockMoved.current = Date.now()
    setClock(next)
  }, [])
  const starts = useRef(onStarts)
  starts.current = onStarts
  /** Songs in a row that could not be opened: past the whole queue, it stops. */
  const failures = useRef(0)
  /**
   * When the next song opened starts (Unix ms), opened paused until then:
   * devices in sync start a song at the same moment rather than each when
   * it has opened. Taken by the player as it opens the song.
   */
  const holdUntil = useRef<number | null>(null)
  /** Waiting for that moment: shown as playing, since it is about to. */
  const [holding, setHolding] = useState(false)
  const holdingRef = useRef(holding)
  holdingRef.current = holding
  // Never waiting for long: a start that did not come (the song changed, the
  // player closed) must not leave it out of the keeping in step for good.
  useEffect(() => {
    if (!holding) return undefined
    const giveUp = setTimeout(() => setHolding(false), HOLD_AT_MOST_MS)
    return () => clearTimeout(giveUp)
  }, [holding])
  /** The moment a song changed by hand here starts, for the devices in sync. */
  const handStart = useRef<number | null>(null)
  /**
   * How long this device's player takes to make sound once unpaused, in ms:
   * it is unpaused that much before the moment. Learnt from each start,
   * and kept, as it is the device's own.
   */
  const startLag = useRef(readStartLag())
  /** A start at a moment: a second on, where it got to says how late it really began. */
  const checkStart = (position: number, at: number): void => {
    setTimeout(() => {
      void measure.current().then((exact) => {
        if (!exact) return
        const late = position + (exact.at - at) / 1000 - exact.position
        // Far off is something else (a seek, a stall): not the player's own lag.
        if (Math.abs(late) > 0.5) return
        startLag.current = Math.max(0, Math.min(MAX_START_LAG_MS, startLag.current + late * 1000 * 0.7))
        saveStartLag(startLag.current)
      })
    }, START_CHECK_MS)
  }

  const begin = useCallback((next: Queue, at = 0) => {
    startAt.current = at
    setQueue(next)
    setPaused(false)
    starts.current()
  }, [])

  // ---- Shared with the profile's other devices ----
  /** The host's clock less this one's, as worked out from the quickest answers. */
  const offsetRef = useRef(0)
  const [others, setOthers] = useState<NowSession[]>([])
  const [hostOffset, setHostOffset] = useState(0)
  /** A host that does not know of it: asked no more. */
  const unknown = useRef(false)
  const obey = useRef<(commands: MusicCommand[]) => void>(() => {})
  const report = useRef<() => NowReport | null>(() => null)
  const whoRef = useRef(who)
  whoRef.current = who

  // ---- Playing together, as the host keeps it (1.6.4) ----
  /** The group this device plays in, whose state every member plays. */
  const [group, setGroupState] = useState<MusicGroup | null>(null)
  const groupRef = useRef(group)
  /** Whether the host keeps groups: null until asked, false for a host before 1.6.4. */
  const groupsOk = useRef<boolean | null>(null)
  /** This device asked to leave: a group gone is not a reason to stop. */
  const leaving = useRef(false)
  /** The group's version last played here. */
  const applied = useRef<{ id: string; version: number } | null>(null)
  /** This device's id, to tell it from the others in its group. */
  const you = useRef('')
  /** Opened paused: a song of a group that is paused. Taken by the player as it opens. */
  const openPaused = useRef(false)

  // ---- Playing in sync with others ----
  /** The devices playing in sync with this one: the same song, the same second. */
  const [linked, setLinked] = useState<string[]>([])
  const linkedRef = useRef(linked)
  linkedRef.current = linked
  /** The one this device keeps to, when it joined another's music. */
  const leader = useRef<string | null>(null)
  /** Applying what another device asked: not sent back to it. */
  const remote = useRef(false)
  /** The song changed by a hand here: sent to the devices in sync. */
  const handChanged = useRef(false)
  /**
   * When it last changed by itself, by a hand here or a correction: what the
   * other said before then is out of date, and not followed.
   */
  const corrected = useRef(0)
  /** Until when the host's word on the group is not taken: it has just been told of a change. */
  const membershipSettles = useRef(0)
  /** The devices that said they left the group: not joined again after a host restart. */
  const leftUs = useRef(new Set<string>())
  /**
   * How far ahead of the other to seek: a seek over the network takes a
   * moment to start playing again, and lands that much behind. Learnt from
   * where each correction landed.
   */
  const lead = useRef(0)
  /** A correction made, to see where it landed at the next check. */
  const checkLanding = useRef(false)
  /** The speed it plays at: 1, or a hair off while making up a gap. */
  const rate = useRef(1)
  /** The gaps found at the last checks, since the last seek. */
  const gaps = useRef<number[]>([])
  const setRate = useCallback((next: number) => {
    if (next === rate.current) return
    rate.current = next
    controls.current?.setRate(next)
  }, [])
  /**
   * Where the song is, read from the player to the millisecond, and when
   * (Unix ms). Null where the player cannot be read (the page preview).
   */
  const measure = useRef<() => Promise<Estimate | null>>(async () => null)
  /** The last estimate, which each new one builds on. */
  const estimate = useRef<Estimate | null>(null)
  measure.current = async () => {
    const readings = await controls.current?.read()
    if (!readings) return null
    const start = startOf(readings, rate.current)
    if (start === null) return null
    const at = Date.now()
    estimate.current = smoothed(estimate.current, { position: start + (rate.current * at) / 1000, at }, rate.current)
    return estimate.current
  }
  const toLinked = useCallback(
    (action: MusicCommand['action'], position = 0, listening?: Listening, startsAt?: number) => {
      if (remote.current) return
      corrected.current = Math.max(Date.now(), startsAt ?? 0)
      // When to start, on the host's clock: each device turns it into its own.
      const clock = startsAt === undefined ? undefined : Math.round(startsAt + offsetRef.current)
      for (const device of linkedRef.current) {
        void api.musicCommand(device, action, position, listening, clock).catch(() => {})
      }
    },
    [],
  )
  /**
   * A song chosen here, with devices in sync: it opens paused and starts a
   * moment from now, and they are told to start it then too.
   */
  const startTogether = (): void => {
    if (remote.current || linkedRef.current.length === 0) return
    const at = Date.now() + START_TOGETHER_MS
    holdUntil.current = at
    handStart.current = at
    setHolding(true)
  }


  const clockSamples = useRef<ClockSample[]>([])
  /** When each device was last steered from here, on the host's clock. */
  const steeredAt = useRef(new Map<string, number>())
  const exchange = useCallback(async (request: { report?: NowReport; stopped?: boolean }) => {
    const asked = whoRef.current
    if (!asked || unknown.current) return
    try {
      const sent = Date.now()
      const answer = await api.musicNow(request)
      const back = Date.now()
      if (whoRef.current !== asked) return
      // The host answered somewhere in the round trip; most likely its middle.
      clockSamples.current = [
        ...clockSamples.current.slice(-19),
        { offset: answer.now - (sent + back) / 2, took: back - sent, at: back },
      ]
      const offset = bestOffset(clockSamples.current, back) ?? answer.now - back
      offsetRef.current = offset
      setHostOffset((was) => (Math.abs(was - offset) < 1 ? was : offset))
      // A device just steered from here shows what it was asked at once; a
      // word from it older than that is not taken over it (F4: the button
      // flipped back, then forward again).
      setOthers((shown) =>
        answer.sessions.map((s) => {
          const asked = steeredAt.current.get(s.device)
          if (asked === undefined || s.at >= asked) return s
          return shown.find((o) => o.device === s.device) ?? s
        }),
      )
      // The devices in sync with this one, and the one all of them keep to,
      // as the host keeps them: however many there are, each knows all the
      // others. Just after joining or leaving, the host may not have heard
      // yet: its answer then is not taken.
      if (Date.now() > membershipSettles.current) {
        const members = answer.group
          ? answer.sessions.filter((s) => s.group === answer.group).map((s) => s.device)
          : []
        // In a group, and the host knows of none: it restarted (an update),
        // and keeps groups only while it runs. Back in it with a member still
        // playing, unless that one said it was leaving.
        if (!answer.group && linkedRef.current.length > 0) {
          const back = linkedRef.current.find(
            (d) => !leftUs.current.has(d) && answer.sessions.some((s) => s.device === d),
          )
          if (back) {
            membershipSettles.current = Date.now() + MEMBERSHIP_SETTLES_MS
            void api.musicCommand(back, 'link').catch(() => {})
          }
        }
        if (Date.now() > membershipSettles.current) {
          setLinked((was) => (sameMembers(was, members) ? was : members))
          const anchor = answer.group ? (answer.anchor ?? null) : null
          if (anchor !== leader.current) {
            leader.current = anchor
            if (anchor === null) setRate(1)
          }
        }
      }
      if (answer.commands.length > 0) obey.current(answer.commands)
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')) unknown.current = true
    }
  }, [])
  const tell = useCallback(() => {
    void (async () => {
      let now = report.current()
      // Playing, where the song is is read from the player to the
      // millisecond, with the moment on the host's clock: another device
      // joining starts from it, in step from the first second.
      if (now?.playing) {
        const exact = await measure.current()
        if (exact) {
          now = {
            ...now,
            listening: { ...now.listening, position: Math.max(0, exact.position) },
            clock: Math.round(exact.at + offsetRef.current),
          }
        }
      }
      await exchange(now ? { report: now } : {})
    })()
  }, [exchange])

  /**
   * Plays the group's state here: another song, play or pause, a seek, at
   * the moment the host stamped. The device that asked does it the same
   * way as the others, so none undoes another (F5) and all start together.
   */
  const applyGroup = (next: MusicGroup | null, ended = false): void => {
    const was = groupRef.current
    if (!next) {
      groupRef.current = null
      setGroupState(null)
      applied.current = null
      setRate(1)
      // Ended from elsewhere ("Play here" on another device): stopped here.
      // Left alone, or leaving: plays on, on its own.
      if (was && ended && !leaving.current) {
        remote.current = true
        try {
          latest.current.stop()
        } finally {
          remote.current = false
        }
      }
      leaving.current = false
      return
    }
    // An older word than one already had: not gone back to.
    if (was && was.id === next.id && next.version < was.version) return
    groupRef.current = next
    setGroupState(next)
    if (applied.current?.id === next.id && applied.current.version === next.version) return
    applied.current = { id: next.id, version: next.version }
    const music = latest.current
    const now = Date.now()
    const step = stepFor(next, { song: music.current, playing: !music.paused || holdingRef.current, position: positionNow() }, offsetRef.current, now)
    gaps.current = []
    checkLanding.current = false
    setRate(1)
    remote.current = true
    try {
      switch (step.do) {
        case 'open': {
          const { queue: there } = fromListening({ ...next.listening, position: step.from })
          if (there.songs.length === 0) break
          if (step.at !== null) {
            holdUntil.current = step.at
            setHolding(true)
          }
          openPaused.current = step.paused
          begin(there, step.from)
          if (step.paused) setPaused(true)
          corrected.current = Math.max(now, step.at ?? now)
          break
        }
        case 'playAt':
          setHolding(true)
          controls.current?.playAt(step.from, step.at)
          corrected.current = step.at
          break
        case 'pause': {
          const version = next.version
          const pauseIt = (): void => {
            if (groupRef.current?.version !== version) return
            controls.current?.setPaused(true)
            controls.current?.seek(step.position)
          }
          const wait = step.at - Date.now()
          if (wait > 0) setTimeout(pauseIt, wait)
          else pauseIt()
          corrected.current = step.at
          break
        }
        case 'nothing':
          break
      }
    } finally {
      remote.current = false
    }
    // Said to the others once it lands, so their bars move at once (F12).
    setTimeout(() => tellRef.current(), Math.max(0, corrected.current - Date.now()) + 400)
  }
  const applyRef = useRef(applyGroup)
  applyRef.current = applyGroup
  const tellRef = useRef(tell)
  tellRef.current = tell

  /** Asks the host about the group; the answer is played at once. False if it couldn't be. */
  const askGroup = useCallback(async (request: MusicGroupRequest): Promise<boolean> => {
    if (groupsOk.current === false || !whoRef.current) return false
    try {
      const sent = Date.now()
      const answer = await api.musicGroup(request)
      const back = Date.now()
      groupsOk.current = true
      clockSamples.current = [
        ...clockSamples.current.slice(-19),
        { offset: answer.now - (sent + back) / 2, took: back - sent, at: back },
      ]
      offsetRef.current = bestOffset(clockSamples.current, back) ?? answer.now - back
      applyRef.current(answer.group ?? null)
      return true
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')) groupsOk.current = false
      return false
    }
  }, [])
  /** In a group, and asked by a hand here (not applying the group's own word). */
  const byHandInGroup = (): boolean => groupRef.current !== null && !remote.current

  const api_: MusicPlayerApi = useMemo(
    () => ({
      queue,
      current: queue ? currentOf(queue) : null,
      reconnecting,
      // About to start at an agreed moment: shown as playing.
      paused: paused && !holding,
      play: (paths, index, from, shuffle = false) => {
        if (paths.length === 0) return
        if (byHandInGroup()) {
          const chosen = queueOf(paths, index, from, shuffle)
          void askGroup({ action: 'set', listening: toListening(chosen, 0, Math.floor(Date.now() / 1000)), playing: true, leadMs: START_TOGETHER_MS })
          return
        }
        handChanged.current = !remote.current
        startTogether()
        begin(queueOf(paths, index, from, shuffle))
      },
      resume: (listening) => {
        const { queue: resumed, position } = fromListening(listening)
        if (resumed.songs.length === 0) return
        if (byHandInGroup()) {
          void askGroup({ action: 'set', listening: toListening(resumed, position, Math.floor(Date.now() / 1000)), playing: true, leadMs: START_TOGETHER_MS })
          return
        }
        handChanged.current = !remote.current
        startTogether()
        begin(resumed, position)
      },
      playNext: (paths) => setQueue((q) => (q ? queuePlayNext(q, paths) : q)),
      addToQueue: (paths) => setQueue((q) => (q ? queueAdd(q, paths) : q)),
      togglePause: () => {
        if (!queue) return
        // Playing together: the group plays or pauses, all at one moment.
        if (byHandInGroup()) {
          void askGroup({ action: 'set', playing: paused && !holding, leadMs: paused ? RESUME_TOGETHER_MS : PAUSE_TOGETHER_MS })
          return
        }
        // Played again with devices in sync: from here, a moment from now,
        // on all of them at once.
        if (paused && !remote.current && linkedRef.current.length > 0) {
          const at = Date.now() + RESUME_TOGETHER_MS
          const from = positionNow()
          setHolding(true)
          controls.current?.playAt(from, at)
          toLinked('play', from, undefined, at)
          return
        }
        controls.current?.togglePause()
        toLinked(paused ? 'play' : 'pause')
      },
      next: () => {
        if (byHandInGroup() && queue) {
          const moved = nextOf(queue)
          if (moved) void askGroup({ action: 'set', listening: toListening(moved, 0, Math.floor(Date.now() / 1000)), playing: true, leadMs: START_TOGETHER_MS })
          return
        }
        handChanged.current = !remote.current
        startTogether()
        setQueue((q) => {
          if (!q) return q
          const moved = nextOf(q)
          if (moved) startAt.current = 0
          return moved ?? q
        })
      },
      previous: () => {
        if (!queue) return
        const { queue: back, restart } = previousOf(queue, clockRef.current.position)
        if (byHandInGroup()) {
          void askGroup(
            restart
              ? { action: 'set', position: 0, leadMs: SEEK_TOGETHER_MS }
              : { action: 'set', listening: toListening(back, 0, Math.floor(Date.now() / 1000)), playing: true, leadMs: START_TOGETHER_MS },
          )
          return
        }
        if (restart) {
          controls.current?.seek(0)
          toLinked('seek', 0)
        } else {
          handChanged.current = !remote.current
          startTogether()
          startAt.current = 0
          setQueue(back)
        }
      },
      seek: (seconds) => {
        if (byHandInGroup()) {
          void askGroup({ action: 'set', position: seconds, leadMs: SEEK_TOGETHER_MS })
          return
        }
        controls.current?.seek(seconds)
        toLinked('seek', seconds)
        // Others see the jump at once, not at the next report.
        setTimeout(tell, 600)
      },
      setShuffle: (on) => setQueue((q) => (q ? shuffleOf(q, on) : q)),
      cycleRepeat: () => setQueue((q) => (q ? cycleRepeatOf(q) : q)),
      removeUpNext: (index) => setQueue((q) => (q ? queueRemove(q, index) : q)),
      moveUpNext: (from, to) => setQueue((q) => (q ? queueMove(q, from, to) : q)),
      expanded,
      setExpanded,
      stop: () => {
        // Put away here: the devices in sync play on, on their own.
        if (groupRef.current && !remote.current) {
          leaving.current = true
          void askGroup({ action: 'leave' })
        }
        toLinked('unlink')
        membershipSettles.current = Date.now() + MEMBERSHIP_SETTLES_MS
        setLinked([])
        leader.current = null
        setRate(1)
        setQueue(null)
        setExpanded(false)
      },
      // Playing together, the others in the group: as the host keeps it, or
      // as before 1.6.4.
      linked: group ? group.members.map((m) => m.device).filter((d) => d !== you.current) : linked,
      unlink: () => {
        if (groupRef.current) {
          leaving.current = true
          void askGroup({ action: 'leave' })
        }
        toLinked('unlink')
        membershipSettles.current = Date.now() + MEMBERSHIP_SETTLES_MS
        setLinked([])
        leader.current = null
        setRate(1)
      },
      others,
      hostOffset,
      playHere: (session) => {
        const { queue: there, position } = fromListening({
          ...session.report.listening,
          position: livePosition(session, hostOffset, Date.now()),
        })
        if (there.songs.length === 0) return
        setLinked([])
        leader.current = null
        setRate(1)
        // A group playing together: it ends, and every one of them stops (U12).
        if (isHostGroup(session.group)) {
          if (groupRef.current?.id === session.group) leaving.current = true
          void askGroup({ action: 'end', group: session.group })
        } else void api.musicCommand(session.device, 'stop').catch(() => {})
        begin(there, position)
      },
      playBoth: (asked) => {
        if (asked.report.listening.queue.length === 0) return
        // As the host keeps it: one group, both playing, even one paused (F7).
        if (groupsOk.current !== false) {
          setHolding(true)
          void askGroup({ action: 'start', with: asked.device, playing: true, leadMs: START_TOGETHER_MS }).then((done) => {
            if (!done) {
              setHolding(false)
              playBothBefore(asked)
            }
          })
          return
        }
        playBothBefore(asked)
      },
      steer: (session, action, position = 0) => {
        // A group playing together is steered as one: every one of them (F6).
        if (isHostGroup(session.group) && groupsOk.current !== false) {
          const group = session.group
          const listening = session.report.listening
          const ask = ((): MusicGroupRequest | null => {
            const now = Math.floor(Date.now() / 1000)
            switch (action) {
              case 'play':
              case 'pause':
                return { action: 'set', group, playing: action === 'play', leadMs: action === 'play' ? RESUME_TOGETHER_MS : PAUSE_TOGETHER_MS }
              case 'seek':
                return { action: 'set', group, position, leadMs: SEEK_TOGETHER_MS }
              case 'next': {
                const moved = nextOf(fromListening(listening).queue)
                return moved ? { action: 'set', group, listening: toListening(moved, 0, now), playing: true, leadMs: START_TOGETHER_MS } : null
              }
              case 'previous': {
                const { queue: back } = previousOf(fromListening(listening).queue, 0)
                return { action: 'set', group, listening: toListening(back, 0, now), playing: true, leadMs: START_TOGETHER_MS }
              }
              case 'stop':
                return { action: 'end', group }
              default:
                return null
            }
          })()
          if (ask) {
            void api.musicGroup(ask).then(
              () => void tell(),
              () => void tell(),
            )
            return
          }
        }
        steerBefore(session, action, position)
      },
    }),
    [queue, paused, holding, reconnecting, expanded, begin, others, hostOffset, tell, linked, toLinked, setRate, group, askGroup],
  )

  /** Playing together with another, as before 1.6.4: this one keeps to that one. */
  function playBothBefore(asked: NowSession): void {
    {
        // In sync from now on: this one keeps to that one, and tells it so.
        leader.current = asked.device
        corrected.current = Date.now() + START_TOGETHER_MS + CLOCK_CHECK_MS
        membershipSettles.current = Date.now() + MEMBERSHIP_SETTLES_MS
        leftUs.current.clear()
        setLinked([asked.device])
        setHolding(true)
        void api.musicCommand(asked.device, 'link').catch(() => {})
        void (async () => {
          // The host's clock first, to the millisecond: a few quick
          // questions, the quickest answer trusted. Then the other's latest
          // word on where it is.
          for (let i = 0; i < CLOCK_CHECKS; i++) await exchange({})
          const session = othersRef.current.find((s) => s.device === asked.device) ?? asked
          const offset = offsetRef.current
          // Not from where that one is now, but from where it will be a
          // moment from now, starting then: in step from the first second.
          const at = Date.now() + START_TOGETHER_MS
          const { queue: there } = fromListening(session.report.listening)
          if (there.songs.length === 0) {
            setHolding(false)
            return
          }
          holdUntil.current = at
          corrected.current = at
          begin(there, livePosition(session, offset, at))
        })()
    }
  }

  /** Another device steered on its own, as before 1.6.4. */
  function steerBefore(session: NowSession, action: MusicCommand['action'], position = 0): void {
    {
        // Shown at once; the device's own next report puts it right.
        if (action === 'play' || action === 'pause' || action === 'seek') {
          const now = Date.now() + hostOffset
          steeredAt.current.set(session.device, now)
          setOthers((list) =>
            list.map((s) =>
              s.device === session.device
                ? {
                    ...s,
                    at: now,
                    report: {
                      ...s.report,
                      playing: action === 'seek' ? s.report.playing : action === 'play',
                      // From this moment: the second counts on from now, not from its last word.
                      clock: now,
                      listening: {
                        ...s.report.listening,
                        position: action === 'seek' ? position : livePosition(s, hostOffset, Date.now()),
                      },
                    },
                  }
                : s,
            ),
          )
        }
        void api.musicCommand(session.device, action, position).catch(() => void tell())
    }
  }

  // Where it is this instant: the player tells its clock a few times a
  // second (a phone four), so the last one told is up to that much behind.
  const positionNow = (): number => {
    const { position, duration } = clockRef.current
    if (paused || clockMoved.current === 0) return position
    const since = Math.min(1, (Date.now() - clockMoved.current) / 1000)
    return duration > 0 ? Math.min(duration, position + since) : position + since
  }

  // What this device plays, as told to the others.
  report.current = () =>
    queue
      ? {
          listening: toListening(queue, positionNow(), Math.floor(Date.now() / 1000)),
          playing: !paused || holding,
          duration: clockRef.current.duration,
        }
      : null

  // What the others ask of this one.
  const latest = useRef(api_)
  latest.current = api_
  const obeyOne = (command: MusicCommand): void => {
    const music = latest.current
    switch (command.action) {
      // Who joined or left: the host keeps the group, and this answer
      // already says who is in it now. One that left is remembered as
      // having left, so a host restart does not put it back.
      case 'link':
        leftUs.current.delete(command.fromDevice)
        break
      case 'unlink':
        leftUs.current.add(command.fromDevice)
        break
      case 'load': {
        const there = command.listening
        if (!there) break
        const song = there.queue[there.index]
        // When the other starts it, here: then, or as far in as it is by now.
        const at = command.clock ? command.clock - offsetRef.current : null
        const late = at === null ? 0 : Math.max(0, (Date.now() - at) / 1000)
        if (song && song === music.current) {
          if (at !== null && at > Date.now()) {
            setHolding(true)
            controls.current?.playAt(there.position, at)
          } else {
            const from = there.position + late
            if (Math.abs(from - positionNow()) > SEEK_ABOVE_SECONDS) music.seek(from)
            if (music.paused) music.togglePause()
          }
        } else {
          if (at !== null && at > Date.now()) {
            holdUntil.current = at
            setHolding(true)
          }
          music.resume({ ...there, position: there.position + late })
        }
        corrected.current = Math.max(Date.now(), at ?? 0)
        break
      }
      case 'play': {
        const at = command.clock ? command.clock - offsetRef.current : null
        if (at !== null) {
          // From the second it was paused at there, at the agreed moment.
          setHolding(true)
          controls.current?.playAt(command.position + Math.max(0, (Date.now() - at) / 1000), Math.max(at, Date.now()))
          corrected.current = Math.max(Date.now(), at)
        } else if (music.paused) music.togglePause()
        break
      }
      case 'pause':
        if (!music.paused) music.togglePause()
        break
      case 'next':
        music.next()
        break
      case 'previous':
        music.previous()
        break
      case 'seek':
        music.seek(command.position)
        break
      case 'stop':
        music.stop()
        break
    }
  }
  obey.current = (commands) => {
    // Done because another device asked: never sent back to it.
    remote.current = true
    try {
      for (const command of commands) obeyOne(command)
    } finally {
      remote.current = false
    }
  }

  // Keeping to the device this one joined: the same song, play or pause as
  // it does, and the same second, within a quarter of one.
  const othersRef = useRef(others)
  othersRef.current = others
  const position = useRef(positionNow)
  position.current = positionNow
  const following = linked.length > 0 && queue !== null
  useEffect(() => {
    if (!following) return undefined
    let busy = false
    const follow = async (): Promise<void> => {
      const id = leader.current
      if (!id || holdingRef.current) return
      const theirs = othersRef.current.find((s) => s.device === id)
      // Gone without a word (closed, off the network): the host forgets it
      // in a few seconds and names another for the group to keep to.
      if (!theirs) return
      // Said before this one last changed, or too soon after: a seek takes a
      // moment to land, and the other a moment to say what it did.
      const said = (theirs.report.clock ?? theirs.at) - offsetRef.current
      if (said < corrected.current || Date.now() - corrected.current < SETTLE_MS) return
      const music = latest.current
      if (remoteSong(theirs) !== music.current) {
        remote.current = true
        try {
          music.resume({ ...theirs.report.listening, position: livePosition(theirs, offsetRef.current, Date.now()) })
        } finally {
          remote.current = false
        }
        setRate(1)
        gaps.current = []
        corrected.current = Date.now()
        return
      }
      if (theirs.report.playing === music.paused) {
        remote.current = true
        try {
          music.togglePause()
        } finally {
          remote.current = false
        }
      }
      // Paused there, the second is not checked: it is where it was.
      if (!theirs.report.playing) {
        setRate(1)
        return
      }
      // Both at the same moment: this one read from its player, that one from
      // what it said, moved on to then on the host's clock.
      const mine = (await measure.current()) ?? { position: position.current(), at: Date.now() }
      if (leader.current !== id || said < corrected.current) return
      const step = keepInStep({
        theirSong: remoteSong(theirs),
        mySong: latest.current.current,
        theirs: livePosition(theirs, offsetRef.current, mine.at),
        mine: mine.position,
        lead: lead.current,
        landed: checkLanding.current,
        rate: rate.current,
        before: gaps.current,
      })
      if (step.do === 'load') return
      checkLanding.current = false
      lead.current = step.lead
      gaps.current = [...gaps.current.slice(-4), livePosition(theirs, offsetRef.current, mine.at) - mine.position]
      if (step.do === 'seek') {
        gaps.current = []
        setRate(1)
        controls.current?.seek(step.to)
        corrected.current = Date.now()
        checkLanding.current = true
      } else setRate(step.rate)
    }
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void follow().finally(() => {
        busy = false
      })
    }, FOLLOW_EVERY_MS)
    return () => clearInterval(timer)
  }, [following, setRate])

  // Keeping to the group's state: the same song, play or pause as it says,
  // and the same second, by the host's clock. Every member does the same.
  const inGroup = group !== null && queue !== null
  useEffect(() => {
    if (!inGroup) return undefined
    let busy = false
    const follow = async (): Promise<void> => {
      const g = groupRef.current
      if (!g || holdingRef.current || Date.now() - corrected.current < SETTLE_MS) return
      const music = latest.current
      // Not as it says (a start that didn't come, a pause missed): played again.
      if (groupSong(g) !== music.current || g.playing === music.paused) {
        applied.current = null
        applyRef.current(g)
        return
      }
      if (!g.playing) {
        setRate(1)
        return
      }
      const mine = (await measure.current()) ?? { position: position.current(), at: Date.now() }
      const now = groupRef.current
      if (!now || now.version !== g.version || Date.now() - corrected.current < SETTLE_MS) return
      const theirs = groupPosition(g, mine.at + offsetRef.current)
      const step = keepInStep({
        theirSong: groupSong(g),
        mySong: latest.current.current,
        theirs,
        mine: mine.position,
        lead: lead.current,
        landed: checkLanding.current,
        rate: rate.current,
        before: gaps.current,
      })
      if (step.do === 'load') return
      checkLanding.current = false
      lead.current = step.lead
      gaps.current = [...gaps.current.slice(-4), theirs - mine.position]
      if (step.do === 'seek') {
        gaps.current = []
        setRate(1)
        controls.current?.seek(step.to)
        corrected.current = Date.now()
        checkLanding.current = true
      } else setRate(step.rate)
    }
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void follow().finally(() => {
        busy = false
      })
    }, FOLLOW_EVERY_MS)
    return () => clearInterval(timer)
  }, [inGroup, setRate])

  // The group's every change, as it happens, down the device channel.
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void onChannel((message) => {
      if (message.kind !== 'music.group') return
      const body = message.body as { group?: MusicGroup | null; ended?: boolean }
      applyRef.current(body.group ?? null, body.ended === true)
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [])

  // The group this device is in, as the host keeps it: at the start, with
  // another profile or drive, and back in front (a change may have been
  // missed while away, F3).
  useEffect(() => {
    groupsOk.current = null
    applyRef.current(null)
    if (!who) return undefined
    void api
      .presence()
      .then((p) => (you.current = p.you))
      .catch(() => {})
    void askGroup({ action: 'view' })
    const back = (): void => {
      if (document.visibilityState === 'visible') void askGroup({ action: 'view' })
    }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [who, askGroup])

  // Another profile, another drive, or none: the last one's devices go, and
  // the new one's are asked for.
  useEffect(() => {
    setOthers([])
    unknown.current = false
    if (who) tell()
  }, [who, tell])
  // Asked again when it may have missed something (F3): back in front, and
  // when a device comes or goes (this one's own connection back included).
  useEffect(() => {
    if (!who) return undefined
    const back = (): void => {
      if (document.visibilityState === 'visible') tell()
    }
    document.addEventListener('visibilitychange', back)
    let stop: (() => void) | null = null
    let gone = false
    void onPresence(() => tell()).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      document.removeEventListener('visibilitychange', back)
      gone = true
      stop?.()
    }
  }, [who, tell])

  // Told when something changes on the profile's other devices.
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    // What the others ask is fetched at once: a song to start together
    // has only a moment to open. What this one plays is told after.
    void onMusicNow(() => void exchange({}).then(tell)).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [tell, exchange])

  // Told what plays here: a new song, play or pause at once, and every few
  // seconds while it plays so the others' clocks stay right. Stopping says so.
  const playingSong = queue ? currentOf(queue) : null
  const at = queue?.at
  const wasPlaying = useRef(false)
  useEffect(() => {
    if (queue) {
      wasPlaying.current = true
      tell()
    } else if (wasPlaying.current) {
      wasPlaying.current = false
      void exchange({ stopped: true })
    }
    // `queue` itself changes as songs are added; the song and its place are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingSong, at, paused, tell, exchange])
  // A song chosen by a hand here goes to the devices in sync, from its start.
  useEffect(() => {
    if (!handChanged.current || !queue) return
    handChanged.current = false
    const startsAt = handStart.current ?? undefined
    handStart.current = null
    toLinked('load', startAt.current, toListening(queue, startAt.current, Math.floor(Date.now() / 1000)), startsAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingSong, at, toLinked])

  // Paused, it still says it is there, less often: the host forgets a device
  // silent for 20 s, and a paused one forgotten could not be asked to stop
  // when its music moved to another device.
  const hasQueue = queue !== null
  const inSync = linked.length > 0
  useEffect(() => {
    if (!hasQueue) return undefined
    const every = paused ? REPORT_PAUSED_EVERY_MS : inSync ? REPORT_IN_SYNC_EVERY_MS : REPORT_EVERY_MS
    const timer = setInterval(tell, every)
    return () => clearInterval(timer)
  }, [hasQueue, paused, inSync, tell])
  // While another plays, asked now and then: one that went away without a
  // word (off the network, out of battery) is forgotten by the host.
  const othersPlaying = others.length > 0
  useEffect(() => {
    if (!othersPlaying) return undefined
    const timer = setInterval(tell, CHECK_OTHERS_MS)
    return () => clearInterval(timer)
  }, [othersPlaying, tell])

  // A new song starts at nothing: mpv's clock still says where the last one
  // was until the next file opens, and the bar, the lock screen and the rest
  // would show the new song that far in.
  const playingNow = queue ? currentOf(queue) : null
  const turn = queue?.at
  useEffect(() => {
    if (clock.duration > 0) failures.current = 0
  }, [clock.duration])
  useEffect(() => {
    setClock((c) => ({ ...c, position: 0, duration: 0 }))
  }, [playingNow, turn])

  const clockValue: MusicClock = useMemo(
    () => ({ ...clock, setVolume: (volume) => controls.current?.setVolume(volume) }),
    [clock],
  )

  // The keyboard's media keys, and a remote's, while music plays and the
  // app is in front. The lock screen and the system's own controls are
  // `SystemMedia`'s. A film open takes the keys for itself.
  const keys = useRef(api_)
  keys.current = api_
  useEffect(() => {
    if (!queue) return undefined
    const onKey = (e: KeyboardEvent): void => {
      const press = pressForKey(e.key)
      if (!press) return
      e.preventDefault()
      // The same key may reach the system's media controls too: one press.
      if (!claimPress(press)) return
      const music = keys.current
      if (press === 'toggle') music.togglePause()
      else if (press === 'play' && music.paused) music.togglePause()
      else if (press === 'pause' && !music.paused) music.togglePause()
      else if (press === 'next') music.next()
      else if (press === 'previous') music.previous()
      else if (press === 'stop') music.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [queue])

  // Kept for Continue listening: when the song changes, when it pauses, and
  // every so often while it plays.
  const saving = useRef(onListening)
  saving.current = onListening
  const save = useCallback(() => {
    if (!queue) return
    saving.current(toListening(queue, clockRef.current.position, Math.floor(Date.now() / 1000)))
  }, [queue])
  useEffect(() => {
    save()
  }, [queue, paused, save])
  useEffect(() => {
    if (!queue || paused) return undefined
    const timer = setInterval(save, 15_000)
    return () => clearInterval(timer)
  }, [queue, paused, save])

  return (
    <MusicPlayerContext.Provider value={api_}>
      <MusicClockContext.Provider value={clockValue}>
        {children}
        {queue && (
          <Engine
            path={currentOf(queue)}
            turn={queue.at}
            again={again}
            startAt={startAt}
            holdUntil={holdUntil}
            startLag={startLag}
            openPaused={openPaused}
            onStarted={(position, at) => {
              setHolding(false)
              if (position !== null) checkStart(position, at)
            }}
            controls={controls}
            onClock={clockChanged}
            onPaused={setPaused}
            onFailed={() =>
              void hostReachable(connectedRef.current).then((reachable) => {
                // The host out of reach: every song would fail the same. This
                // one waits for it, from where it was, rather than skipping
                // through the whole queue.
                if (!reachable) {
                  waitFrom.current = clockRef.current.position
                  setReconnecting(true)
                  return
                }
                setQueue((q) => {
                  if (!q) return q
                  failures.current += 1
                  const moved = nextOf(q, true)
                  // Every song tried and none would open: paused, not looping.
                  if (!moved || failures.current >= q.songs.length) {
                    failures.current = 0
                    setPaused(true)
                    return q
                  }
                  startAt.current = 0
                  return moved
                })
              })
            }
            onEnded={() => {
              // Playing together: the group moves on, once, whoever asks
              // first; the others' "next" as of the same version is refused.
              const playingGroup = groupRef.current
              if (playingGroup && queue) {
                const moved = nextOf(queue, true)
                void askGroup(
                  moved
                    ? {
                        action: 'set',
                        expect: playingGroup.version,
                        listening: toListening(moved, 0, Math.floor(Date.now() / 1000)),
                        playing: true,
                        leadMs: NEXT_TOGETHER_MS,
                      }
                    : { action: 'set', expect: playingGroup.version, playing: false, leadMs: 0 },
                )
                return
              }
              // Following another: it says what comes next, and when, so both
              // start it together. Not heard from in a few seconds, on alone.
              if (leader.current && linkedRef.current.length > 0) {
                const ending = queue ? currentOf(queue) : null
                setTimeout(() => {
                  if (latest.current.current === ending && latest.current.queue && !holdingRef.current) {
                    latest.current.next()
                  }
                }, AWAIT_LEADER_MS)
                return
              }
              // Followed by others: the next song starts together.
              if (linkedRef.current.length > 0) {
                handChanged.current = true
                startTogether()
              }
              setQueue((q) => {
                if (!q) return q
                const moved = nextOf(q, true)
                startAt.current = 0
                // The last song done: the queue stays, paused at its end.
                if (!moved) {
                  setPaused(true)
                  return q
                }
                // Repeat one: the same song again, from the top.
                if (moved.at === q.at) controls.current?.restart()
                return moved
              })
            }}
          />
        )}
      </MusicClockContext.Provider>
    </MusicPlayerContext.Provider>
  )
}

/**
 * How far ahead a song started together is started: time for each device
 * to open it and have it ready, paused at its first second.
 */
const START_TOGETHER_MS = 1_800
/** The same, for playing on after a pause: the song is open already. */
const RESUME_TOGETHER_MS = 500
/** A pause, a moment ahead: every device in a group pauses at the same second. */
const PAUSE_TOGETHER_MS = 250
/** A seek, ahead by the time it takes each device to land there. */
const SEEK_TOGETHER_MS = 600
/** The next song when one ends, playing together: a moment to open it everywhere. */
const NEXT_TOGETHER_MS = 1_200
/** The longest a start at a moment is waited for. */
const HOLD_AT_MOST_MS = 8_000
/** Following another, how long a song ended waits for it to say what is next. */
const AWAIT_LEADER_MS = 4_000

/** After joining or leaving, how long the host is given to have heard of it. */
const MEMBERSHIP_SETTLES_MS = 3_000

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((d) => b.includes(d))
}

/** Quick questions to the host before starting together, to know its clock well. */
const CLOCK_CHECKS = 4
/** About how long they take. */
const CLOCK_CHECK_MS = 300

/** While waiting for the host, how often the song is tried again. */
const RETRY_HOST_MS = 4_000

/**
 * Whether the host answers. The app's own word first: not connected is not
 * reachable. Connected by its word, asked: a failure to open a song comes a
 * moment before the app notices the host has gone.
 */
async function hostReachable(connected: boolean): Promise<boolean> {
  if (!connected) return false
  try {
    await Promise.race([
      api.musicNow({}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), 3_000)),
    ])
    return true
  } catch (e) {
    // An answer, even "not known here", is the host answering.
    return e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')
  }
}

/** Ready too late to start with the others: how far further on it starts instead, in seconds. */
const CATCH_UP_MARGIN_S = 0.8

/** How long after a start at a moment it checks where it got to. */
const START_CHECK_MS = 1_200
/** The most a player is taken to need to make sound once unpaused. */
const MAX_START_LAG_MS = 400

function readStartLag(): number {
  try {
    const kept = Number(localStorage.getItem('basalt.music.startLag'))
    return Number.isFinite(kept) ? Math.max(0, Math.min(MAX_START_LAG_MS, kept)) : 0
  } catch {
    return 0
  }
}

function saveStartLag(ms: number): void {
  try {
    localStorage.setItem('basalt.music.startLag', String(Math.round(ms)))
  } catch {
    // Not kept: learnt again next time.
  }
}

/** How often a device in sync checks it keeps to the other. */
const FOLLOW_EVERY_MS = 1_000
/** After a correction, how long before the next: a seek takes a moment to land. */
const SETTLE_MS = 3_000

/** How often a device playing tells the others where it is. */
const REPORT_EVERY_MS = 5_000
/** In sync, more often: the others keep to it to the millisecond. */
const REPORT_IN_SYNC_EVERY_MS = 2_000
/** How often a paused one says it is still there: well inside the host's 20 s. */
const REPORT_PAUSED_EVERY_MS = 8_000
/** How often a device asks after the others while one plays. */
const CHECK_OTHERS_MS = 10_000

interface EngineControls {
  togglePause: () => void
  /** The song playing, from its start, playing. */
  restart: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  /** Quick reads of the player's clock, to work out the second exactly. Null in the page preview. */
  read: () => Promise<Reading[] | null>
  /** Plays a hair faster or slower, to make up a gap with a device in sync. */
  setRate: (rate: number) => void
  /** Paused at `position`, then playing from it at `at` (Unix ms). */
  playAt: (position: number, at: number) => void
  /** Paused or playing, as asked; a start waited for is given up. */
  setPaused: (paused: boolean) => void
}

/** Reads of the player's clock taken to work out the second: about a fifth of a second's worth. */
const CLOCK_READS = 16

/**
 * mpv, playing the song at `path`. Mounted only while there is a queue, so
 * the film player has mpv to itself otherwise.
 */
function Engine({
  path,
  turn,
  again,
  startAt,
  holdUntil,
  startLag,
  openPaused,
  onStarted,
  controls,
  onClock,
  onPaused,
  onEnded,
  onFailed,
}: {
  path: string | null
  /** Its place in the queue: the same song twice in a row still loads again. */
  turn: number
  /** Opened again when this moves on: after the host came back. */
  again: number
  startAt: React.MutableRefObject<number>
  /** When the song opened next starts (Unix ms), opened paused until then. Taken as it opens. */
  holdUntil: React.MutableRefObject<number | null>
  /** How long the player takes to make sound once unpaused (ms): unpaused that much early. */
  startLag: React.MutableRefObject<number>
  /** The song opened next stays paused: a group that is paused. Taken as it opens. */
  openPaused: React.MutableRefObject<boolean>
  /** A song held for its moment has started: from where, and at what moment; or nothing was held. */
  onStarted: (position: number | null, at: number) => void
  controls: React.MutableRefObject<EngineControls | null>
  onClock: (clock: { position: number; duration: number; volume: number }) => void
  onPaused: (paused: boolean) => void
  onEnded: () => void
  /** The song could not be opened at all. */
  onFailed: () => void
}): null {
  const mpv = useMpv()
  const { load, stop, togglePause, seekTo, setVolume } = mpv
  /** Which wait for a moment is the latest: an older one gives way. */
  const waiting = useRef(0)
  const started = useRef(onStarted)
  started.current = onStarted

  /**
   * Plays at `at` (Unix ms) from `position`, once the song is ready there:
   * opened, done seeking. Ready only after `at`, it starts as far in as it
   * would be by then.
   */
  /** Waits until the song is open and done seeking; false if it was given up on meanwhile. */
  const ready = async (mine: number): Promise<boolean> => {
    const until = Date.now() + 8_000
    for (;;) {
      if (waiting.current !== mine) return false
      const [pos, seeking] = await Promise.all([
        mpvBackend.getProperty('time-pos', 'double').catch(() => null),
        mpvBackend.getProperty('seeking', 'flag').catch(() => null),
      ])
      if ((pos !== null && seeking === false) || Date.now() > until) return true
      await new Promise((done) => setTimeout(done, 40))
    }
  }

  const release = async (position: number, at: number, mine: number): Promise<void> => {
    if (!inTauri()) {
      started.current(null, at)
      return
    }
    if (!(await ready(mine))) return
    // `target` is played from at `when`: where the others are then.
    let target = position
    let when = at
    // Ready too late for the moment (a slow phone, a slow network): not
    // started late and made up after. Moved on to a point a little further,
    // where the others will be once it is there, and started exactly then.
    for (let tries = 1; when - startLag.current < Date.now() && tries <= 3; tries++) {
      target = position + (Date.now() - at) / 1000 + CATCH_UP_MARGIN_S * tries
      when = at + (target - position) * 1000
      await seekTo(target)
      if (!(await ready(mine))) return
    }
    // Unpaused a little before the moment, by as long as this player takes
    // to make sound.
    const wait = when - startLag.current - Date.now()
    if (wait > 0) await new Promise((done) => setTimeout(done, wait))
    if (waiting.current !== mine) return
    await mpv.setPaused(false)
    // Still late after all that: not a measure of the player's own delay.
    started.current(wait > -40 ? target : null, when)
  }

  controls.current = {
    togglePause: () => {
      // At the end of the last song, play starts it again.
      if (mpv.ended) void seekTo(0).then(() => mpv.setPaused(false))
      else void togglePause()
    },
    restart: () => void seekTo(0).then(() => mpv.setPaused(false)),
    seek: (seconds) => void seekTo(Math.max(0, seconds)),
    setVolume: (volume) => {
      const level = Math.max(0, Math.min(100, volume))
      rememberVolume('music', level)
      void setVolume(level)
    },
    read: async () => {
      if (!inTauri()) return null
      const readings: Reading[] = []
      for (let i = 0; i < CLOCK_READS; i++) {
        const sent = Date.now()
        const position = Number(await mpvBackend.getProperty('time-pos', 'double'))
        const back = Date.now()
        if (Number.isFinite(position)) readings.push({ position, at: (sent + back) / 2, took: back - sent })
        await new Promise((done) => setTimeout(done, 13))
      }
      return readings
    },
    setPaused: (paused) => {
      ++waiting.current
      void mpv.setPaused(paused)
    },
    playAt: (position, at) => {
      const mine = ++waiting.current
      void mpv
        .setPaused(true)
        .then(() => seekTo(Math.max(0, position)))
        .then(() => release(position, at, mine))
    },
    // mpv keeps the pitch at a speed this close to 1.
    setRate: (rate) => {
      if (inTauri()) void mpvBackend.command('set', ['speed', rate.toFixed(4)]).catch(() => {})
    },
  }

  useEffect(() => {
    if (!path) return undefined
    let cancelled = false
    const from = startAt.current
    startAt.current = 0
    // To start at an agreed moment: opened paused, and played then.
    const at = holdUntil.current
    holdUntil.current = null
    const paused = openPaused.current
    openPaused.current = false
    const mine = ++waiting.current
    // Opened at once: any wait for a moment before it is over.
    if (at === null) started.current(null, Date.now())
    void api.mediaUrl(path).then(async (url) => {
      if (cancelled) return
      // At music's own volume, as last set: not the film's, nor full.
      await setVolume(rememberedVolume('music'))
      if (cancelled) return
      void load(url, from, undefined, true, at !== null || paused).then(() => {
        if (at !== null) void release(from, at, mine)
      })
    })
    return () => {
      cancelled = true
    }
    // `release` is the same work every render; the song is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, turn, again, load, startAt, holdUntil, setVolume])

  // Stopped when the queue goes: the film player may want mpv next, at its
  // own speed.
  useEffect(
    () => () => {
      void stop()
      if (inTauri()) void mpvBackend.command('set', ['speed', '1']).catch(() => {})
    },
    [stop],
  )

  useEffect(() => {
    onClock({ position: mpv.position, duration: mpv.duration, volume: mpv.volume })
  }, [mpv.position, mpv.duration, mpv.volume, onClock])

  useEffect(() => {
    onPaused(mpv.paused)
  }, [mpv.paused, onPaused])

  const ended = useRef(onEnded)
  ended.current = onEnded
  useEffect(() => {
    if (mpv.ended) ended.current()
  }, [mpv.ended])

  const failed = useRef(onFailed)
  failed.current = onFailed
  useEffect(() => {
    if (mpv.loadFailed) failed.current()
  }, [mpv.loadFailed])

  return null
}
