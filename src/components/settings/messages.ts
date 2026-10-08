/**
 * Exact Spanish wording of the settings validation messages (RF-07) and of
 * the shared P2P disclosure (issue #35) — shared by the components and
 * their tests so the spec strings live in one place.
 */

export const TRACKER_ERROR_TEXT = 'Las URLs de tracker deben empezar por wss://'
export const ICE_ERROR_TEXT = 'Los servidores ICE deben empezar por stun: o turn:'
export const MAX_ROOMS_ERROR_TEXT = 'El límite de salas activas debe estar entre 1 y 6.'

export const EMPTY_TRACKERS_HINT = 'Lista vacía: se usan los trackers por defecto de Trystero.'
export const EMPTY_ICE_HINT = 'Lista vacía: se usa la configuración ICE por defecto de Trystero.'
export const RECONNECT_NOTE = 'Los cambios de red se aplican al reconectar las salas.'

/**
 * Issue #30 — persistent-storage disclosure shown next to the TURN
 * credential fields while `rememberTurnCredentials` is on. Shared by the
 * Red tab and the Privacidad at-rest note.
 */
export const TURN_CREDENTIAL_STORAGE_HINT =
  'Las credenciales TURN se guardan sin cifrar en este navegador.'

/** Issue #30 — shown while «Recordar credenciales TURN» is off. */
export const TURN_CREDENTIAL_MEMORY_HINT =
  'Las credenciales TURN solo se guardan en memoria y se pierden al cerrar la pestaña.'

/**
 * Issue #35 — P2P exposure disclosures (onboarding line and Privacidad-tab
 * note): direct WebRTC connections reveal the IP to room peers (and, in
 * less detail, to tracker operators); a configured TURN does not hide it
 * (the browser still announces the public address among the ICE candidates).
 */
export const P2P_DISCLOSURE_TEXT =
  'Las conexiones son P2P: quienes compartan sala contigo pueden ver tu dirección IP.'

export const P2P_IP_EXPOSURE_NOTE =
  'Las conexiones son P2P por diseño: quienes compartan sala contigo pueden ver tu dirección IP, y configurar TURN no la oculta a los pares (el navegador sigue anunciando tu dirección pública). Los operadores de trackers ven, con menos detalle, metadatos de conexión: tu IP, ids opacos e instantes de unión.'

// ---------------------------------------------------------------------------
// Issue #95 — local moderation: peer mute controls (PeerList menu,
// MessageItem author affordance) and the Privacidad-tab mute list. The
// local-only system lines for these actions live in `lib/feed.ts` next to
// the other system-line texts.
// ---------------------------------------------------------------------------

/** PeerList menu item — shown while the peer is not muted. */
export const MUTE_PEER_ACTION = 'Silenciar'

/** PeerList menu item, replacing MUTE_PEER_ACTION once the peer is muted. */
export const UNMUTE_PEER_ACTION = 'Dejar de silenciar'

/** Accessible name of the MessageItem inline affordance on an author row. */
export function muteAuthorAction(nickname: string): string {
  return `Silenciar a @${nickname}`
}

/**
 * ConfirmDialog title/body shown by the PeerList when the peer being muted
 * has an open DM channel: muting also ignores their future DMs (phase 2
 * receive-path enforcement), so the loss is disclosed before acting.
 */
export const MUTE_DM_DIALOG_TITLE = 'Silenciar par'
export const MUTE_DM_DIALOG_BODY =
  'Tienes una conversación directa abierta con este par: al silenciarlo dejarás de ver sus mensajes de la sala y sus mensajes directos se ignorarán. Podrás revertirlo en Ajustes → Privacidad. ¿Continuar?'
export const MUTE_DM_DIALOG_CONFIRM_LABEL = 'Silenciar'

/** Privacidad tab — heading of the local mute list. */
export const MUTED_PEERS_HEADING = 'Pares silenciados'

/**
 * Privacidad tab — what the list does, and why nicknames may be missing
 * (they ride memory-only next to the persisted fingerprints).
 */
export const MUTED_PEERS_HINT =
  'Estos pares no pueden enviarte mensajes de sala ni directos. El apodo solo se muestra si los silenciaste en esta sesión.'

/** Privacidad tab — empty state when no fingerprint is muted. */
export const EMPTY_MUTED_PEERS_TEXT = 'No has silenciado a ningún par.'

/** Accessible name of a mute-list row's unmute button; the identifier is the @nickname or the truncated fingerprint. */
export function unmutePeerAction(identifier: string): string {
  return `Dejar de silenciar a ${identifier}`
}
