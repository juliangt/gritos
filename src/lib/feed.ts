/**
 * Chat-feed presentation helpers (RF-03 / RF-06 / spec §10.4): system-line
 * texts, the FIFO separator, smart-scroll decision, HH:MM formatting and
 * the typing-indicator line. Pure functions, unit-testable without DOM.
 */

/** RF-03 — separator shown when the 500-message cap has trimmed history. */
export const FIFO_SEPARATOR_TEXT = '— mensajes anteriores descartados —'

// ---------------------------------------------------------------------------
// Empty states (M6, spec §10.4 — discrete, Spanish)
// ---------------------------------------------------------------------------

/** Empty room feed: invites sharing the room name (RF-02). */
export const EMPTY_ROOM_FEED_TEXT = 'Comparte el nombre de la sala para que otros se unan.'

/** Empty DM feed (RF-04): the conversation exists but has no messages yet. */
export const EMPTY_DM_FEED_TEXT = 'Todavía no hay mensajes. Escribe el primero.'

/** Empty *Mensajes directos* section (RF-04): no open DM channels. */
export const EMPTY_DM_LIST_TEXT =
  'Aún no hay mensajes directos. Abre el menú de un par para iniciar una conversación cifrada.'

/** Empty *Recientes* section (RF-02): nothing remembered yet. */
export const EMPTY_RECENTS_TEXT = 'Sin salas recientes todavía.'

/** RF-03 — auto-scroll only when the user is at most this far from the bottom. */
export const SMART_SCROLL_THRESHOLD_PX = 150

/** ChatInput — typing signals are sent at most once per second (RF-03). */
export const TYPING_SIGNAL_THROTTLE_MS = 1_000

/** ChatInput — typing stops after this much idle time (RF-03). */
export const TYPING_IDLE_STOP_MS = 2_000

/** ChatInput — the character counter becomes visible from this length. */
export const CHAR_COUNTER_FROM = 3_800

/** True when the feed may auto-scroll (user is ≤ threshold px from bottom). */
export function shouldAutoScroll(distanceFromBottomPx: number): boolean {
  return distanceFromBottomPx <= SMART_SCROLL_THRESHOLD_PX
}

/** Local HH:MM for a message timestamp (RF-03: author's ts, local render). */
export function formatTimeHHMM(ts: number): string {
  const date = new Date(ts)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** RF-06 — system feed lines for peer joins/leaves. */
export function joinSystemLine(nickname: string): string {
  return `— ${nickname} se ha unido —`
}

export function leaveSystemLine(nickname: string): string {
  return `— ${nickname} ha salido —`
}

/**
 * Typing indicator line (RF-03): one known nick → 'nick está escribiendo…',
 * several → 'N personas están escribiendo…', none → null (bar hidden).
 */
export function typingStatusText(nicknames: readonly string[]): string | null {
  if (nicknames.length === 0) return null
  if (nicknames.length === 1) return `${nicknames[0] as string} está escribiendo…`
  return `${nicknames.length} personas están escribiendo…`
}

/** Floating new-messages button label (RF-03: '↓ N mensajes nuevos'). */
export function newMessagesButtonText(count: number): string {
  const noun = count === 1 ? 'mensaje nuevo' : 'mensajes nuevos'
  return `↓ ${count} ${noun}`
}

// ---------------------------------------------------------------------------
// DM view texts (RF-04, exact spec wording)
// ---------------------------------------------------------------------------

/** RF-04 — header state when the peer shares no active room anymore. */
export const DM_DISCONNECTED_TEXT = 'El par se ha desconectado'

/** RF-04 — TOFU verification notice shown under the peer's fingerprint. */
export const DM_VERIFY_NOTICE = 'Compáralo con tu interlocutor para verificar su identidad'

/** Accessible label of the DM message feed. */
export function dmFeedLabel(peerNick: string): string {
  return `Mensajes directos con ${peerNick}`
}
