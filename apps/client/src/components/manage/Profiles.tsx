import { useState } from 'react'
import { Check, KeyRound, Loader2, Lock, Plus, Trash2, UserPlus, Users, X } from 'lucide-react'
import type { ManagedProfile } from '@/lib/manage'
import { PROFILE_COLORS } from '@/lib/useIdentity'
import { cn } from '@/lib/utils'
import { Avatar, Card, Group, Pill, Row, Rows, Segmented, Tag, Toggle, ago, useLayout } from './parts'
import { Surface } from './Surface'
import type { Tools } from './tools'

/**
 * The people who use the drive, and the rules about them: whether everyone
 * signs in to one, and who may add one.
 */
export function Profiles(tools: Tools): React.JSX.Element {
  const { m, view } = tools
  const layout = useLayout()
  const phone = layout === 'phone'
  const { profiles, profileRules: rules } = view.status
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const open = profiles.find((p) => p.id === openId) ?? null

  const links = view.profileLinks ?? []

  return (
    <>
      {links.length > 0 && (
        <div className="space-y-3">
          {links.map((link) => (
            <Card key={link.id} tone="raised">
              <div className="p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={link.name} color={link.color} size={phone ? 40 : 34} />
                  <div className="min-w-0 flex-1">
                    <div className={cn('truncate font-medium text-text', phone ? 'text-[15px]' : 'text-[13px]')}>
                      {link.name} <span className="font-normal text-textDim">from {link.home}</span>
                    </div>
                    <div className={cn('leading-snug text-textDim', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
                      {link.deviceName} asks to use this profile here
                    </div>
                  </div>
                </div>
                <p className={cn('mt-3 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
                  It signs in on {link.home}, with no PIN here, and keeps its own history and stars on
                  this drive.
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Pill onClick={() => void m.act({ do: 'denyProfileLink', id: link.id })} icon={<X size={14} />}>
                    Turn away
                  </Pill>
                  <Pill
                    onClick={() => void m.act({ do: 'approveProfileLink', id: link.id })}
                    busy={m.busy === 'approveProfileLink'}
                    icon={<Check size={14} />}
                  >
                    Let in
                  </Pill>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Group icon={Users} title="Profiles" aside={profiles.length > 0 ? `${profiles.length}` : undefined}>
        <Rows>
          {profiles.map((profile) => (
            <Row
              key={profile.id}
              icon={<Avatar name={profile.name} color={profile.color} size={phone ? 40 : 32} />}
              title={profile.name}
              sub={profile.home ? `From ${profile.home} · ${profileLine(profile).toLowerCase()}` : profileLine(profile)}
              end={
                !profile.hasPin && !profile.home ? (
                  <Tag icon={<KeyRound size={10} />}>new PIN</Tag>
                ) : undefined
              }
              chevron
              onClick={() => setOpenId(profile.id)}
            />
          ))}
          <Row
            icon={
              <span className="flex h-full w-full items-center justify-center rounded-[inherit] text-basalt">
                <Plus size={phone ? 19 : 15} />
              </span>
            }
            title={<span className="text-basalt">Add a profile</span>}
            sub={profiles.length === 0 ? 'Each person gets their own history and stars' : undefined}
            onClick={() => setAdding(true)}
          />
        </Rows>

        <div className="border-t border-white/[0.05]">
          <Toggle
            title="Require a profile"
            description={
              profiles.length === 0
                ? 'Add a profile first. With none, nobody could sign in.'
                : rules.requireProfile
                  ? 'Every device signs in to a profile. Nobody uses the drive as just a device.'
                  : 'Devices can also continue as themselves, keeping their own history and stars.'
            }
            checked={rules.requireProfile}
            disabled={profiles.length === 0 && !rules.requireProfile}
            onChange={(require) => m.act({ do: 'setRequireProfile', require })}
          />
          <div className={cn('px-4', phone ? 'pb-4 pt-1' : 'pb-3.5 pt-1')}>
            <div className={cn('mb-2 text-text', phone ? 'text-[15px]' : 'text-[13px]')}>Who can add profiles</div>
            <Segmented
              label="Who can add profiles"
              value={rules.ownerAddsProfiles ? 'managers' : 'anyone'}
              options={[
                { value: 'anyone', label: 'Anyone' },
                { value: 'managers', label: 'Only who manages' },
              ]}
              onChange={(value) => void m.act({ do: 'setOwnerAddsProfiles', ownerOnly: value === 'managers' })}
            />
            <p className={cn('mt-2 leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
              {rules.ownerAddsProfiles
                ? 'Profiles are added here, or at the host. Each person chooses their own PIN the first time they sign in.'
                : 'A new profile can be made from any paired device, by whoever is using it.'}
            </p>
          </div>
          {rules.requireProfile && rules.ownerAddsProfiles && (
            <p
              className={cn(
                'flex items-start gap-2 border-t border-white/[0.05] px-4 py-3 leading-snug text-textDim',
                phone ? 'text-[12.5px]' : 'text-[11.5px]',
              )}
            >
              <Lock size={13} className="mt-0.5 shrink-0 text-basalt" />
              A private drive: only the people added here can use it, each with their own PIN.
            </p>
          )}
        </div>
      </Group>

      <Surface open={open !== null} onClose={() => setOpenId(null)} title={open?.name ?? ''}>
        {open && <ProfileDetail tools={tools} profile={open} onDone={() => setOpenId(null)} />}
      </Surface>

      <Surface open={adding} onClose={() => setAdding(false)} title="Add a profile">
        {adding && <AddProfile tools={tools} onDone={() => setAdding(false)} />}
      </Surface>
    </>
  )
}

function profileLine(profile: ManagedProfile): string {
  if (!profile.lastUsed) return 'Not used yet'
  const on = profile.devices.length
  return `Used ${ago(profile.lastUsed)}${on > 0 ? ` · on ${on} ${on === 1 ? 'device' : 'devices'}` : ''}`
}

function ProfileDetail({
  tools,
  profile,
  onDone,
}: {
  tools: Tools
  profile: ManagedProfile
  onDone: () => void
}): React.JSX.Element {
  const { m, confirm } = tools
  const phone = useLayout() === 'phone'

  const resetPin = async (): Promise<void> => {
    const ok = await confirm({
      title: `Reset the PIN for ${profile.name}?`,
      message: `The next sign-in to ${profile.name} chooses a new PIN, and every device that remembered the old one asks again.`,
      confirmLabel: 'Reset PIN',
    })
    if (ok) await m.act({ do: 'resetProfilePin', id: profile.id })
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${profile.name}?`,
      message: `The history and stars of ${profile.name} on this host go with it. Nothing on the drive is touched.`,
      confirmLabel: 'Remove profile',
      danger: true,
    })
    if (ok && (await m.act({ do: 'removeProfile', id: profile.id }))) onDone()
  }

  return (
    <div className={phone ? 'space-y-3 px-4 pb-4 pt-1' : 'space-y-3 p-4'}>
      <div className="flex items-center gap-3.5 px-1 pb-1">
        <Avatar name={profile.name} color={profile.color} size={phone ? 56 : 44} />
        <div className="min-w-0">
          <div className={cn('text-textDim', phone ? 'text-[13px]' : 'text-[12px]')}>
            {profile.home
              ? `Signs in on ${profile.home}, with no PIN here`
              : profile.hasPin
                ? 'Signs in with a PIN'
                : 'Chooses a new PIN at the next sign-in'}
          </div>
          <div className={cn('mt-0.5 text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
            Made {ago(profile.createdAt)}
            {profile.lastUsed ? ` · used ${ago(profile.lastUsed)}` : ' · not used yet'}
          </div>
        </div>
      </div>

      {profile.devices.length > 0 && (
        <Card>
          <div className="px-4 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-textFaint">
            Signed in on
          </div>
          <Rows>
            {profile.devices.map((device, i) => (
              <Row
                key={`${device.name}-${i}`}
                title={device.name}
                sub={`${
                  profile.home
                    ? device.remembered
                      ? 'Stays signed in'
                      : 'Until the app closes'
                    : device.remembered
                      ? 'Remembers the PIN'
                      : 'Asks for the PIN each time'
                } · ${ago(device.lastUsed)}`}
              />
            ))}
          </Rows>
        </Card>
      )}

      <Card>
        <Rows>
          {!profile.home && (
            <Row
              icon={<KeyRound size={phone ? 17 : 14} />}
              title="Reset PIN"
              sub="For a forgotten PIN: a new one is chosen at the next sign-in"
              onClick={() => void resetPin()}
              disabled={!profile.hasPin}
            />
          )}
          <Row
            icon={<Trash2 size={phone ? 17 : 14} />}
            title="Remove profile"
            danger
            onClick={() => void remove()}
          />
        </Rows>
      </Card>
    </div>
  )
}

function AddProfile({ tools, onDone }: { tools: Tools; onDone: () => void }): React.JSX.Element {
  const { m, view } = tools
  const phone = useLayout() === 'phone'
  const [name, setName] = useState('')
  // A colour nobody has yet, where there is one.
  const [color, setColor] = useState(() => {
    const taken = new Set(view.status.profiles.map((p) => p.color % PROFILE_COLORS.length))
    return PROFILE_COLORS.findIndex((_, i) => !taken.has(i)) === -1
      ? 0
      : PROFILE_COLORS.findIndex((_, i) => !taken.has(i))
  })
  const busy = m.busy === 'addProfile'
  const trimmed = name.trim()

  const add = async (): Promise<void> => {
    if (!trimmed || busy) return
    if (await m.act({ do: 'addProfile', name: trimmed, color })) onDone()
  }

  return (
    <form
      className={phone ? 'px-5 pb-4 pt-2' : 'p-5'}
      onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}
    >
      <div className="flex flex-col items-center">
        <Avatar name={trimmed || '?'} color={color} size={phone ? 72 : 60} />
      </div>

      <input
        autoFocus
        value={name}
        maxLength={32}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        spellCheck={false}
        aria-label="Name"
        className={cn(
          'mt-5 w-full border border-white/[0.09] bg-white/[0.04] text-center text-text outline-none transition-colors placeholder:text-textFaint focus:border-white/25',
          phone ? 'h-12 rounded-xl px-4 text-[16px]' : 'h-10 rounded-md px-3 text-[13px]',
        )}
      />

      <div className="mt-4 flex flex-wrap justify-center gap-2.5" role="radiogroup" aria-label="Colour">
        {PROFILE_COLORS.map((hex, i) => (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={i === color}
            aria-label={`Colour ${i + 1}`}
            onClick={() => setColor(i)}
            className={cn(
              'flex items-center justify-center rounded-full transition-transform duration-150',
              phone ? 'h-9 w-9' : 'h-7 w-7',
              i === color ? 'scale-110 ring-2 ring-white/70 ring-offset-2 ring-offset-[#141416]' : 'active:scale-95',
            )}
            style={{ background: hex }}
          >
            {i === color && <Check size={phone ? 16 : 13} className="text-white" />}
          </button>
        ))}
      </div>

      <p className={cn('mt-4 text-center leading-snug text-textFaint', phone ? 'text-[12.5px]' : 'text-[11.5px]')}>
        They choose their own PIN the first time they sign in.
      </p>

      <button
        type="submit"
        disabled={!trimmed || busy}
        className={cn(
          'mt-4 flex w-full items-center justify-center gap-2 bg-basalt font-medium text-ink transition-opacity disabled:opacity-40',
          phone ? 'h-12 rounded-xl text-[15px] active:opacity-80' : 'h-9 rounded-md text-[13px] hover:opacity-90',
        )}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={phone ? 17 : 14} />}
        Add profile
      </button>
    </form>
  )
}
