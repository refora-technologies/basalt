import { AlertTriangle, ArrowUpCircle, Check, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Group, Pill, Row, Rows, Toggle, ago, useLayout } from './parts'
import type { Tools } from './tools'

/**
 * Keeping the host up to date, from here: its version, a new one when there
 * is one, and automatic updates.
 *
 * The host looks for new versions by itself and, with automatic updates on,
 * puts them in when nothing is playing. From here it can be asked to look now
 * or to update now. Never for a particular version: it is always the newest
 * official release, checked before it goes in.
 */
export function UpdatesGroup({ m, view }: Tools): React.JSX.Element | null {
  const phone = useLayout() === 'phone'
  const update = view.update
  // A host from before 1.5 says nothing about updates.
  if (!update) return null

  const { stage, available } = update
  const busy = stage.kind === 'checking' || stage.kind === 'downloading' || stage.kind === 'installing'
  const working =
    stage.kind === 'downloading'
      ? `Downloading ${stage.percent}%`
      : stage.kind === 'installing'
        ? 'Installing…'
        : stage.kind === 'checking'
          ? 'Checking…'
          : null

  const sub = available
    ? update.canInstall
      ? 'The host restarts by itself, and your devices reconnect.'
      : update.method === 'container'
        ? 'This host runs in Docker: pull the new image to update it.'
        : 'Update it the way it was installed.'
    : update.checkedAt
      ? `Up to date · checked ${ago(update.checkedAt)}`
      : 'Not checked yet'

  return (
    <Group icon={ArrowUpCircle} title="Updates" aside={`Version ${update.version}`}>
      <Rows>
        <Row
          icon={available ? <ArrowUpCircle size={phone ? 18 : 15} className="text-basalt" /> : <Check size={phone ? 18 : 15} />}
          title={available ? `Version ${available.version} is available` : `Version ${update.version}`}
          sub={working ?? sub}
          end={
            available && update.canInstall ? (
              <Pill
                onClick={() => void m.act({ do: 'installUpdate' })}
                busy={busy}
                icon={busy ? <Loader2 size={phone ? 15 : 13} className="animate-spin" /> : undefined}
              >
                Update now
              </Pill>
            ) : !available ? (
              <Pill
                onClick={() => void m.act({ do: 'checkForUpdate' })}
                busy={busy}
                icon={busy ? <Loader2 size={phone ? 15 : 13} className="animate-spin" /> : undefined}
              >
                Check now
              </Pill>
            ) : undefined
          }
        />
        {stage.kind === 'downloading' && (
          <div className="px-4 pb-3.5">
            <div className="h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-basalt transition-[width] duration-200"
                style={{ width: `${stage.percent}%` }}
              />
            </div>
          </div>
        )}
        {available && !update.canInstall && update.command && (
          <div className="px-4 py-3">
            <code
              className={cn(
                'block select-all break-all rounded-md bg-white/[0.05] px-3 py-2 font-mono text-textDim',
                phone ? 'text-[12px]' : 'text-[11px]',
              )}
            >
              {update.command}
            </code>
          </div>
        )}
        {(stage.kind === 'failed' || (update.outcome && !update.outcome.ok)) && (
          <p
            className={cn(
              'flex items-start gap-2 px-4 py-3 leading-snug text-danger',
              phone ? 'text-[12.5px]' : 'text-[11.5px]',
            )}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {stage.kind === 'failed' ? stage.why : `The last update didn’t go in: ${update.outcome!.message}`}
          </p>
        )}
        {update.canInstall && (
          <Toggle
            title="Update automatically"
            description="New versions go in by themselves when nothing is playing."
            checked={update.automatic}
            onChange={(enabled) => m.act({ do: 'setAutomaticUpdates', enabled })}
          />
        )}
      </Rows>
    </Group>
  )
}
