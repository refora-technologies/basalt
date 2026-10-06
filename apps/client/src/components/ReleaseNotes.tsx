import { parseNotes } from '@/lib/notes'
import { cn } from '@/lib/utils'

/**
 * The release notes as written on GitHub, rendered rather than shown raw.
 *
 * Headings, bullets and bold are all release notes use, and all this draws.
 * See `lib/notes` for why there is no Markdown dependency behind this.
 */
export function ReleaseNotes({ notes }: { notes: string }): React.JSX.Element {
  return (
    <div className="space-y-2 text-[12.5px] leading-relaxed text-textDim">
      {parseNotes(notes).map((block, at) => {
        const runs = block.spans.map((span, i) => (
          <span
            key={i}
            className={cn(
              span.bold && 'font-semibold text-text',
              span.code && 'rounded bg-white/[0.07] px-1 font-mono text-[11.5px]',
            )}
          >
            {span.text}
          </span>
        ))

        if (block.kind === 'heading') {
          return (
            <div
              key={at}
              className="pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-textFaint first:pt-0"
            >
              {runs}
            </div>
          )
        }
        if (block.kind === 'bullet') {
          return (
            <div key={at} className="flex gap-2">
              <span className="shrink-0 text-textFaint">·</span>
              <span className="min-w-0">{runs}</span>
            </div>
          )
        }
        return (
          <p key={at} className="break-words">
            {runs}
          </p>
        )
      })}
    </div>
  )
}
