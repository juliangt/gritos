import { useAppStore } from '../stores/useAppStore'
import { useSettingsStore } from '../stores/useSettingsStore'

/**
 * Desktop notifications — spec §10.5/RF-09. The full gate is:
 * browser permission granted AND settings.notifications on AND the tab
 * hidden (document.hidden). Only two triggers exist: (a) a room message
 * mentioning `@<own-nickname>` and (b) an incoming DM. Titles/bodies use
 * the exact §10.5 formats; clicking focuses the window and navigates to
 * the origin view. Every Notification access is guarded so environments
 * without the API (tests, old browsers) can never crash.
 */

/** §10.5 — exact DM title format: 'gritos — DM from <nick>'. */
export function dmNotificationTitle(nick: string): string {
  return `gritos — DM from ${nick}`
}

/** §10.5 — exact mention title format: 'gritos — mention in #<room>'. */
export function mentionNotificationTitle(roomName: string): string {
  return `gritos — mention in #${roomName}`
}

/** §10.5 — exact body format: '<nick>: <text>'. */
export function notificationBody(nick: string, text: string): string {
  return `${nick}: ${text}`
}

export interface NotificationGating {
  /** document.hidden — notifications only fire for hidden tabs. */
  hidden: boolean
  /** Notification.permission, or undefined when the API does not exist. */
  permission: string | undefined
  /** settings.notifications — the user's master toggle (RF-09). */
  enabled: boolean
}

/** Pure gate (RF-09): settings on AND hidden tab AND permission granted. */
export function shouldNotify(gating: NotificationGating): boolean {
  return gating.enabled && gating.hidden && gating.permission === 'granted'
}

/**
 * Transport-level gate kept from M3 (hidden + granted) — used internally
 * and by legacy callers; the settings toggle is checked separately.
 */
export function shouldNotifyDm(gating: Omit<NotificationGating, 'enabled'>): boolean {
  return gating.hidden && gating.permission === 'granted'
}

export interface IncomingDm {
  peerId: string
  nick: string
  text: string
}

export interface RoomMention {
  roomId: string
  /** Normalized room name, without '#'. */
  roomName: string
  nick: string
  text: string
}

interface FocusableNotification {
  onclick: (() => void) | null
}

/** True when the API exists and the user allowed notifications. */
export function isNotificationPermissionGranted(): boolean {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted'
  } catch {
    return false
  }
}

/**
 * Requests browser notification permission (RF-07, the Privacy tab). Never
 * throws; resolves to undefined when the API does not exist.
 */
export function requestNotificationPermission(): Promise<string | undefined> {
  try {
    if (typeof Notification === 'undefined') return Promise.resolve(undefined)
    return Notification.requestPermission().catch(() => undefined)
  } catch {
    return Promise.resolve(undefined)
  }
}

/** The three RF-07 permission states, for the settings UI wording. */
export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported'

export function notificationPermissionState(): NotificationPermissionState {
  try {
    if (typeof Notification === 'undefined') return 'unsupported'
    const permission = Notification.permission
    if (permission === 'granted' || permission === 'denied') return permission
    return 'default'
  } catch {
    return 'unsupported'
  }
}

/** RF-09 gate evaluated against the live environment + settings store. */
function gateOpen(): boolean {
  if (typeof document === 'undefined' || !document.hidden) return false
  if (typeof Notification === 'undefined') return false
  return shouldNotify({
    hidden: true,
    permission: Notification.permission,
    enabled: useSettingsStore.getState().settings.notifications,
  })
}

/** Shows a notification and wires its click handler; true when shown. */
function show(title: string, body: string, onClick: () => void): boolean {
  try {
    if (!gateOpen()) return false
    const notification = new Notification(title, { body }) as FocusableNotification
    notification.onclick = () => {
      window.focus()
      onClick()
    }
    return true
  } catch {
    // No Notification API, denied permission lookups, or construction
    // failures: notifications are best-effort and must never crash the app.
    return false
  }
}

/**
 * Incoming DM notification (§10.5): title 'gritos — DM de <nick>', body
 * '<nick>: <text>'; click focuses the tab and opens the DM view.
 */
export function notifyIncomingDm(dm: IncomingDm): boolean {
  return show(dmNotificationTitle(dm.nick), notificationBody(dm.nick, dm.text), () => {
    useAppStore.getState().setActiveView({ kind: 'dm', peerId: dm.peerId })
  })
}

/**
 * Room mention notification (§10.5): title 'gritos — mention in #<room>',
 * body '<nick>: <text>'; click focuses the tab and opens the room view.
 */
export function notifyMention(mention: RoomMention): boolean {
  return show(
    mentionNotificationTitle(mention.roomName),
    notificationBody(mention.nick, mention.text),
    () => {
      useAppStore.getState().setActiveView({ kind: 'room', id: mention.roomId })
    },
  )
}
