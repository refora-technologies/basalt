/**
 * How subtitles look: size, font, colour, what is behind them, and height.
 * Chosen in the player's subtitle menu, kept on the device.
 *
 * Size applies to every subtitle, styled ones (ASS) too, which otherwise
 * keep the look their maker gave them. Font, colour and background apply
 * to plain subtitles, which is most of them.
 */

export type SubtitleFont = 'sans' | 'serif' | 'mono'
export type SubtitleColor = 'white' | 'yellow' | 'cyan'
export type SubtitleEdge = 'outline' | 'shadow' | 'box'

export interface SubtitleStyle {
  /** 0 small, 1 as it comes, 2 large, 3 largest. */
  size: number
  font: SubtitleFont
  color: SubtitleColor
  edge: SubtitleEdge
  bold: boolean
  /** 0 at the bottom, up to 3 steps higher. */
  raise: number
}

export const DEFAULT_STYLE: SubtitleStyle = {
  size: 1,
  font: 'sans',
  color: 'white',
  edge: 'outline',
  bold: false,
  raise: 0,
}

export const SIZES = [0.8, 1, 1.25, 1.55]
export const RAISES = [100, 94, 88, 80]

/** As CSS can show them, for the menu's preview. */
export const COLORS: Record<SubtitleColor, string> = {
  white: '#FFFFFF',
  yellow: '#FFE45C',
  cyan: '#7FE7FF',
}

const KEY = 'basalt.subtitleStyle'

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

function step(value: unknown, most: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= most ? value : fallback
}

/** As kept, with anything unreadable left as it comes. */
export function readStyle(raw: string | null): SubtitleStyle {
  let kept: Partial<Record<keyof SubtitleStyle, unknown>> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object') kept = parsed as typeof kept
  } catch {
    // Unreadable: as it comes.
  }
  return {
    size: step(kept.size, SIZES.length - 1, DEFAULT_STYLE.size),
    font: oneOf(kept.font, ['sans', 'serif', 'mono'] as const, DEFAULT_STYLE.font),
    color: oneOf(kept.color, ['white', 'yellow', 'cyan'] as const, DEFAULT_STYLE.color),
    edge: oneOf(kept.edge, ['outline', 'shadow', 'box'] as const, DEFAULT_STYLE.edge),
    bold: typeof kept.bold === 'boolean' ? kept.bold : DEFAULT_STYLE.bold,
    raise: step(kept.raise, RAISES.length - 1, DEFAULT_STYLE.raise),
  }
}

export function loadStyle(): SubtitleStyle {
  try {
    return readStyle(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_STYLE
  }
}

export function saveStyle(style: SubtitleStyle): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(style))
  } catch {
    // Not kept, but still applied for now.
  }
}

/**
 * The font family for a style, where the platform has one. `sans` is mpv's
 * own default everywhere, so subtitles look as they always have until a
 * choice is made. Phones have only
 * the fonts the app links in (see `MpvPlayer.linkStyleFonts`); `sans` there
 * is mpv's own default, the phone's font copied in as `subfont.ttf`.
 */
export function styleFamily(font: SubtitleFont, platform: 'android' | 'windows' | 'linux'): string {
  if (platform === 'android') {
    return { sans: 'sans-serif', serif: 'Noto Serif', mono: 'Droid Sans Mono' }[font]
  }
  if (platform === 'windows') {
    return { sans: 'sans-serif', serif: 'Georgia', mono: 'Consolas' }[font]
  }
  return { sans: 'sans-serif', serif: 'serif', mono: 'monospace' }[font]
}

/**
 * The mpv properties for a style, as name and value. `sub-font` is left to
 * the player, which knows the script the subtitles are written in.
 * `outline` is mpv's own outline as it came, kept for the outline style so
 * subtitles look as they always have until a choice is made: 1.65 in newer
 * mpv, 3 in older.
 */
export function styleProperties(style: SubtitleStyle, outline = 1.65): Array<[string, string]> {
  const edge: Array<[string, string]> =
    style.edge === 'box'
      ? [
          // A dark box behind each line, the outline colour filling it.
          ['sub-border-style', 'opaque-box'],
          ['sub-border-color', '#B0000000'],
          ['sub-border-size', '6'],
          ['sub-shadow-offset', '0'],
        ]
      : style.edge === 'shadow'
        ? [
            ['sub-border-style', 'outline-and-shadow'],
            ['sub-border-color', '#000000'],
            ['sub-border-size', '1'],
            ['sub-shadow-color', '#C0000000'],
            ['sub-shadow-offset', '3'],
          ]
        : [
            ['sub-border-style', 'outline-and-shadow'],
            ['sub-border-color', '#000000'],
            ['sub-border-size', String(outline)],
            ['sub-shadow-offset', '0'],
          ]
  return [
    ['sub-scale', String(SIZES[style.size] ?? 1)],
    ['sub-color', COLORS[style.color]],
    ['sub-bold', style.bold ? 'yes' : 'no'],
    ['sub-pos', String(RAISES[style.raise] ?? 100)],
    ...edge,
  ]
}
