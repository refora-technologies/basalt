import { useEffect, useRef } from 'react'

import { api, onNotification } from '@/lib/api'
import { android } from '@/lib/android'
import { isAndroid } from '@/lib/platform'
import { isProgram, titleOf } from '@/lib/share'
import type { Nearby } from '@/lib/useNearby'

/**
 * Notifications for shares from devices nearby, while Basalt is out of sight:
 * an offer, with Accept and Decline in it, and files that arrived. On a
 * computer, its own (shown only with the window hidden); on a phone,
 * Android's, when the app isn't in front. Each is told once.
 */
export function useNearbyNotifications(nearby: Nearby): void {
  const told = useRef(new Set<string>())
  const started = useRef(Date.now())
  const nearbyRef = useRef(nearby)
  nearbyRef.current = nearby

  useEffect(() => {
    for (const offer of nearby.incoming) {
      if (offer.accepted || told.current.has(offer.ask)) continue
      told.current.add(offer.ask)
      const title = `${offer.from.name} · ${offer.from.id} wants to send you ${titleOf(offer.files.map((f) => ({ ...f, path: '' })))}`
      const text = offer.code ? 'A device nearby · a code is asked' : 'A device nearby'
      if (isAndroid()) {
        // Shown only with the app out of sight: Android knows, the page may not.
        void android
          .notifyShare(`nearby-${offer.ask}`, title, text, ['Accept|accept', 'Decline|decline'], true)
          .then((shown) => api.nearbyNote(`offer from ${offer.from.id}: notified ${shown}, page ${document.visibilityState}`))
          .catch(() => {})
      } else {
        void api
          .notify(`nearby-${offer.ask}`, title, text, [
            ['Accept', 'accept'],
            ['Decline', 'decline'],
          ])
          .catch(() => {})
      }
    }
  }, [nearby.incoming])

  useEffect(() => {
    for (const item of nearby.items) {
      if (item.direction !== 'in' || item.state !== 'done' || item.at < started.current) continue
      const tag = `arrived-${item.id}`
      if (told.current.has(tag)) continue
      told.current.add(tag)
      const title = `${titleOf(item.files)} arrived`
      const text = `From ${item.peer.name} · ${item.savedAs ?? ''}`
      if (isAndroid()) {
        // In front, the sheet says so already.
        const one = item.saved?.length === 1 && !isProgram(item.saved[0]!.name)
        void android.notifyShare(item.id, title, text, one ? ['Open|open'] : [], true).catch(() => {})
      } else {
        void api.notify(item.id, title, text).catch(() => {})
      }
    }
  }, [nearby.items])

  // Sent from here: accepted, arrived, or declined there.
  const sentSeen = useRef(new Map<string, string>())
  useEffect(() => {
    for (const item of nearby.items) {
      if (item.direction !== 'out') continue
      const before = sentSeen.current.get(item.id)
      sentSeen.current.set(item.id, item.state)
      if (before === undefined || before === item.state) continue
      const said =
        item.state === 'moving'
          ? `${item.peer.name} accepted ${titleOf(item.files)}`
          : item.state === 'done'
            ? `${titleOf(item.files)} arrived on ${item.peer.name}`
            : item.state === 'declined'
              ? `${item.peer.name} declined ${titleOf(item.files)}`
              : item.state === 'failed'
                ? `${titleOf(item.files)} didn’t arrive on ${item.peer.name}`
                : null
      if (!said) continue
      if (isAndroid()) {
        void android.notifyShare(`sent-${item.id}`, said, 'A device nearby', [], true).catch(() => {})
      } else {
        void api.notify(`sent-${item.id}`, said, 'A device nearby').catch(() => {})
      }
    }
  }, [nearby.items])

  // A computer's buttons in its notification.
  useEffect(() => {
    if (isAndroid()) return undefined
    let stop: (() => void) | null = null
    let gone = false
    void onNotification(({ tag, action }) => {
      if (!tag.startsWith('nearby-')) return
      const ask = tag.slice('nearby-'.length)
      if (action === 'accept') nearbyRef.current.accept(ask)
      else if (action === 'decline') nearbyRef.current.decline(ask)
      else nearbyRef.current.setScreenOpen(true)
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  }, [])
}
