import { describe, expect, it } from 'vitest'
import {
  SKIP_RUN_MS,
  skipTarget,
  hasEnded,
  judgeOpening,
  needsLighterPlayback,
  OPENING,
  type OpeningProbe,
  type OpeningWatch,
  type MpvTrack,
  liftedPosition,
  tracksToKeep,
  worthReadingAgain,
} from './useMpv'

describe('judgeOpening', () => {
  const url = 'http://127.0.0.1:5000/media/Night.Harbour.mkv'
  const probe = (p: Partial<OpeningProbe>): OpeningProbe => ({
    path: url,
    position: 0,
    width: 1280,
    paused: false,
    idle: false,
    ...p,
  })
  /** Feeds probes in order, 80 ms apart, and returns every verdict. */
  const run = (probes: Partial<OpeningProbe>[]): string[] => {
    let watch: OpeningWatch = OPENING
    return probes.map((p, i) => {
      const next = judgeOpening(watch, probe(p), i * 80, url)
      watch = next.watch
      return next.verdict
    })
  }

  it('waits for the clock to move before trusting the picture', () => {
    expect(run([{ position: 0 }, { position: 0.04 }, { position: 0.2 }])).toEqual([
      'waiting',
      'waiting',
      'video',
    ])
  })

  /// Straight after `loadfile` the clock is still the old file's, and it is
  /// moving. Trusting it made the page see-through over a frame that was not
  /// there yet.
  it('ignores the clock of the file being replaced', () => {
    expect(
      run([
        { path: 'http://127.0.0.1:5000/media/Earlier.Episode.mkv', position: 1500 },
        { path: 'http://127.0.0.1:5000/media/Earlier.Episode.mkv', position: 1500.3 },
        { path: null, position: null },
        { position: 0 },
      ]),
    ).toEqual(['waiting', 'waiting', 'waiting', 'waiting'])
  })

  it('counts a resumed start from where it resumed', () => {
    expect(run([{ position: 1234.5 }, { position: 1234.6 }, { position: 1234.8 }])).toEqual([
      'waiting',
      'waiting',
      'video',
    ])
  })

  it('never says video for a file with nothing to show', () => {
    expect(run([{ position: 0, width: 0 }, { position: 0.3, width: 0 }])).toEqual([
      'waiting',
      'sound',
    ])
  })

  it('shows a file that opens paused once it has held still a moment', () => {
    const verdicts = run(Array.from({ length: 7 }, () => ({ position: 12, paused: true })))
    expect(verdicts.slice(0, 5)).toEqual(Array(5).fill('waiting'))
    expect(verdicts.at(-1)).toBe('video')
  })

  it('waits as long as the network takes', () => {
    const verdicts = run(Array.from({ length: 100 }, () => ({ position: null })))
    expect(new Set(verdicts)).toEqual(new Set(['waiting']))
  })

  it('gives up on a file mpv went idle instead of opening', () => {
    const verdicts = run(Array.from({ length: 45 }, () => ({ path: null, position: null, idle: true })))
    expect(verdicts.slice(0, 30)).toEqual(Array(30).fill('waiting'))
    expect(verdicts.at(-1)).toBe('failed')
  })
})

describe('hasEnded', () => {
  /// The two bugs this exists for, both reported from real use: stepping a
  /// frame jumped to the next episode, and so did clicking the middle of the
  /// timeline. Both were mpv reporting `eof-reached` away from the end.
  it('is not the end just because mpv says so mid-file', () => {
    expect(hasEnded(true, 600, 3600)).toBe(false)
    expect(hasEnded(true, 1800, 3600)).toBe(false)
    expect(hasEnded(true, 4.3, 3707)).toBe(false)
  })

  it('is the end at the end, allowing a little slack', () => {
    expect(hasEnded(true, 3600, 3600)).toBe(true)
    expect(hasEnded(true, 3599, 3600)).toBe(true)
    // Just outside the slack is still playing.
    expect(hasEnded(true, 3596, 3600)).toBe(false)
  })

  it('is never the end while nothing is loaded', () => {
    // Between files mpv reports eof with no duration, which is what fired
    // the instant an episode opened.
    expect(hasEnded(true, 0, 0)).toBe(false)
    expect(hasEnded(true, 120, 0)).toBe(false)
  })

  /// Dragged or skipped to the end, mpv stops there paused and never raises
  /// the flag. That is the end, and the next episode has to come.
  it('is the end when stopped paused at the end without the flag', () => {
    expect(hasEnded(false, 180, 180, true)).toBe(true)
    expect(hasEnded(null, 3599, 3600, true)).toBe(true)
  })

  it('is not the end for a pause anywhere else', () => {
    expect(hasEnded(false, 1800, 3600, true)).toBe(false)
    expect(hasEnded(false, 3590, 3600, true)).toBe(false)
    expect(hasEnded(false, 0, 0, true)).toBe(false)
  })

  it('takes only a real true, not anything truthy', () => {
    expect(hasEnded(false, 3600, 3600)).toBe(false)
    expect(hasEnded(null, 3600, 3600)).toBe(false)
    expect(hasEnded(undefined, 3600, 3600)).toBe(false)
    expect(hasEnded('yes', 3600, 3600)).toBe(false)
  })
})

describe('the lighter mode on a phone', () => {
  it('is for a large video the phone decodes in software', () => {
    expect(needsLighterPlayback(true, 'no', 3840, 1920)).toBe(true)
    expect(needsLighterPlayback(true, '', 3840, 2160)).toBe(true)
    expect(needsLighterPlayback(true, 'no', 2560, 1440)).toBe(true)
  })

  it('is not for a video the phone decodes itself, however large', () => {
    expect(needsLighterPlayback(true, 'mediacodec', 3840, 1920)).toBe(false)
    expect(needsLighterPlayback(true, 'mediacodec-copy', 3840, 2160)).toBe(false)
  })

  it('is not for 1080p, which a phone decodes in software comfortably', () => {
    expect(needsLighterPlayback(true, 'no', 1920, 1080)).toBe(false)
    expect(needsLighterPlayback(true, 'no', 1920, 1200)).toBe(false)
  })

  it('is never for a computer', () => {
    expect(needsLighterPlayback(false, 'no', 3840, 2160)).toBe(false)
  })

})

describe('tracks in a conversion', () => {
  const track = (id: number, kind: 'sub' | 'audio', external = false): MpvTrack => ({
    id,
    kind,
    label: '',
    external,
    lang: '',
    title: '',
    forced: false,
    isDefault: false,
    hearingImpaired: false,
  })
  const tracks = [track(1, 'audio'), track(2, 'audio'), track(1, 'sub'), track(2, 'sub'), track(3, 'sub', true)]

  /// mpv reads a conversion once, keeping only the tracks chosen as it reads;
  /// opened again, it has to know them from the start.
  it('opens the film again with the subtitles and sound chosen', () => {
    expect(tracksToKeep(2, 2, tracks)).toEqual(['sid=2', 'aid=2'])
  })

  it('opens it with no subtitles when they were off', () => {
    expect(tracksToKeep(false, 1, tracks)).toEqual(['sid=no', 'aid=1'])
    expect(tracksToKeep(null, null, tracks)).toEqual(['sid=no'])
  })

  /// The file is added again once the film plays; its number would point at
  /// nothing until then.
  it('leaves a subtitle file of its own to be added again', () => {
    expect(tracksToKeep(3, 1, tracks)).toEqual(['sid=no', 'aid=1'])
  })

  it('reads a conversion again only when it has arrived well ahead', () => {
    expect(worthReadingAgain(100, 160)).toBe(true)
    expect(worthReadingAgain(100, 101.5)).toBe(false)
    expect(worthReadingAgain(100, null)).toBe(false)
    expect(worthReadingAgain(null, 160)).toBe(false)
    expect(worthReadingAgain(0, 160)).toBe(false)
  })
})

describe('subtitles lifted by their position', () => {
  /// Linux's older mpv moves a line by its position at once, and by its
  /// margin only from the next line on.
  it('sits at the chosen height at rest', () => {
    expect(liftedPosition(0, 22)).toBe(100)
    expect(liftedPosition(2, 22)).toBe(88)
  })

  it('goes up by the lift over the controls, from wherever it was chosen', () => {
    expect(liftedPosition(0, 96)).toBe(90)
    expect(liftedPosition(2, 96)).toBe(78)
  })

  it('never goes off the top', () => {
    expect(liftedPosition(3, 5000)).toBe(0)
  })
})

describe('skipTarget', () => {
  it('starts a skip from the clock', () => {
    expect(skipTarget(null, 0, 300, 0, 10, 3600)).toBe(310)
    expect(skipTarget(null, 0, 300, 0, -10, 3600)).toBe(290)
  })

  it('adds quick skips to the last one, not to a clock that has not caught up', () => {
    // The clock still says 300 after a skip to 310: the second goes to 320.
    const first = skipTarget(null, 0, 300, 0, 10, 3600)
    const second = skipTarget({ target: first, at: 0 }, 400, 300, 0, 10, 3600)
    const third = skipTarget({ target: second, at: 400 }, 800, 305, 0, 10, 3600)
    expect([first, second, third]).toEqual([310, 320, 330])
    // And back again within the same run.
    expect(skipTarget({ target: third, at: 800 }, 900, 300, 0, -10, 3600)).toBe(320)
  })

  it('takes the clock again once a run is over', () => {
    expect(skipTarget({ target: 120, at: 0 }, SKIP_RUN_MS + 1, 500, 0, 10, 3600)).toBe(510)
  })

  it('uses where the film was asked to play from while there is no clock', () => {
    // A new conversion still starting: no clock, and never the film's start.
    expect(skipTarget(null, 0, null, 1800, 10, 3600)).toBe(1810)
    expect(skipTarget(null, 0, undefined, 1800, -10, 3600)).toBe(1790)
  })

  it('stays within the film', () => {
    expect(skipTarget(null, 0, 4, 0, -10, 3600)).toBe(0)
    expect(skipTarget(null, 0, 3595, 0, 10, 3600)).toBe(3600)
    // A length not known yet is no limit.
    expect(skipTarget(null, 0, 50, 0, 10, 0)).toBe(60)
  })
})
