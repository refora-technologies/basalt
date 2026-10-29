import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api, inTauri, onMusicNow, type Listening, type MusicCommand, type NowReport, type NowSession } from '@/lib/api'
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
  children: React.ReactNode
}): React.JSX.Element {
  const [queue, setQueue] = useState<Queue | null>(null)
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

  const begin = useCallback((next: Queue, at = 0) => {
    startAt.current = at
    setQueue(next)
    setPaused(false)
    starts.current()
  }, [])

  // ---- Shared with the profile's other devices ----
  const [others, setOthers] = useState<NowSession[]>([])
  const [hostOffset, setHostOffset] = useState(0)
  /** A host that does not know of it: asked no more. */
  const unknown = useRef(false)
  const obey = useRef<(commands: MusicCommand[]) => void>(() => {})
  const report = useRef<() => NowReport | null>(() => null)
  const whoRef = useRef(who)
  whoRef.current = who

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
  /** Checks in a row the leader was not there: past a few, it plays on alone. */
  const leaderMissing = useRef(0)
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
  const toLinked = useCallback((action: MusicCommand['action'], position = 0, listening?: Listening) => {
    if (remote.current) return
    corrected.current = Date.now()
    for (const device of linkedRef.current) {
      void api.musicCommand(device, action, position, listening).catch(() => {})
    }
  }, [])

  /** The host's clock less this one's, as worked out from the quickest answers. */
  const offsetRef = useRef(0)
  const clockSamples = useRef<ClockSample[]>([])
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
      setOthers(answer.sessions)
      if (answer.commands.length > 0) obey.current(answer.commands)
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')) unknown.current = true
    }
  }, [])
  const tell = useCallback(() => {
    void (async () => {
      let now = report.current()
      // In sync, where the song is is read from the player to the
      // millisecond, with the moment on the host's clock.
      if (now?.playing && linkedRef.current.length > 0) {
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

  const api_: MusicPlayerApi = useMemo(
    () => ({
      queue,
      current: queue ? currentOf(queue) : null,
      paused,
      play: (paths, index, from, shuffle = false) => {
        if (paths.length === 0) return
        handChanged.current = !remote.current
        begin(queueOf(paths, index, from, shuffle))
      },
      resume: (listening) => {
        const { queue: resumed, position } = fromListening(listening)
        if (resumed.songs.length === 0) return
        handChanged.current = !remote.current
        begin(resumed, position)
      },
      playNext: (paths) => setQueue((q) => (q ? queuePlayNext(q, paths) : q)),
      addToQueue: (paths) => setQueue((q) => (q ? queueAdd(q, paths) : q)),
      togglePause: () => {
        if (!queue) return
        controls.current?.togglePause()
        toLinked(paused ? 'play' : 'pause')
      },
      next: () => {
        handChanged.current = !remote.current
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
        if (restart) {
          controls.current?.seek(0)
          toLinked('seek', 0)
        } else {
          handChanged.current = !remote.current
          startAt.current = 0
          setQueue(back)
        }
      },
      seek: (seconds) => {
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
        toLinked('unlink')
        setLinked([])
        leader.current = null
        setRate(1)
        setQueue(null)
        setExpanded(false)
      },
      linked,
      unlink: () => {
        toLinked('unlink')
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
        begin(there, position)
        void api.musicCommand(session.device, 'stop').catch(() => {})
      },
      playBoth: (session) => {
        const { queue: there, position } = fromListening({
          ...session.report.listening,
          position: livePosition(session, hostOffset, Date.now()),
        })
        if (there.songs.length === 0) return
        begin(there, position)
        // In sync from now on: this one keeps to that one, and tells it so.
        leader.current = session.device
        leaderMissing.current = 0
        corrected.current = Date.now()
        setLinked([session.device])
        void api.musicCommand(session.device, 'link').catch(() => {})
      },
      steer: (session, action, position = 0) => {
        // Shown at once; the device's own next report puts it right.
        if (action === 'play' || action === 'pause') {
          setOthers((list) =>
            list.map((s) =>
              s.device === session.device
                ? {
                    ...s,
                    at: Date.now() + hostOffset,
                    report: {
                      ...s.report,
                      playing: action === 'play',
                      listening: { ...s.report.listening, position: livePosition(s, hostOffset, Date.now()) },
                    },
                  }
                : s,
            ),
          )
        }
        void api.musicCommand(session.device, action, position).catch(() => void tell())
      },
    }),
    [queue, paused, expanded, begin, others, hostOffset, tell, linked, toLinked, setRate],
  )

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
          playing: !paused,
          duration: clockRef.current.duration,
        }
      : null

  // What the others ask of this one.
  const latest = useRef(api_)
  latest.current = api_
  const obeyOne = (command: MusicCommand): void => {
    const music = latest.current
    switch (command.action) {
      case 'link':
        setLinked((l) => (l.includes(command.fromDevice) ? l : [...l, command.fromDevice]))
        break
      case 'unlink':
        setLinked((l) => l.filter((d) => d !== command.fromDevice))
        if (leader.current === command.fromDevice) {
          leader.current = null
          setRate(1)
        }
        break
      case 'load': {
        const there = command.listening
        if (!there) break
        const song = there.queue[there.index]
        if (song && song === music.current) {
          if (Math.abs(there.position - positionNow()) > SEEK_ABOVE_SECONDS) music.seek(there.position)
          if (music.paused) music.togglePause()
        } else music.resume(there)
        break
      }
      case 'play':
        if (music.paused) music.togglePause()
        break
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
      if (!id) return
      const theirs = othersRef.current.find((s) => s.device === id)
      if (!theirs) {
        // Gone without a word (closed, off the network): on its own now.
        leaderMissing.current += 1
        if (leaderMissing.current >= 4) {
          leader.current = null
          setLinked((l) => l.filter((d) => d !== id))
        }
        return
      }
      leaderMissing.current = 0
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

  // Another profile, another drive, or none: the last one's devices go, and
  // the new one's are asked for.
  useEffect(() => {
    setOthers([])
    unknown.current = false
    if (who) tell()
  }, [who, tell])

  // Told when something changes on the profile's other devices.
  useEffect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void onMusicNow(() => tell()).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [tell])

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
    toLinked('load', startAt.current, toListening(queue, startAt.current, Math.floor(Date.now() / 1000)))
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
            startAt={startAt}
            controls={controls}
            onClock={clockChanged}
            onPaused={setPaused}
            onFailed={() =>
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
            }
            onEnded={() =>
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
            }
          />
        )}
      </MusicClockContext.Provider>
    </MusicPlayerContext.Provider>
  )
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
  startAt,
  controls,
  onClock,
  onPaused,
  onEnded,
  onFailed,
}: {
  path: string | null
  /** Its place in the queue: the same song twice in a row still loads again. */
  turn: number
  startAt: React.MutableRefObject<number>
  controls: React.MutableRefObject<EngineControls | null>
  onClock: (clock: { position: number; duration: number; volume: number }) => void
  onPaused: (paused: boolean) => void
  onEnded: () => void
  /** The song could not be opened at all. */
  onFailed: () => void
}): null {
  const mpv = useMpv()
  const { load, stop, togglePause, seekTo, setVolume } = mpv

  controls.current = {
    togglePause: () => {
      // At the end of the last song, play starts it again.
      if (mpv.ended) void seekTo(0).then(() => mpv.setPaused(false))
      else void togglePause()
    },
    restart: () => void seekTo(0).then(() => mpv.setPaused(false)),
    seek: (seconds) => void seekTo(Math.max(0, seconds)),
    setVolume: (volume) => void setVolume(Math.max(0, Math.min(100, volume))),
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
    void api.mediaUrl(path).then((url) => {
      if (!cancelled) void load(url, from, undefined, true)
    })
    return () => {
      cancelled = true
    }
  }, [path, turn, load, startAt])

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
