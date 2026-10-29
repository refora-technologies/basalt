import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api, onMusicNow, type Listening, type MusicCommand, type NowReport, type NowSession } from '@/lib/api'
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
import { useMpv } from '@/lib/useMpv'
import { livePosition } from '@/lib/musicNow'

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

  const exchange = useCallback(async (request: { report?: NowReport; stopped?: boolean }) => {
    const asked = whoRef.current
    if (!asked || unknown.current) return
    try {
      const answer = await api.musicNow(request)
      if (whoRef.current !== asked) return
      setHostOffset(answer.now - Date.now())
      setOthers(answer.sessions)
      if (answer.commands.length > 0) obey.current(answer.commands)
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'unsupported' || e.kind === 'incompatible')) unknown.current = true
    }
  }, [])
  const tell = useCallback(() => {
    const now = report.current()
    void exchange(now ? { report: now } : {})
  }, [exchange])

  const api_: MusicPlayerApi = useMemo(
    () => ({
      queue,
      current: queue ? currentOf(queue) : null,
      paused,
      play: (paths, index, from, shuffle = false) => {
        if (paths.length === 0) return
        begin(queueOf(paths, index, from, shuffle))
      },
      resume: (listening) => {
        const { queue: resumed, position } = fromListening(listening)
        if (resumed.songs.length > 0) begin(resumed, position)
      },
      playNext: (paths) => setQueue((q) => (q ? queuePlayNext(q, paths) : q)),
      addToQueue: (paths) => setQueue((q) => (q ? queueAdd(q, paths) : q)),
      togglePause: () => {
        if (!queue) return
        controls.current?.togglePause()
      },
      next: () =>
        setQueue((q) => {
          if (!q) return q
          const moved = nextOf(q)
          if (moved) startAt.current = 0
          return moved ?? q
        }),
      previous: () => {
        if (!queue) return
        const { queue: back, restart } = previousOf(queue, clockRef.current.position)
        if (restart) controls.current?.seek(0)
        else {
          startAt.current = 0
          setQueue(back)
        }
      },
      seek: (seconds) => {
        controls.current?.seek(seconds)
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
        setQueue(null)
        setExpanded(false)
      },
      others,
      hostOffset,
      playHere: (session) => {
        const { queue: there, position } = fromListening({
          ...session.report.listening,
          position: livePosition(session, hostOffset, Date.now()),
        })
        if (there.songs.length === 0) return
        begin(there, position)
        void api.musicCommand(session.device, 'stop').catch(() => {})
      },
      playBoth: (session) => {
        const { queue: there, position } = fromListening({
          ...session.report.listening,
          position: livePosition(session, hostOffset, Date.now()),
        })
        if (there.songs.length > 0) begin(there, position)
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
    [queue, paused, expanded, begin, others, hostOffset, tell],
  )

  // What this device plays, as told to the others.
  report.current = () =>
    queue
      ? {
          listening: toListening(queue, clockRef.current.position, Math.floor(Date.now() / 1000)),
          playing: !paused,
          duration: clockRef.current.duration,
        }
      : null

  // What the others ask of this one.
  const latest = useRef(api_)
  latest.current = api_
  obey.current = (commands) => {
    for (const command of commands) {
      const music = latest.current
      switch (command.action) {
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
  }

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
  // Paused, it still says it is there, less often: the host forgets a device
  // silent for 20 s, and a paused one forgotten could not be asked to stop
  // when its music moved to another device.
  const hasQueue = queue !== null
  useEffect(() => {
    if (!hasQueue) return undefined
    const timer = setInterval(tell, paused ? REPORT_PAUSED_EVERY_MS : REPORT_EVERY_MS)
    return () => clearInterval(timer)
  }, [hasQueue, paused, tell])
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
            onClock={setClock}
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

/** How often a device playing tells the others where it is. */
const REPORT_EVERY_MS = 5_000
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
}

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

  // Stopped when the queue goes: the film player may want mpv next.
  useEffect(() => () => void stop(), [stop])

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
