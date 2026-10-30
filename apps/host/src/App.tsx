import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, MonitorSmartphone, Users } from 'lucide-react'
import { api, type DeviceView, type HostStatus } from '@/lib/api'
import { usePoll } from '@/lib/usePoll'
import { DeviceList, OwnerLine } from './components/DeviceList'
import { PairingRequests } from './components/PairingRequests'
import {
  ComputerSettings,
  ConversionSettings,
  LibrarySettings,
  SectionSettings,
} from './components/SettingsPanel'
import { UpdateBanner } from './components/UpdateBanner'
import { ProfileLinks } from './components/ProfileLinks'
import { FirewallNotice } from './components/FirewallNotice'
import { ProfileList } from './components/ProfileList'
import { ProfileAccess } from './components/ProfileAccess'
import { AddProfileDialog } from './components/AddProfileDialog'
import { Setup } from './components/Setup'
import { TitleBar } from './components/TitleBar'
import { Machine } from './components/Machine'
import { Group } from './components/ui/Group'
import { HexMark } from './components/HexMark'
import { PromptDialog, type PromptRequest } from './components/ui/PromptDialog'
import { MessageDialog, type MessageRequest } from './components/ui/MessageDialog'
import { ConfirmDialog } from './components/ui/ConfirmDialog'

/** How often the dashboard asks for each thing. */
const STATUS_INTERVAL = 2_000
/** Faster: this is where the live speeds come from. */
const DEVICE_INTERVAL = 1_000
/** Faster still: a PIN is on a two-minute clock and someone is waiting. */
const PAIRING_INTERVAL = 900
/** How long the first answer may take before the splash admits something is wrong. */
const SLOW_START = 10_000
/** Said plainly, with somewhere to go next. */
const STUCK =
  'This is taking longer than usual. The drive may be slow to wake up. If it doesn’t clear, the log says why.'

export function App(): React.JSX.Element {
  const status = usePoll<HostStatus>(useCallback(() => api.status(), []), STATUS_INTERVAL)
  const devices = usePoll<DeviceView[]>(useCallback(() => api.devices(), []), DEVICE_INTERVAL)
  const pairings = usePoll(useCallback(() => api.pendingPairings(), []), PAIRING_INTERVAL)
  const links = usePoll(useCallback(() => api.profileLinks(), []), PAIRING_INTERVAL)

  const [prompt, setPrompt] = useState<PromptRequest | null>(null)
  const [message, setMessage] = useState<MessageRequest | null>(null)
  // Turning the PIN off is asked about first, as Manage host on a phone asks.
  const [askNoPin, setAskNoPin] = useState(false)
  const [adding, setAdding] = useState(false)
  /** Why the last change to the profile rules was refused. */
  const [rulesError, setRulesError] = useState<string | null>(null)
  /** Which build this is. Asked once — it cannot change while running. */
  const [build, setBuild] = useState('')
  /** Set when the user asks to share something else, over a live vault. */
  const [reconfiguring, setReconfiguring] = useState(false)

  const list = devices.data ?? []
  const busy = useMemo(
    () => list.some((device) => device.sendRate > 0 || device.receiveRate > 0),
    [list],
  )

  const apply = useCallback(
    (next: HostStatus) => {
      // The command already returned the new status, so the switch moves at
      // once instead of snapping back until the next poll catches up.
      status.set(next)
    },
    [status],
  )

  const setRequirePin = useCallback(
    (require: boolean) => {
      void api.setRequirePin(require).then((next) => {
        apply(next)
        pairings.refresh()
      })
    },
    [apply, pairings],
  )

  useEffect(() => {
    void api.buildInfo().then(setBuild).catch(() => {})
  }, [])

  /**
   * Whether the very first status call has taken suspiciously long.
   *
   * The splash used to say "Starting up…" for as long as nothing answered,
   * which after ten seconds is no longer true and reads as a hang with no
   * explanation. Saying where the log is turns a blank wait into something the
   * user can act on.
   */
  const [slow, setSlow] = useState(false)
  const answered = status.data !== null
  useEffect(() => {
    if (answered) return
    const timer = setTimeout(() => setSlow(true), SLOW_START)
    return () => clearTimeout(timer)
  }, [answered])

  const chooseVault = useCallback(
    async (path: string, name: string) => {
      apply(await api.chooseVault(path, name))
      setReconfiguring(false)
    },
    [apply],
  )

  const current = status.data
  if (!current) {
    return (
      <Splash
        message={status.error ?? (slow ? STUCK : undefined)}
        onOpenLog={slow ? () => void api.openLogFolder().catch(() => {}) : undefined}
      />
    )
  }

  const needsSetup = !current.vault || reconfiguring

  return (
    <div className="relative flex h-full flex-col">
      <div className="backdrop" />

      <TitleBar
        hostName={current.hostName}
        vaultName={needsSetup ? null : (current.vault?.name ?? null)}
        serving={current.serving}
        busy={busy}
      />

      {/*
        Keyed and faded in, with no exit animation to wait for.
        `AnimatePresence mode="wait"` would be the obvious way to cross-fade
        these, but it holds the outgoing view on screen until its exit
        animation finishes — and this app's window really does get hidden, to
        the tray and at login, which suspends animation frames. A swap that
        cannot complete while nobody is looking is a swap that can be stuck
        when they look again.
      */}
      <main className="relative z-10 min-h-0 flex-1">
        <div key={needsSetup ? 'setup' : 'dashboard'} className="h-full">
          {needsSetup ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="h-full"
            >
              <Setup hostName={current.hostName} onChosen={chooseVault} />
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="h-full overflow-y-auto"
            >
              <div className="mx-auto flex max-w-[1180px] flex-col gap-4 px-6 py-6">
                <UpdateBanner />
                <FirewallNotice />

                {!current.serving && current.problem && (
                  <div className="flex items-start gap-3 rounded-lg bg-dangerBg px-4 py-3">
                    <span className="mt-0.5 shrink-0 text-danger">
                      <AlertTriangle size={14} />
                    </span>
                    <p className="text-[12.5px] leading-relaxed text-danger">{current.problem}</p>
                  </div>
                )}

                <Machine
                  status={current}
                  devices={list}
                  onChange={() => setReconfiguring(true)}
                  onOpen={() => void api.openVaultFolder().catch(() => {})}
                  onRename={() =>
                    setPrompt({
                      title: 'Name this drive',
                      value: current.vault?.name ?? '',
                      confirmLabel: 'Rename',
                      select: 'all',
                      onConfirm: (name) => {
                        void api.renameDrive(name).then(apply)
                      },
                    })
                  }
                />

                <PairingRequests
                  requests={pairings.data ?? []}
                  onDeny={(id) => {
                    void api.denyPairing(id).then(() => pairings.refresh())
                  }}
                />

                <div className="grid items-start gap-4 min-[900px]:grid-cols-2">
                  <div className="flex min-w-0 flex-col gap-4">
                    <Group
                      icon={MonitorSmartphone}
                      title="Devices"
                      aside={
                        list.length > 0
                          ? `${list.filter((d) => d.online).length} of ${list.length} connected`
                          : undefined
                      }
                    >
                      <DeviceList
                        devices={list}
                        onRevoke={(device) =>
                          setPrompt({
                            title: `Remove ${device.name}?`,
                            value: device.name,
                            confirmLabel: 'Remove',
                            select: 'all',
                            // Confirmed by retyping nothing in particular: the
                            // dialog is the confirmation, and the field carries
                            // the name so it is obvious which device is going.
                            onConfirm: () => {
                              void api.revokeDevice(device.id).then(() => {
                                devices.refresh()
                                status.refresh()
                              })
                            },
                          })
                        }
                        onRename={(device) =>
                          setPrompt({
                            title: 'Rename this device',
                            value: device.name,
                            confirmLabel: 'Rename',
                            select: 'all',
                            onConfirm: (name) => {
                              void api.renameDevice(device.id, name).then(() => devices.refresh())
                            },
                          })
                        }
                        onToggleWritable={(device) => {
                          void api
                            .setDeviceWritable(device.id, !device.writable)
                            .then(() => devices.refresh())
                        }}
                        onToggleOwner={(device) => {
                          void api
                            .setDeviceOwner(device.id, !device.owner)
                            .then(() => {
                              devices.refresh()
                              status.refresh()
                            })
                            .catch(() => devices.refresh())
                        }}
                      />
                      <OwnerLine endorsement={current.endorsement} devices={list} />
                    </Group>

                    <Group
                      icon={Users}
                      title="Profiles"
                      aside={current.profiles.length > 0 ? current.profiles.length : undefined}
                    >
                      <ProfileLinks
                        links={links.data ?? []}
                        onApprove={(link) => {
                          void api
                            .approveProfileLink(link.id)
                            .then(() => {
                              links.refresh()
                              status.refresh()
                            })
                            .catch((e: unknown) => setRulesError(reason(e)))
                        }}
                        onDeny={(link) => {
                          void api.denyProfileLink(link.id).then(() => links.refresh())
                        }}
                      />
                      <ProfileList
                        profiles={current.profiles}
                        ownerAdds={current.profileRules.ownerAddsProfiles}
                        onAdd={() => setAdding(true)}
                        onNewCode={(profile) => {
                          void api.newClaimCode(profile.id).then(apply)
                        }}
                        onResetPin={(profile) =>
                          setPrompt({
                            title: `Reset ${profile.name}'s PIN?`,
                            value: profile.name,
                            confirmLabel: 'Reset PIN',
                            select: 'all',
                            // The dialog is the confirmation: every device signed
                            // in to this profile is signed out, and the next
                            // sign-in chooses a new PIN.
                            onConfirm: () => {
                              void api.resetProfilePin(profile.id).then(apply)
                            },
                          })
                        }
                        onRemove={(profile) =>
                          setPrompt({
                            title: `Remove ${profile.name}?`,
                            value: profile.name,
                            confirmLabel: 'Remove',
                            select: 'all',
                            // With its watch history and stars. The files on the
                            // drive are not touched.
                            onConfirm: () => {
                              void api.removeProfile(profile.id).then(apply)
                            },
                          })
                        }
                      />
                      <ProfileAccess
                        rules={current.profileRules}
                        profileCount={current.profiles.length}
                        error={rulesError}
                        onRequireProfile={(require) => {
                          setRulesError(null)
                          void api
                            .setRequireProfile(require)
                            .then(apply)
                            .catch((e: unknown) => setRulesError(reason(e)))
                        }}
                        onOwnerAddsProfiles={(ownerOnly) => {
                          setRulesError(null)
                          void api
                            .setOwnerAddsProfiles(ownerOnly)
                            .then(apply)
                            .catch((e: unknown) => setRulesError(reason(e)))
                        }}
                        onClaimCode={(required) => {
                          setRulesError(null)
                          void api
                            .setClaimCode(required)
                            .then(apply)
                            .catch((e: unknown) => setRulesError(reason(e)))
                        }}
                      />
                    </Group>
                    <ComputerSettings
                      status={current}
                      onRequirePin={(require) => {
                        if (require) setRequirePin(true)
                        else setAskNoPin(true)
                      }}
                      onStartWithWindows={(enabled) => {
                        void api.setStartWithWindows(enabled).then(apply)
                      }}
                      onRename={(name) => {
                        void api.setHostName(name).then(apply)
                      }}
                      build={build}
                      onOpenLog={() => void api.openLogFolder().catch(() => {})}
                    />
                  </div>

                  <div className="flex min-w-0 flex-col gap-4">
                    <LibrarySettings
                      status={current}
                      onLibrary={(enabled) => {
                        void api.setLibraryEnabled(enabled).then(apply)
                      }}
                      onRescan={() => {
                        void api.rescanLibrary().then(apply)
                      }}
                      onPosters={(enabled) => {
                        void api.setPosters(enabled).then(apply)
                      }}
                      onTmdbKey={(key) => {
                        void api.setTmdbKey(key).then(apply)
                      }}
                      onPreviews={(enabled) => {
                        void api.setPreviews(enabled).then(apply)
                      }}
                      onPreviewsWhen={(when) => {
                        void api.setPreviewsWhen(when).then(apply)
                      }}
                      onMakeMissingPreviews={() => {
                        void api.makeMissingPreviews().then(apply)
                      }}
                      onMusicCovers={(enabled) => {
                        void api.setMusicCovers(enabled).then(apply)
                      }}
                      onFanartKey={(key) =>
                        api
                          .setFanartKey(key)
                          .then((next) => {
                            apply(next)
                            return null
                          })
                          .catch((e: unknown) => reason(e))
                      }
                    />
                    <ConversionSettings
                      status={current}
                      onConversion={(enabled) => {
                        void api.setConversion(enabled).then(apply)
                      }}
                      onConversionAtOnce={(atOnce) => {
                        void api.setConversionAtOnce(atOnce).then(apply)
                      }}
                      onMeasureConversion={() => {
                        void api
                          .measureConversion()
                          .then(apply)
                          .catch((e: unknown) =>
                            setMessage({ title: 'Can’t measure right now', message: reason(e) }),
                          )
                      }}
                    />
                    <SectionSettings
                      status={current}
                      onSections={(sections) => {
                        void api.setSections(sections).then(apply)
                      }}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </main>

      <PromptDialog request={prompt} onClose={() => setPrompt(null)} />
      <MessageDialog request={message} onClose={() => setMessage(null)} />
      <ConfirmDialog
        request={
          askNoPin
            ? {
                title: 'Let devices join without a PIN?',
                message:
                  'Any device on the same network could join and open the drive. Turn it back on once your new device has joined.',
                confirmLabel: 'Turn off',
                danger: true,
              }
            : null
        }
        onAnswer={(yes) => {
          setAskNoPin(false)
          if (yes) setRequirePin(false)
        }}
      />
      {current && (
        <AddProfileDialog
          open={adding}
          taken={current.profiles.map((p) => p.name.toLowerCase())}
          onClose={() => setAdding(false)}
          onAdd={(name, color) => api.addProfile(name, color).then(apply)}
        />
      )}
    </div>
  )
}

/**
 * The first moment, before the backend has answered.
 *
 * It says something. The client once showed a bare black window here, and the
 * only honest reading of that from the outside was a crash.
 */
function Splash({
  message,
  onOpenLog,
}: {
  message?: string
  onOpenLog?: () => void
}): React.JSX.Element {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4">
      <div className="backdrop" />
      <motion.div
        animate={{ opacity: [0.4, 0.9, 0.4] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        className="relative z-10 text-basaltDeep"
      >
        <HexMark size={30} />
      </motion.div>
      <p className="relative z-10 max-w-[320px] text-center text-[12px] leading-relaxed text-textFaint">
        {message ?? 'Starting up…'}
      </p>
      {onOpenLog && (
        <button
          onClick={onOpenLog}
          className="relative z-10 font-mono text-[10px] text-textFaint underline decoration-dotted underline-offset-2 transition-colors hover:text-textDim"
        >
          open the log folder
        </button>
      )}
    </div>
  )
}

/** A refusal from the host, as a sentence. */
function reason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.charAt(0).toUpperCase() + message.slice(1) + (message.endsWith('.') ? '' : '.')
}
