import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowUpCircle,
  Bug,
  Check,
  ChevronRight,
  Download,
  Github,
  Globe,
  Loader2,
  Mail,
  Send,
  Star,
} from 'lucide-react'
import { api } from '@/lib/api'
import { android } from '@/lib/android'
import { PLAY_STORE } from '@/lib/channel'
import {
  FEEDBACK_EMAIL,
  HOST_DOWNLOAD,
  PLAY_LISTING,
  REPO,
  WEBSITE,
  openExternal,
} from '@/lib/links'
import { isAndroid } from '@/lib/platform'
import { checkForUpdate, offered, openWhatsNew, useUpdate, type UpdateState } from '@/lib/updates'
import { cn } from '@/lib/utils'

const ISSUES = `${REPO}/issues/new`

/** The installed version, and what it runs on: for the card, and for feedback. */
interface Installed {
  version: string
  device: string
}

/**
 * Which version this is, whether there is a newer one, how to get Basalt Host
 * onto a computer, and how to reach the people who make it.
 *
 * The version is Android's own on the phone: the Play build is labelled with
 * Play's version, not the one the code was written as, and the label is what
 * people compare with the store.
 *
 * An update is only announced here; its notes and its buttons are in the
 * "What's new" popup, the same one the banner and the sidebar open.
 *
 * The Play build has no "Report a problem" on GitHub: people who came from the
 * store are not expected to have an account there. Feedback goes by email
 * instead, which reaches the same people.
 */
export function About({ product }: { product: string }): React.JSX.Element {
  const [installed, setInstalled] = useState<Installed | null>(null)
  const [noMailApp, setNoMailApp] = useState(false)
  const state = useUpdate()
  const phone = isAndroid()

  useEffect(() => {
    void (async () => {
      const fromAndroid = await android.appVersion().catch(() => null)
      if (fromAndroid?.name) {
        setInstalled({
          version: fromAndroid.name,
          device: `${fromAndroid.device}, Android ${fromAndroid.android}`,
        })
        return
      }
      const version = await api.appVersion().catch(() => '')
      setInstalled({ version, device: phone ? 'Android' : 'Windows' })
    })()
  }, [phone])

  const feedback = async (): Promise<void> => {
    const subject = 'Basalt feedback'
    const body = [
      '',
      '',
      '',
      '--',
      `Basalt ${installed?.version ?? ''}${PLAY_STORE ? ' (Google Play)' : ''}`,
      installed?.device ?? '',
    ].join('\n')
    if (phone) {
      setNoMailApp(!(await android.composeEmail(FEEDBACK_EMAIL, subject, body)))
      return
    }
    await openExternal(
      `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    )
  }

  return (
    <div className="px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text">{product}</div>
          <div className="tnum mt-0.5 font-mono text-[11px] text-textFaint">
            {installed?.version ? `v${installed.version}` : '—'}
            {PLAY_STORE && ' · Google Play'}
          </div>
        </div>
        <button
          onClick={() => void checkForUpdate(false)}
          disabled={state.kind === 'checking' || state.kind === 'downloading'}
          className="shrink-0 rounded-md border border-line bg-ink2 px-3 py-1.5 text-[11.5px] text-textDim transition-colors hover:border-lineBright hover:text-text disabled:opacity-40"
        >
          {state.kind === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      <Status state={state} />

      <HostBlock phone={phone} />

      <div className="mt-3 overflow-hidden rounded-lg border border-line">
        {PLAY_STORE && (
          <Row icon={<Star size={15} />} onClick={() => void openExternal(PLAY_LISTING)}>
            Rate Basalt on Google Play
          </Row>
        )}
        <Row icon={<Mail size={15} />} onClick={() => void feedback()}>
          Send feedback
        </Row>
        {!PLAY_STORE && (
          <Row icon={<Bug size={15} />} onClick={() => void openExternal(ISSUES)}>
            Report a problem on GitHub
          </Row>
        )}
        <Row icon={<Github size={15} />} onClick={() => void openExternal(REPO)}>
          {PLAY_STORE ? 'Source code and licences' : 'Source code'}
        </Row>
      </div>
      {noMailApp && (
        <p className="mt-2 text-[11.5px] text-textFaint">
          No mail app opened. Write to {FEEDBACK_EMAIL} from any mail app.
        </p>
      )}

      <p className="mt-4 font-mono text-[10px] text-textFaint">
        {phone ? 'Android' : 'Windows'} · GPLv3 · Refora Technologies
      </p>
      <p className="mt-1 font-mono text-[10px] text-textFaint">© 2026 Refora Technologies</p>
    </div>
  )
}

/** One line on where updates stand; an offered one opens "What's new". */
function Status({ state }: { state: UpdateState }): React.JSX.Element | null {
  if (offered(state)) {
    const { version } = state.release
    const label =
      state.kind === 'ready'
        ? `Version ${version} is ready to install`
        : state.kind === 'downloading'
          ? `Downloading version ${version}${
              state.total > 0 ? ` · ${Math.round((state.had / state.total) * 100)}%` : ''
            }`
          : `Version ${version} is available`
    return (
      <button
        onClick={openWhatsNew}
        className="mt-3 flex w-full items-center gap-2.5 rounded-lg border border-basalt/25 bg-basalt/[0.07] px-3 py-2.5 text-left transition-colors hover:bg-basalt/[0.12]"
      >
        {state.kind === 'downloading' ? (
          <Loader2 size={15} className="shrink-0 animate-spin text-basalt" />
        ) : (
          <ArrowUpCircle size={15} className="shrink-0 text-basalt" />
        )}
        <span className="tnum min-w-0 flex-1 text-[12.5px] text-text">{label}</span>
        <span className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-textDim">
          What’s new
          <ChevronRight size={13} />
        </span>
      </button>
    )
  }
  if (state.kind === 'current') {
    return (
      <Line icon={<Check size={12} className="text-textFaint" />}>You’re on the latest version.</Line>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Line icon={<AlertCircle size={12} className="text-danger" />} danger>
        {state.why}
      </Line>
    )
  }
  return null
}

/**
 * Basalt Host, where the files are: the one thing every new person needs and
 * the phone cannot install. From a phone the link goes to the computer by whatever
 * the person uses to send themselves things; on Windows it downloads.
 */
function HostBlock({ phone }: { phone: boolean }): React.JSX.Element {
  return (
    <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
        <Download size={15} className="text-basalt" />
        Get Basalt Host for your computer
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-textDim">
        The host runs on the computer that has your files and shares them with your devices. It is
        free, like this app.
      </p>
      {phone ? (
        <div className="mt-3.5 flex flex-col gap-2">
          <Big
            primary
            icon={<Send size={15} />}
            onClick={() =>
              void android.shareText(
                `Basalt Host. Open this on your computer to download it: ${HOST_DOWNLOAD}`,
                'Basalt Host for your computer',
              )
            }
          >
            Send the link to my computer
          </Big>
          <Big icon={<Globe size={15} />} onClick={() => void openExternal(`${WEBSITE}/#download`)}>
            Open the download page
          </Big>
        </div>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Big primary icon={<Download size={15} />} onClick={() => void openExternal(HOST_DOWNLOAD)}>
            Download Basalt Host
          </Big>
          <Big icon={<Globe size={15} />} onClick={() => void openExternal(WEBSITE)}>
            Website
          </Big>
        </div>
      )}
    </div>
  )
}

function Big({
  primary,
  icon,
  onClick,
  children,
}: {
  primary?: boolean
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-3 text-[13px] font-semibold transition-colors',
        primary
          ? 'bg-white text-black hover:bg-white/90'
          : 'border border-line bg-ink2 text-textDim hover:border-lineBright hover:text-text',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function Row({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-line px-3.5 py-3 text-left text-[12.5px] text-textDim transition-colors last:border-b-0 hover:bg-white/[0.03] hover:text-text"
    >
      <span className="shrink-0 text-textFaint">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight size={14} className="shrink-0 text-textFaint" />
    </button>
  )
}

function Line({
  icon,
  danger,
  children,
}: {
  icon: React.ReactNode
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mt-2 flex items-start gap-1.5 text-[11.5px]',
        danger ? 'text-danger' : 'text-textFaint',
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </div>
  )
}
