import { useAppStore } from '../stores/useAppStore'

/**
 * Basic incoming-DM desktop notifications — spec §10.5/RF-09 (technical
 * path; the permission flow and settings toggle land in M5). A DM shows a
 * notification only when the tab is hidden AND the browser permission is
 * already granted; clicking focuses the window and navigates to the DM.
 * Every access to the Notification API is guarded so environments without
 * it (tests, old browsers) can never crash.
 */

/** §10.5 — exact title format: 'gritos — DM de <nick>'. */
export function dmNotificationTitle(nick: string): string {
  return `gritos — DM de ${nick}`
}

/** §10.5 — exact body format: '<nick>: <text>'. */
export function dmNotificationBody(nick: string, text: string): string {
  return `${nick}: ${text}`
}

export interface DmNotificationGating {
  /** document.hidden — notifications only fire for hidden tabs. */
  hidden: boolean
  /** Notification.permission, or undefined when the API does not exist. */
  permission: string | undefined
}

/** Pure gate (§10.5 + RF-09): hidden tab AND permission already granted. */
export function shouldNotifyDm(gating: DmNotificationGating): boolean {
  return gating.hidden && gating.permission === 'granted'
}

export interface IncomingDm {
  peerId: string
  nick: string
  text: string
}

interface FocusableNotification {
  onclick: (() => void) | null
}

/**
 * Shows the incoming-DM notification when the gate allows it. Returns true
 * when a notification was created. Never throws: any environment error
 * (missing API, constructor failure) degrades to `false`.
 */
export function notifyIncomingDm(dm: IncomingDm): boolean {
  try {
    if (typeof document === 'undefined' || !document.hidden) return false
    if (typeof Notification === 'undefined') return false
    if (!shouldNotifyDm({ hidden: document.hidden, permission: Notification.permission })) {
      return false
    }
    const notification = new Notification(dmNotificationTitle(dm.nick), {
      body: dmNotificationBody(dm.nick, dm.text),
    }) as FocusableNotification
    notification.onclick = () => {
      window.focus()
      useAppStore.getState().setActiveView({ kind: 'dm', peerId: dm.peerId })
    }
    return true
  } catch {
    // No Notification API, denied permission lookups, or construction
    // failures: notifications are best-effort and must never crash the app.
    return false
  }
}
