/**
 * Which script subtitles are written in, so a phone can draw them.
 *
 * mpv on Android draws subtitles with libass, which finds a font only by the
 * family it is asked for and cannot fall back to another for letters the
 * first one lacks. Its one font reads Latin, Greek and Cyrillic; anything
 * else drew as empty boxes. The app names the script, and the phone links
 * the font for it (see `MpvPlayer.subtitleFont`). Computers fall back to
 * other fonts by themselves and need none of this.
 */

export type Script =
  | 'tamil'
  | 'telugu'
  | 'kannada'
  | 'malayalam'
  | 'bengali'
  | 'gujarati'
  | 'gurmukhi'
  | 'devanagari'
  | 'sinhala'
  | 'thai'
  | 'lao'
  | 'khmer'
  | 'myanmar'
  | 'hebrew'
  | 'arabic'
  | 'armenian'
  | 'georgian'
  | 'ethiopic'
  | 'cjk-sc'
  | 'cjk-tc'
  | 'cjk-jp'
  | 'cjk-kr'

/** Languages by their two- and three-letter codes, both kinds of the latter. */
const BY_LANGUAGE: Record<string, Script> = {}
function written(script: Script, ...codes: string[]): void {
  for (const code of codes) BY_LANGUAGE[code] = script
}
written('tamil', 'ta', 'tam')
written('telugu', 'te', 'tel')
written('kannada', 'kn', 'kan')
written('malayalam', 'ml', 'mal')
written('bengali', 'bn', 'ben', 'as', 'asm')
written('gujarati', 'gu', 'guj')
written('gurmukhi', 'pa', 'pan')
written('devanagari', 'hi', 'hin', 'mr', 'mar', 'ne', 'nep', 'sa', 'san')
written('sinhala', 'si', 'sin')
written('thai', 'th', 'tha')
written('lao', 'lo', 'lao')
written('khmer', 'km', 'khm')
written('myanmar', 'my', 'mya', 'bur')
written('hebrew', 'he', 'heb', 'iw', 'yi', 'yid')
written('arabic', 'ar', 'ara', 'fa', 'fas', 'per', 'ur', 'urd', 'ps', 'pus', 'ku', 'ckb')
written('armenian', 'hy', 'hye', 'arm')
written('georgian', 'ka', 'kat', 'geo')
written('ethiopic', 'am', 'amh', 'ti', 'tir')
written('cjk-jp', 'ja', 'jpn')
written('cjk-kr', 'ko', 'kor')
written('cjk-sc', 'zh', 'zho', 'chi', 'cmn', 'yue')

/**
 * The script a subtitle track is written in, from its language tag and its
 * title. Null for Latin, Greek and Cyrillic, and for a language not known.
 */
export function scriptForLanguage(lang: string, title = ''): Script | null {
  const tag = lang.trim().toLowerCase().replace(/_/g, '-')
  const [base, ...rest] = tag.split('-')
  const script = BY_LANGUAGE[base ?? '']
  if (script !== 'cjk-sc') return script ?? null
  // Chinese: Traditional by its tag or its title, Simplified otherwise.
  const traditional =
    rest.some((part) => ['hant', 'tw', 'hk', 'mo'].includes(part)) ||
    /tradition|繁|正體|cht|big5/i.test(title)
  return traditional ? 'cjk-tc' : 'cjk-sc'
}

/** Unicode ranges, first match wins; Han last, as Japanese mixes it in. */
const RANGES: Array<[number, number, Script]> = [
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
  [0x0d80, 0x0dff, 'sinhala'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0900, 0x097f, 'devanagari'],
  [0x0e00, 0x0e7f, 'thai'],
  [0x0e80, 0x0eff, 'lao'],
  [0x1780, 0x17ff, 'khmer'],
  [0x1000, 0x109f, 'myanmar'],
  [0x0590, 0x05ff, 'hebrew'],
  [0x0600, 0x06ff, 'arabic'],
  [0x0750, 0x077f, 'arabic'],
  [0xfb50, 0xfdff, 'arabic'],
  [0xfe70, 0xfeff, 'arabic'],
  [0x0530, 0x058f, 'armenian'],
  [0x10a0, 0x10ff, 'georgian'],
  [0x1200, 0x139f, 'ethiopic'],
  [0x3040, 0x30ff, 'cjk-jp'],
  [0xac00, 0xd7af, 'cjk-kr'],
  [0x1100, 0x11ff, 'cjk-kr'],
  [0x3130, 0x318f, 'cjk-kr'],
  [0x3400, 0x4dbf, 'cjk-sc'],
  [0x4e00, 0x9fff, 'cjk-sc'],
]

/**
 * The script a line of subtitles is written in, for a track whose language
 * is not given or not known: the one most of its letters belong to. Null
 * for Latin, Greek and Cyrillic, and for a line with no letters at all.
 * Kana anywhere makes Han Japanese.
 */
export function scriptOfText(text: string): Script | null {
  const counts = new Map<Script, number>()
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x0530) continue
    const found = RANGES.find(([from, to]) => code >= from && code <= to)
    if (found) counts.set(found[2], (counts.get(found[2]) ?? 0) + 1)
  }
  if (counts.has('cjk-jp') && counts.has('cjk-sc')) {
    counts.set('cjk-jp', (counts.get('cjk-jp') ?? 0) + (counts.get('cjk-sc') ?? 0))
    counts.delete('cjk-sc')
  }
  let best: Script | null = null
  let most = 0
  for (const [script, count] of counts) {
    if (count > most) {
      best = script
      most = count
    }
  }
  return best
}

/** Whether a line has letters at all, so a script could be judged from it. */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text)
}
