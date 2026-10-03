import { useEffect } from 'react'
import { onDmReceived, onMentionReceived } from '../lib/p2p/roomManager'
import { notifyIncomingDm, notifyMention } from '../lib/notifications'

/**
 * Desktop notifications — spec RF-09/§10.5. Subscribes to the two manager
 * seams (incoming DMs and room messages mentioning the own nickname) and
 * shows OS notifications only behind the full gate: permission granted AND
 * settings.notifications on AND document.hidden. Click focuses the window
 * and navigates to the origin view. Nothing here ever prompts for
 * permission — the request lives in the settings modal (RF-07).
 */
export function useNotifications(): void {
  useEffect(() => {
    const offDm = onDmReceived((peerId, nick, text) => {
      notifyIncomingDm({ peerId, nick, text })
    })
    const offMention = onMentionReceived((roomId, roomName, nick, text) => {
      notifyMention({ roomId, roomName, nick, text })
    })
    return () => {
      offDm()
      offMention()
    }
  }, [])
}
