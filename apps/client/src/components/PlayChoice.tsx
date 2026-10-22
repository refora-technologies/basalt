import { ArrowRight, Check } from 'lucide-react'
import basaltIcon from '@/assets/basalt-icon.png'
import type { Release } from '@/lib/api'
import { PLAY_LISTING, openExternal } from '@/lib/links'

/**
 * The update popup in the APK once Basalt's update is on Google Play: move to
 * Play, or carry on with the APK. See `lib/playMove`.
 *
 * Play only updates an app it installed, so this copy can't have Play fetch
 * the update for it the way the Play copy does. The move is one tap of Update
 * on Basalt's page in Play; Play then installs over this app, and from then
 * on the app is Play's, updating from inside Basalt like the Play copy.
 */
export function PlayChoice({
  release,
  onKeepApk,
  onClose,
}: {
  release: Release
  onKeepApk: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-6">
      <div className="text-[22px] font-semibold leading-tight tracking-tight text-text">
        Basalt is officially on Google Play
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-textDim">
        Version {release.version} is waiting for you there.
      </p>

      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
        <div className="flex items-center gap-3.5">
          <img src={basaltIcon} alt="" className="h-14 w-14 rounded-2xl" draggable={false} />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold text-text">Basalt</div>
            <div className="text-[12px] text-textDim">Refora Technologies</div>
            <div className="mt-0.5 font-mono text-[10.5px] text-textFaint">
              {release.version} · phones, tablets, TVs
            </div>
          </div>
        </div>
        <button
          onClick={() => {
            void openExternal(PLAY_LISTING)
            onClose()
          }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-3 text-[14px] font-semibold text-black transition-opacity hover:opacity-90"
        >
          <PlayGlyph size={15} />
          Update on Google Play
        </button>
      </div>

      <ul className="mt-5 space-y-2.5 text-[12.5px] leading-snug text-textDim">
        {[
          'Play installs it over this app: nothing to uninstall.',
          'Your paired drives, profiles and settings stay.',
          'From then on, updates arrive through Google Play by themselves.',
        ].map((line) => (
          <li key={line} className="flex gap-2.5">
            <Check size={14} className="mt-0.5 shrink-0 text-text" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
        <button
          onClick={onKeepApk}
          className="flex items-center gap-1.5 rounded-lg py-1.5 text-[12.5px] text-textDim transition-colors hover:text-text"
        >
          Keep the APK version instead
          <ArrowRight size={13} />
        </button>
        <button
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-textFaint transition-colors hover:text-text"
        >
          Later
        </button>
      </div>
    </div>
  )
}

/** Google Play's triangle, drawn in the colour around it. */
export function PlayGlyph({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M4.5 2.8 14.2 12l-9.7 9.2c-.4-.2-.7-.7-.7-1.2V4c0-.5.3-1 .7-1.2Z" fill="currentColor" opacity=".9" />
      <path d="m17.4 8.9-3.2 3.1L4.5 2.8l.2-.1c.4-.2.9-.2 1.3 0l11.4 6.2Z" fill="currentColor" opacity=".55" />
      <path d="M17.4 15.1 6 21.3c-.4.2-.9.2-1.3 0l-.2-.1 9.7-9.2 3.2 3.1Z" fill="currentColor" opacity=".7" />
      <path d="m20.4 13.4-3 1.7-3.2-3.1 3.2-3.1 3 1.7c.5.3.8.8.8 1.4s-.3 1.1-.8 1.4Z" fill="currentColor" opacity=".4" />
    </svg>
  )
}
