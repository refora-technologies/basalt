import { cn } from '@/lib/utils'
import { isMobileShell } from '@/lib/platform'
import {
  COLORS,
  DEFAULT_STYLE,
  SIZES,
  type SubtitleColor,
  type SubtitleEdge,
  type SubtitleFont,
  type SubtitleStyle,
} from '@/lib/subtitleStyle'

const TOUCH = isMobileShell()

/** The fonts as the page can show them, nearest to what the player draws. */
const FAMILY: Record<SubtitleFont, string> = {
  sans: 'system-ui, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Noto Serif", serif',
  mono: 'Consolas, "Droid Sans Mono", monospace',
}

/**
 * How subtitles look, chosen in the subtitle menu: each choice shows on the
 * film at once, and in the line at the top for when nothing is being said.
 */
export function SubtitleStylePanel({
  style,
  onChange,
}: {
  style: SubtitleStyle
  onChange: (style: SubtitleStyle) => void
}): React.JSX.Element {
  const change = (part: Partial<SubtitleStyle>): void => onChange({ ...style, ...part })
  const unchanged = JSON.stringify(style) === JSON.stringify(DEFAULT_STYLE)

  return (
    <div className="px-4 pb-3 pt-2">
      <Preview style={style} />

      <Row label="Size">
        <Segments
          value={style.size}
          onChange={(size) => change({ size })}
          options={['Small', 'Normal', 'Large', 'Larger'].map((label, size) => ({ value: size, label }))}
        />
      </Row>
      <Row label="Font">
        <Segments
          value={style.font}
          onChange={(font) => change({ font })}
          options={(
            [
              ['sans', 'Sans'],
              ['serif', 'Serif'],
              ['mono', 'Mono'],
            ] as Array<[SubtitleFont, string]>
          ).map(([value, label]) => ({
            value,
            label: <span style={{ fontFamily: FAMILY[value] }}>{label}</span>,
          }))}
        />
      </Row>
      <Row label="Colour">
        <Segments
          value={style.color}
          onChange={(color) => change({ color })}
          options={(['white', 'yellow', 'cyan'] as SubtitleColor[]).map((value) => ({
            value,
            label: (
              <span className="flex items-center justify-center gap-1.5">
                <span
                  className="h-3 w-3 rounded-full ring-1 ring-white/20"
                  style={{ background: COLORS[value] }}
                />
                {value === 'white' ? 'White' : value === 'yellow' ? 'Yellow' : 'Cyan'}
              </span>
            ),
          }))}
        />
      </Row>
      <Row label="Behind the words">
        <Segments
          value={style.edge}
          onChange={(edge) => change({ edge })}
          options={(
            [
              ['outline', 'Outline'],
              ['shadow', 'Shadow'],
              ['box', 'Box'],
            ] as Array<[SubtitleEdge, string]>
          ).map(([value, label]) => ({ value, label }))}
        />
      </Row>
      <Row label="Weight">
        <Segments
          value={style.bold}
          onChange={(bold) => change({ bold })}
          options={[
            { value: false, label: 'Regular' },
            { value: true, label: <span className="font-bold">Bold</span> },
          ]}
        />
      </Row>
      <Row label="Height">
        <Segments
          value={style.raise}
          onChange={(raise) => change({ raise })}
          options={['Bottom', 'Raised', 'Higher', 'Highest'].map((label, raise) => ({ value: raise, label }))}
        />
      </Row>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[10.5px] leading-relaxed text-textFaint">
          Size applies to all subtitles. Styled ones keep their own font and colours.
        </p>
        <button
          onClick={() => onChange(DEFAULT_STYLE)}
          disabled={unchanged}
          className={cn(
            'shrink-0 rounded-md px-2 text-[11.5px] text-textDim transition-colors duration-150 hover:bg-white/[0.07] hover:text-text disabled:opacity-40',
            TOUCH ? 'h-9' : 'h-7',
          )}
        >
          Reset
        </button>
      </div>
    </div>
  )
}

/** One line as the player would draw it, over a dark picture. */
function Preview({ style }: { style: SubtitleStyle }): React.JSX.Element {
  const outline = '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000'
  return (
    <div
      className="relative flex h-[76px] items-end justify-center overflow-hidden rounded-lg"
      style={{ background: 'linear-gradient(160deg, #3a4a5c 0%, #1d2530 55%, #2c2219 100%)' }}
      aria-hidden
    >
      <span
        className="mb-2.5 max-w-[92%] text-center leading-tight"
        style={{
          fontFamily: FAMILY[style.font],
          fontSize: 15 * (SIZES[style.size] ?? 1),
          fontWeight: style.bold ? 700 : 400,
          color: COLORS[style.color],
          transform: `translateY(${-style.raise * 5}px)`,
          ...(style.edge === 'box'
            ? { background: 'rgba(0,0,0,0.7)', padding: '1px 6px', borderRadius: 2 }
            : { textShadow: style.edge === 'shadow' ? '2px 2px 3px rgba(0,0,0,0.85)' : outline }),
        }}
      >
        Where are you going tonight?
      </span>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[11px] text-textFaint">{label}</div>
      {children}
    </div>
  )
}

function Segments<T extends string | number | boolean>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: React.ReactNode }>
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="flex rounded-lg bg-white/[0.04] p-0.5" role="radiogroup">
      {options.map((option) => (
        <button
          key={String(option.value)}
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-w-0 flex-1 truncate rounded-md px-1 text-[11.5px] transition-colors duration-150',
            TOUCH ? 'h-10' : 'h-7',
            option.value === value
              ? 'bg-white/[0.13] text-text'
              : 'text-textDim hover:bg-white/[0.06] hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
