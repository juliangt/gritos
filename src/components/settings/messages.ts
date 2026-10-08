/**
 * Exact Spanish wording of the settings validation messages (RF-07) and of
 * the shared P2P disclosure (issue #35) — shared by the components and
 * their tests so the spec strings live in one place.
 */

import type { FileFailureReason, SendFileRefusal } from '../../lib/p2p/fileTransfer'

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

// ---------------------------------------------------------------------------
// Issue #102 — opt-in history gossip: the Privacidad-tab consent toggle.
// The label is the issue's exact string; the hint discloses what a
// consented share covers (only on an explicit request, at most the last 50
// chat messages held in memory, nothing persisted, password-room bodies
// re-sealed so only peers with the same password can read them).
// ---------------------------------------------------------------------------

/** Privacidad tab — the history-gossip consent toggle (exact issue string). */
export const SHARE_HISTORY_LABEL = 'Compartir mi historial reciente con quien entra tarde'

/** Privacidad tab — what the consent covers, and what never leaves the tab. */
export const SHARE_HISTORY_HINT =
  'Solo si lo activas, quien se incorpore tarde a una sala y lo pida expresamente podrá recibir hasta los últimos 50 mensajes de chat que esta pestaña tenga en memoria. Nada se guarda ni se envía sin petición; en salas con contraseña los cuerpos viajan re-cifrados con la clave de la sala, así que solo quien la conozca puede leerlos.'

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the in-feed history-request card (empty room feed):
// one explicit tap asks the sala for its recent messages, the other
// dismisses the offer for this join. Repeated asks are rate-limited by the
// manager's per-room budget; nothing is ever asked automatically. The
// recovered separator itself lives in lib/feed.ts, per the #95/#96
// precedent.
// ---------------------------------------------------------------------------

/** Accessible name of the inline card region. */
export const HISTORY_ASK_LABEL = 'Pedir mensajes recientes'

/** The offer text (exact issue string). */
export const HISTORY_ASK_TEXT = '¿Pedir los últimos mensajes a la sala?'

/** Confirm button: dispatches one hist-req (n = 50). */
export const HISTORY_ASK_CONFIRM = 'Pedir'

/** Dismiss button: declines the offer for this join (memory-only). */
export const HISTORY_ASK_DISMISS = 'No'

// ---------------------------------------------------------------------------
// Issue #98 — message reactions (MessageItem quick-pick bar and aggregated
// chips row). All Spanish wording lives here so components and tests share
// the exact texts, like the mute affordance above.
// ---------------------------------------------------------------------------

/** Accessible name and tooltip of the row affordance that opens the quick-pick bar. */
export const REACTION_ADD_LABEL = 'Reaccionar'

/** Accessible label of the quick-pick bar container (the 7-whitelist row). */
export const REACTION_BAR_LABEL = 'Reacciones rápidas'

/** Accessible label of the aggregated chips row under the bubble. */
export const REACTIONS_ROW_LABEL = 'Reacciones'

/** Accessible name and tooltip of one quick-pick button. */
export function reactQuickPickLabel(emo: string): string {
  return `Reaccionar con ${emo}`
}

/** Tooltip of an aggregated chip: the reactor nicknames, comma-separated. */
export function reactionChipTooltip(nicknames: readonly string[]): string {
  return nicknames.join(', ')
}

// ---------------------------------------------------------------------------
// Issue #96 — composer TTL selector (ChatInput, room and DM modes). Only the
// wording lives here: the selection itself is memory-only component state and
// is never persisted.
// ---------------------------------------------------------------------------

/** Accessible name of the TTL selector. */
export const TTL_SELECT_LABEL = 'Caducidad del mensaje'

/** Default option: the message lives for the session (no ttl on the wire). */
export const SIN_EXPIRY_LABEL = 'Sin caducidad'

/** Per-message expiry choices offered by the selector. */
export const TTL_30S_LABEL = '30 segundos'
export const TTL_5M_LABEL = '5 minutos'
export const TTL_1H_LABEL = '1 hora'

// ---------------------------------------------------------------------------
// Issue #97 (spec §12.2) — trackerless manual DMs: wizard strings, entry
// points and the DmList marker. All Spanish wording lives here so components
// and tests share the exact spec texts.
// ---------------------------------------------------------------------------

/** Sidebar DM section entry button (visible text and accessible name). */
export const MANUAL_DM_INVITE_ENTRY = '+ invitación'

/** Tooltip of the sidebar entry button. */
export const MANUAL_DM_INVITE_ENTRY_TITLE =
  'Iniciar una conversación directa sin trackers, intercambiando invitaciones'

/** Tracker-error banner shortcut (visible text and accessible name). */
export const MANUAL_DM_BANNER_SHORTCUT = 'o conéctate sin trackers'

/** DmList marker on manual channels (spec §12.2: «(sin sala)»). */
export const MANUAL_DM_NO_SALA_MARKER = '(sin sala)'

/** Tooltip explaining the DmList marker. */
export const MANUAL_DM_NO_SALA_TITLE = 'Conversación manual creada mediante invitación, sin sala'

/** Wizard dialog accessible name. */
export const MANUAL_DM_WIZARD_LABEL = 'Conexión manual sin trackers'

/** Role-pick intro line. */
export const MANUAL_DM_INTRO_TEXT =
  'Crea una conversación directa sin trackers: intercambiáis dos invitaciones por cualquier canal (correo, otro mensajero) y la conexión es directa entre vosotros.'

/** Role-pick button: role A (creates the invite). */
export const MANUAL_DM_ROLE_INVITE_BUTTON = 'Crear invitación'

/** Role-pick button: role B (answers an invite). */
export const MANUAL_DM_ROLE_ANSWER_BUTTON = 'Responder invitación'

/** Exact §12.2 warning shown wherever a blob is displayed for copying. */
export const MANUAL_DM_NETWORK_WARNING = 'La invitación puede contener información de tu red'

/** Role A — accessible name of the readonly textarea holding the invite blob. */
export const MANUAL_DM_INVITE_BLOB_LABEL = 'Tu invitación: cópiala y envíasela a tu interlocutor'

/** Role B — accessible name of the paste textarea for A's invite. */
export const MANUAL_DM_PASTE_INVITE_LABEL = 'Pega aquí la invitación que te han enviado'

/** Role B — button that validates the pasted invite and produces the answer. */
export const MANUAL_DM_GENERATE_ANSWER_BUTTON = 'Generar respuesta'

/** Role A — accessible name of the paste textarea for B's answer. */
export const MANUAL_DM_PASTE_ANSWER_LABEL = 'Pega aquí la respuesta de tu interlocutor'

/** Role A — button that validates the pasted answer and starts connecting. */
export const MANUAL_DM_CONNECT_BUTTON = 'Conectar'

/** Copy button next to a displayed blob (clipboard with manual fallback). */
export const MANUAL_DM_COPY_BUTTON = 'Copiar'

/** Transient feedback after a successful copy (aria-live). */
export const MANUAL_DM_COPIED_FEEDBACK = 'Copiado'

/** Progress: the invite/answer is being generated (ICE gathering, §12.2). */
export const MANUAL_DM_PROGRESS_GENERATING = 'Generando invitación…'

/** Progress: waiting for the WebRTC handshake to finish. */
export const MANUAL_DM_PROGRESS_ESTABLISHING = 'Estableciendo canal P2P…'

/** Progress/connection status vocabulary (§10.3) reused at wizard connect. */
export const MANUAL_DM_PROGRESS_CONNECTED = 'Canal P2P establecido'

/** Cancel control, available at every wizard state (§12.2). */
export const MANUAL_DM_CANCEL_BUTTON = 'Cancelar'

/** Retry control after a guard failure (visible error + retry, RNF-07). */
export const MANUAL_DM_RETRY_BUTTON = 'Volver a empezar'

/** Failure text when the link drops after connecting (RF-04 vocabulary). */
export const MANUAL_DM_DROPPED_TEXT = 'El par se ha desconectado'

/**
 * Inline errors for a rejected paste, keyed by the engine's ManualBlobError
 * reason (§12.2 validation order). The wizard stays open: the paste can be
 * corrected and retried.
 */
export const MANUAL_BLOB_ERROR_TEXT: Record<
  'encoding' | 'version' | 'role' | 'keys' | 'fingerprint' | 'sdp',
  string
> = {
  encoding: 'El texto pegado no es una invitación válida.',
  version: 'La invitación usa una versión desconocida de formato.',
  role: 'El texto pegado no es del tipo esperado (invitación o respuesta).',
  keys: 'La invitación contiene claves inválidas.',
  fingerprint: 'La huella no coincide con la clave: la invitación está corrupta o manipulada.',
  sdp: 'La invitación contiene una descripción de conexión inválida.',
}

/** Inline errors for engine rejections beyond the blob parse. */
export const MANUAL_PEER_ERROR_TEXT: Partial<
  Record<
    | 'bad-blob'
    | 'fingerprint-mismatch'
    | 'connect-timeout'
    | 'illegal-transition'
    | 'not-connected'
    | 'too-long',
    string
  >
> = {
  'bad-blob': 'El texto pegado no es una respuesta válida para esta invitación.',
  'fingerprint-mismatch': 'La huella de la respuesta no coincide con la esperada.',
  'connect-timeout': 'La conexión no se estableció a tiempo. Vuelve a intentarlo.',
  'illegal-transition': 'El asistente ya no está en el estado esperado. Vuelve a empezar.',
  'not-connected': 'El canal no está conectado.',
  'too-long': 'El mensaje supera el límite de 4000 caracteres.',
}

// ---------------------------------------------------------------------------
// Issue #99 — slash commands: the /ayuda overlay and the /limpiar
// confirmation dialog. The command list itself renders straight from
// SLASH_COMMANDS (verb + usage + help live in the parser table); only the
// overlay chrome and the escape-hatch explanation live here. Local feed-line
// wording (command feedback/errors) is in lib/feed.ts, per the issue-#95
// precedent.
// ---------------------------------------------------------------------------

/** /ayuda overlay — dialog accessible name. */
export const SLASH_HELP_LABEL = 'Comandos de barra'

/** /ayuda overlay — heading. */
export const SLASH_HELP_TITLE = 'Comandos'

/**
 * /ayuda overlay — the escape hatch for literal messages starting with '/',
 * documented here per the issue ("Documented in /ayuda").
 */
export const SLASH_HELP_ESCAPE_HINT =
  'Para enviar un texto que empiece por «/», antepón una barra invertida: \\/hola envía «/hola».'

/** /limpiar — ConfirmDialog title. */
export const CLEAR_FEED_DIALOG_TITLE = 'Borrar el historial local'

/** /limpiar — ConfirmDialog body: what is (and is not) destroyed. */
export const CLEAR_FEED_DIALOG_BODY =
  'Se borrarán los mensajes de esta sala solo en tu navegador. La conexión no se cierra y tus pares conservan su historial. ¿Continuar?'

/** /limpiar — ConfirmDialog confirm button. */
export const CLEAR_FEED_DIALOG_CONFIRM = 'Borrar'

/**
 * Slash-candidate popup (issue #99 Phase 3) — accessible name of the
 * composer's inline listbox. The option rows render straight from
 * SLASH_COMMANDS (usage + help), like the /ayuda overlay.
 */
export const SLASH_POPUP_LABEL = 'Sugerencias de comandos'

// ---------------------------------------------------------------------------
// Issue #103 phase 4 — P2P file transfer UI: the composer's pre-send dialog
// (attachment button, file picker, encryption notice, recipient scope), the
// consent/progress/result cards rendered from the engine's §12.4 map and the
// honest terminal-state texts. All Spanish wording lives here so components
// and tests share the exact texts, like every other surface.
// ---------------------------------------------------------------------------

/** Composer attachment button (accessible name; visible text is 'Adjuntar'). */
export const FILE_ATTACH_LABEL = 'Adjuntar archivo'

/** Pre-send dialog accessible name (the Modal label). */
export const FILE_DIALOG_LABEL = 'Enviar un archivo'

/** Visible text and accessible name of the styled file-picker affordance. */
export const FILE_PICK_LABEL = 'Elegir archivo…'

/** Recipient scope selector (room mode) accessible name. */
export const FILE_RECIPIENT_LABEL = 'Destinatario'

/** Recipient scope in DM mode: a fixed line (the peer cannot change). */
export function fileRecipientDmText(peerNick: string): string {
  return `Destinatario: ${peerNick}`
}

/** Pre-send encryption notice for a password room (room key, §9.3). */
export const FILE_ENC_NOTICE_ROOM =
  'Se cifrará con la clave de la sala: solo quien tenga la contraseña podrá leerlo.'

/** Pre-send encryption notice for a DM (DM key v2, §9.2; always sealed). */
export const FILE_ENC_NOTICE_DM =
  'Se cifrará de extremo a extremo con la clave DM de esta conversación.'

/** §12.4 pre-send warning for public rooms (the exact DTLS-only disclosure). */
export const FILE_ENC_WARNING_PUBLIC =
  'Sala pública: sin cifrado E2E — solo DTLS. El contenido no viaja cifrado de extremo a extremo.'

/**
 * Card encryption line for a sealed transfer. The wire cannot say whether
 * the key is the room's or the DM's (§12.4's one ambiguity — GCM resolves it
 * per chunk), so incoming cards stay honest with the generic line.
 */
export const FILE_ENC_STATE_SEALED = 'Cifrado de extremo a extremo.'

/** Card encryption line for a cleartext transfer (public rooms, §12.4). */
export const FILE_ENC_STATE_CLEAR = 'Sin cifrado E2E — solo DTLS.'

/** Dialog buttons. */
export const FILE_SEND_BUTTON = 'Enviar archivo'
export const FILE_CANCEL_BUTTON = 'Cancelar'

/** Room mode with no connected peers: there is nobody to address the offer to. */
export const FILE_NO_PEERS_TEXT = 'Sin pares conectados: no hay destinatario para la oferta.'

/** Display-only placeholder when the File carries no mime (legitimate, §12.4). */
export const FILE_UNKNOWN_MIME_TEXT = 'tipo desconocido'

/**
 * Inline refusals for the pre-send dialog, keyed by the engine's
 * SendFileRefusal (phase 3): every local rejection surfaces with its own
 * honest line before anything hits the wire.
 */
export const FILE_REFUSAL_TEXT: Record<SendFileRefusal, string> = {
  'unknown-room': 'La sala ya no está conectada: no se puede enviar.',
  'not-connected': 'Sin conexión: la oferta no se ha podido enviar.',
  'peer-not-in-room': 'El destinatario no está conectado a la sala.',
  'invalid-file': 'El archivo no es válido.',
  'file-too-big': 'El archivo supera el límite de 20 MB.',
  'name-required': 'El nombre del archivo no es válido.',
  'concurrency-cap':
    'El destinatario ya tiene 3 transferencias activas: espera a que termine alguna.',
  'dm-key-unavailable': 'No hay clave DM disponible: el archivo nunca viaja sin cifrar.',
  'key-resolution-failed': 'No se pudo resolver la clave de cifrado: no se ha enviado.',
}

/** Transfer cards area accessible name (one region per room/DM view). */
export const FILE_CARDS_REGION_LABEL = 'Transferencias de archivos'

/** One card's accessible name, built from the file name and the peer nick. */
export function fileCardLabel(fileName: string, peerNick: string | null): string {
  return peerNick === null
    ? `Transferencia de ${fileName}`
    : `Transferencia de ${fileName} con ${peerNick}`
}

/** Consent card (incoming offer): the question, with the sender's nick. */
export function fileOfferText(peerNick: string): string {
  return `${peerNick} quiere enviarte un archivo:`
}

/** Sender-side pending offer line (waiting for the peer's consent). */
export const FILE_OFFER_PENDING_TEXT = 'Oferta enviada: esperando a que el par la acepte.'

/** In-flight lines, per direction. */
export const FILE_PROGRESS_SENDING_TEXT = 'Enviando…'
export const FILE_PROGRESS_RECEIVING_TEXT = 'Recibiendo…'

/** Progress bar accessible name (role="progressbar" on the card). */
export const FILE_PROGRESS_LABEL = 'Progreso de la transferencia'

/** Done card text. */
export const FILE_DONE_TEXT = 'Completado'

/** Terminal texts: an explicitly declined offer and a cancelled transfer. */
export const FILE_REJECTED_TEXT = 'Rechazado'
export const FILE_ABORTED_TEXT = 'Cancelado'

/** Failed-transfer line per the engine's FileFailureReason (honest states). */
export const FILE_FAILURE_TEXT: Record<FileFailureReason, string> = {
  stall: 'Falló: la transferencia se estancó.',
  'peer-drop': 'Falló: el par se ha desconectado.',
  'room-gone': 'Falló: la sala se ha cerrado.',
  'size-limit': 'Falló: el archivo excede el tamaño permitido.',
  'bad-frame': 'Falló: se recibieron datos corruptos.',
  crypto: 'Falló: no se pudo descifrar el contenido.',
  completeness: 'Falló: el archivo llegó incompleto.',
  'identity-regenerated': 'Falló: la identidad de la sesión se regeneró.',
}

/** Consent card actions (before any byte flows, §12.4). */
export const FILE_ACCEPT_BUTTON = 'Aceptar'
export const FILE_DECLINE_BUTTON = 'Declinar'

/** Download affordance on a done, non-image transfer (receiver side). */
export const FILE_DOWNLOAD_BUTTON = 'Descargar'

/** Dismiss control of a terminal card; revokes the object URL (§12.4). */
export const FILE_DISMISS_BUTTON = 'Descartar'

// ---------------------------------------------------------------------------
// Issue #100 — QR invite (ChatHeader 'QR' button → popover over the share
// affordance). The QR encodes exactly buildRoomLink's output (room name
// only, never the password — RF-05); all wording lives here so the
// components and tests share the exact texts.
// ---------------------------------------------------------------------------

/** Header entry button: accessible name and tooltip (visible text is 'QR'). */
export const QR_BUTTON_LABEL = 'Código QR de la sala'

/** Popover dialog accessible name (Modal label). */
export const QR_DIALOG_LABEL = 'Código QR de la sala'

/** Canvas role="img" label: describes what the QR encodes. */
export function qrCanvasLabel(roomName: string): string {
  return `Código QR con el enlace de la sala ${roomName}`
}

/** Button that downloads the QR as a PNG file. */
export const QR_DOWNLOAD_BUTTON = 'Descargar PNG'

/** Same-deployment disclosure (issue #100 Risks): a QR from another install joins nothing. */
export const QR_SAME_INSTALL_NOTE = 'El QR enlaza a esta misma instalación.'
