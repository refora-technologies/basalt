import { useEffect, useRef } from 'react'

import { api, onNotification, onOpenPage } from '@/lib/api'
import type { Inbox } from '@/lib/useInbox'
import type { Presence } from '@/lib/usePresence'
import { calledOf, titleOf } from '@/lib/share'
import type { NavKey } from '@/components/Sidebar'

/**
 * The computer's notifications for shares, while its window is out of sight
 * (closed to the tray, or minimised): an offer, with Accept and Decline right
 * in it, and a file that arrived by itself. Pressed, the window comes back.
 */
export function useShareNotifications(inbox: Inbox, presence: Presence, setNav: (nav: NavKey) => void): void {
  // Each share's state when last looked at, and when this page started: a
  // share already there when it loaded (from before a reload, or another
  // day) is never told again; only what comes, or changes, while it runs.
  const seen = useRef(new Map<string, string>())
  const started = useRef(Date.now())
  const inboxRef = useRef(inbox)
  inboxRef.current = inbox
  const myProfile = presence.devices.find((d) => d.device === presence.you)?.profile

  useEffect(() => {
    // Told once each; the app shows it only with its window out of sight
    // (in the tray, minimised or behind another), where the card in the
    // corner can't be seen.
    for (const item of inbox.items) {
      if (item.direction !== 'in') continue
      const before = seen.current.get(item.id)
      seen.current.set(item.id, item.state)
      if (before === item.state) continue
      if (before === undefined && item.at < started.current) continue
      const from = calledOf(item.peer, myProfile)
      if (item.state === 'waiting' && item.offer) {
        void api
          .notify(
            item.id,
            `${item.peer.profileName ?? item.peer.name} wants to send you ${titleOf(item.files)}`,
            `From ${from}`,
            [
              ['Accept', 'accept'],
              ['Decline', 'decline'],
            ],
          )
          .catch(() => {})
      } else if (item.state === 'done' && !item.takenOn) {
        void api.notify(item.id, `${titleOf(item.files)} arrived`, `From ${from} · ${item.savedAs ?? ''}`).catch(() => {})
      }
    }
  }, [inbox.items, myProfile])

  useEffect(() => {
    const stops: (() => void)[] = []
    let gone = false
    void onNotification(({ tag, action }) => {
      // A device nearby's: its own hook answers it.
      if (tag.startsWith('nearby-')) return
      const item = inboxRef.current.items.find((i) => i.id === tag && i.direction === 'in')
      if (item && item.state === 'waiting' && action === 'accept') inboxRef.current.accept(item)
      else if (item && item.state === 'waiting' && action === 'decline') inboxRef.current.decline(item)
      else setNav('inbox')
    }).then((stop) => (gone ? stop() : stops.push(stop)))
    void onOpenPage((page) => {
      if (page === 'inbox') setNav('inbox')
    }).then((stop) => (gone ? stop() : stops.push(stop)))
    return () => {
      gone = true
      stops.forEach((stop) => stop())
    }
  }, [setNav])
}
