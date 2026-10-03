import { useEffect } from 'react'
import { onDmReceived } from '../lib/p2p/roomManager'
import { notifyIncomingDm } from '../lib/notifications'

/**
 * Desktop notifications — spec RF-09. M3 scope: incoming DMs while the tab
 * is hidden and the permission is already granted (§10.5 exact title/body;
 * click → window focus + navigation to the DM view). The permission request
 * and the settings toggle arrive with the M5 settings modal — nothing here
 * ever prompts.
 */
export function useNotifications(): void {
  useEffect(
    () =>
      onDmReceived((peerId, nick, text) => {
        notifyIncomingDm({ peerId, nick, text })
      }),
    [],
  )
}
