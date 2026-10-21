import { describe, expect, it } from 'vitest'
import { hasLetters, scriptForLanguage, scriptOfText } from './subtitleFonts'
import { DEFAULT_STYLE, readStyle, styleFamily, styleProperties } from './subtitleStyle'

// On a phone these drew as empty boxes: libass had one Latin font and no way
// to find another for letters it lacked.
describe('the script subtitles are written in', () => {
  it('comes from the language, by either kind of code', () => {
    expect(scriptForLanguage('tam')).toBe('tamil')
    expect(scriptForLanguage('ta')).toBe('tamil')
    expect(scriptForLanguage('sin')).toBe('sinhala')
    expect(scriptForLanguage('hin')).toBe('devanagari')
    expect(scriptForLanguage('ara')).toBe('arabic')
    expect(scriptForLanguage('per')).toBe('arabic')
    expect(scriptForLanguage('THA')).toBe('thai')
  })

  it('tells Traditional Chinese from Simplified by tag or title', () => {
    expect(scriptForLanguage('chi')).toBe('cjk-sc')
    expect(scriptForLanguage('zh-Hant')).toBe('cjk-tc')
    expect(scriptForLanguage('zh_TW')).toBe('cjk-tc')
    expect(scriptForLanguage('chi', 'Chinese (Traditional)')).toBe('cjk-tc')
    expect(scriptForLanguage('jpn')).toBe('cjk-jp')
    expect(scriptForLanguage('kor')).toBe('cjk-kr')
  })

  it('needs nothing for Latin, Greek and Cyrillic, or a language not given', () => {
    expect(scriptForLanguage('eng')).toBeNull()
    expect(scriptForLanguage('rus')).toBeNull()
    expect(scriptForLanguage('ell')).toBeNull()
    expect(scriptForLanguage('und')).toBeNull()
    expect(scriptForLanguage('')).toBeNull()
  })

  it('is read from a line when the language is not given', () => {
    expect(scriptOfText('இன்றிரவு நீங்கள் எங்கே போகிறீர்கள்?')).toBe('tamil')
    expect(scriptOfText('ඔබ අද රෑ කොහෙද යන්නේ?')).toBe('sinhala')
    expect(scriptOfText('คืนนี้คุณจะไปไหน')).toBe('thai')
    expect(scriptOfText('إلى أين أنت ذاهب الليلة؟')).toBe('arabic')
    expect(scriptOfText('你今晚要去哪裡？')).toBe('cjk-sc')
    expect(scriptOfText('今夜はどこへ行くの？')).toBe('cjk-jp')
    expect(scriptOfText('오늘 밤 어디 가요?')).toBe('cjk-kr')
    // A name in Latin letters does not outweigh the line.
    expect(scriptOfText('John, இன்றிரவு எங்கே?')).toBe('tamil')
  })

  it('reads Latin, Greek and Cyrillic lines as needing nothing', () => {
    expect(scriptOfText('Where are you going tonight?')).toBeNull()
    expect(scriptOfText('Куда ты идёшь?')).toBeNull()
    expect(scriptOfText('Πού πας απόψε;')).toBeNull()
  })

  it('waits for a line with letters', () => {
    expect(hasLetters('♪ ♪')).toBe(false)
    expect(hasLetters('...')).toBe(false)
    expect(hasLetters('你好')).toBe(true)
  })
})

describe('how subtitles look', () => {
  it('starts as mpv draws them', () => {
    const props = Object.fromEntries(styleProperties(DEFAULT_STYLE))
    expect(props['sub-scale']).toBe('1')
    expect(props['sub-color']).toBe('#FFFFFF')
    expect(props['sub-pos']).toBe('100')
    expect(props['sub-border-style']).toBe('outline-and-shadow')
  })

  it('reads back what was kept, and nothing it does not understand', () => {
    expect(readStyle(JSON.stringify({ ...DEFAULT_STYLE, size: 3, color: 'yellow' }))).toEqual({
      ...DEFAULT_STYLE,
      size: 3,
      color: 'yellow',
    })
    expect(readStyle('{"size": 9, "font": "comic", "bold": "yes"}')).toEqual(DEFAULT_STYLE)
    expect(readStyle('not json')).toEqual(DEFAULT_STYLE)
    expect(readStyle(null)).toEqual(DEFAULT_STYLE)
  })

  it('puts a box behind the words when asked', () => {
    const props = Object.fromEntries(styleProperties({ ...DEFAULT_STYLE, edge: 'box', raise: 2, bold: true }))
    expect(props['sub-border-style']).toBe('opaque-box')
    expect(props['sub-pos']).toBe('88')
    expect(props['sub-bold']).toBe('yes')
  })

  it('names fonts each platform has', () => {
    expect(styleFamily('serif', 'android')).toBe('Noto Serif')
    expect(styleFamily('sans', 'android')).toBe('sans-serif')
    expect(styleFamily('mono', 'windows')).toBe('Consolas')
    expect(styleFamily('serif', 'linux')).toBe('serif')
  })
})
