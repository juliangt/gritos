/**
 * Exact English wording of the settings validation messages (RF-07) and of
 * the shared P2P disclosure (issue #35) — shared by the components and
 * their tests so the spec strings live in one place. English UI copy per
 * issue #112 (phase 2); the slash-command strings below were already
 * translated in phase 1.
 */

import type { FileFailureReason, SendFileRefusal } from '../../lib/p2p/fileTransfer'

export const TRACKER_ERROR_TEXT = 'Tracker URLs must start with wss://'
export const ICE_ERROR_TEXT = 'ICE servers must start with stun: or turn:'
export const MAX_ROOMS_ERROR_TEXT = 'The active-room limit must be between 1 and 6.'

export const EMPTY_TRACKERS_HINT = 'Empty list: Trystero’s default trackers are used.'
export const EMPTY_ICE_HINT = 'Empty list: Trystero’s default ICE configuration is used.'
export const RECONNECT_NOTE = 'Network changes are applied when the rooms reconnect.'

/**
 * Issue #30 — persistent-storage disclosure shown next to the TURN
 * credential fields while `rememberTurnCredentials` is on. Shared by the
 * Network tab and the Privacy-tab at-rest note.
 */
export const TURN_CREDENTIAL_STORAGE_HINT =
  'TURN credentials are stored unencrypted in this browser.'

/** Issue #30 — shown while «Remember TURN credentials» is off. */
export const TURN_CREDENTIAL_MEMORY_HINT =
  'TURN credentials are kept in memory only and are lost when the tab closes.'

/**
 * Issue #35 — P2P exposure disclosures (onboarding line and Privacy-tab
 * note): direct WebRTC connections reveal the IP to room peers (and, in
 * less detail, to tracker operators); a configured TURN does not hide it
 * (the browser still announces the public address among the ICE candidates).
 */
export const P2P_DISCLOSURE_TEXT =
  'Connections are P2P: whoever shares a room with you can see your IP address.'

export const P2P_IP_EXPOSURE_NOTE =
  'Connections are P2P by design: whoever shares a room with you can see your IP address, and configuring TURN does not hide it from peers (the browser keeps announcing your public address). Tracker operators see connection metadata in less detail: your IP, opaque ids and join instants.'

// ---------------------------------------------------------------------------
// Issue #95 — local moderation: peer mute controls (PeerList menu,
// MessageItem author affordance) and the Privacy-tab mute list. The
// local-only system lines for these actions live in `lib/feed.ts` next to
// the other system-line texts.
// ---------------------------------------------------------------------------

/** PeerList menu item — shown while the peer is not muted. */
export const MUTE_PEER_ACTION = 'Mute'

/** PeerList menu item, replacing MUTE_PEER_ACTION once the peer is muted. */
export const UNMUTE_PEER_ACTION = 'Unmute'

/** Accessible name of the MessageItem inline affordance on an author row. */
export function muteAuthorAction(nickname: string): string {
  return `Mute @${nickname}`
}

/**
 * ConfirmDialog title/body shown by the PeerList when the peer being muted
 * has an open DM channel: muting also ignores their future DMs (phase 2
 * receive-path enforcement), so the loss is disclosed before acting.
 */
export const MUTE_DM_DIALOG_TITLE = 'Mute peer'
export const MUTE_DM_DIALOG_BODY =
  'You have a direct conversation open with this peer: muting them stops their room messages from reaching you and their direct messages will be ignored. You can undo this in Settings → Privacy. Continue?'
export const MUTE_DM_DIALOG_CONFIRM_LABEL = 'Mute'

/** Privacy tab — heading of the local mute list. */
export const MUTED_PEERS_HEADING = 'Muted peers'

/**
 * Privacy tab — what the list does, and why nicknames may be missing
 * (they ride memory-only next to the persisted fingerprints).
 */
export const MUTED_PEERS_HINT =
  'These peers cannot send you room messages or direct messages. The nickname is only shown if you muted them in this session.'

/** Privacy tab — empty state when no fingerprint is muted. */
export const EMPTY_MUTED_PEERS_TEXT = 'You have not muted any peer.'

/** Accessible name of a mute-list row's unmute button; the identifier is the @nickname or the truncated fingerprint. */
export function unmutePeerAction(identifier: string): string {
  return `Unmute ${identifier}`
}

// ---------------------------------------------------------------------------
// Issue #102 — opt-in history gossip: the Privacy-tab consent toggle.
// The label is the issue's exact string; the hint discloses what a
// consented share covers (only on an explicit request, at most the last 50
// chat messages held in memory, nothing persisted, password-room bodies
// re-sealed so only peers with the same password can read them).
// ---------------------------------------------------------------------------

/** Privacy tab — the history-gossip consent toggle (exact issue string). */
export const SHARE_HISTORY_LABEL = 'Share my recent history with late joiners'

/** Privacy tab — what the consent covers, and what never leaves the tab. */
export const SHARE_HISTORY_HINT =
  'Only if you turn it on, whoever joins a room late and explicitly asks for it may receive up to the last 50 chat messages this tab holds in memory. Nothing is stored or sent without a request; in password rooms the bodies travel re-sealed with the room key, so only someone who knows it can read them.'

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the in-feed history-request card (empty room feed):
// one explicit tap asks the room for its recent messages, the other
// dismisses the offer for this join. Repeated asks are rate-limited by the
// manager's per-room budget; nothing is ever asked automatically. The
// recovered separator itself lives in lib/feed.ts, per the #95/#96
// precedent.
// ---------------------------------------------------------------------------

/** Accessible name of the inline card region. */
export const HISTORY_ASK_LABEL = 'Request recent messages'

/** The offer text (exact issue string). */
export const HISTORY_ASK_TEXT = 'Ask the room for the latest messages?'

/** Confirm button: dispatches one hist-req (n = 50). */
export const HISTORY_ASK_CONFIRM = 'Ask'

/** Dismiss button: declines the offer for this join (memory-only). */
export const HISTORY_ASK_DISMISS = 'No'

// ---------------------------------------------------------------------------
// Issue #98 — message reactions (MessageItem quick-pick bar and aggregated
// chips row). All English wording lives here so components and tests share
// the exact texts, like the mute affordance above.
// ---------------------------------------------------------------------------

/** Accessible name and tooltip of the row affordance that opens the quick-pick bar. */
export const REACTION_ADD_LABEL = 'React'

/** Accessible label of the quick-pick bar container (the 7-whitelist row). */
export const REACTION_BAR_LABEL = 'Quick reactions'

/** Accessible label of the aggregated chips row under the bubble. */
export const REACTIONS_ROW_LABEL = 'Reactions'

/** Accessible name and tooltip of one quick-pick button. */
export function reactQuickPickLabel(emo: string): string {
  return `React with ${emo}`
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
export const TTL_SELECT_LABEL = 'Message expiry'

/** Default option: the message lives for the session (no ttl on the wire). */
export const SIN_EXPIRY_LABEL = 'No expiry'

/** Per-message expiry choices offered by the selector. */
export const TTL_30S_LABEL = '30 seconds'
export const TTL_5M_LABEL = '5 minutes'
export const TTL_1H_LABEL = '1 hour'

// ---------------------------------------------------------------------------
// Issue #97 (spec §12.2) — trackerless manual DMs: wizard strings, entry
// points and the DmList marker. All English wording lives here so components
// and tests share the exact spec texts.
// ---------------------------------------------------------------------------

/** Sidebar DM section entry button (visible text and accessible name). */
export const MANUAL_DM_INVITE_ENTRY = '+ invite'

/** Tooltip of the sidebar entry button. */
export const MANUAL_DM_INVITE_ENTRY_TITLE =
  'Start a direct conversation without trackers by exchanging invitations'

/** Tracker-error banner shortcut (visible text and accessible name). */
export const MANUAL_DM_BANNER_SHORTCUT = 'or connect without trackers'

/** DmList marker on manual channels (spec §12.2: «(no room)»). */
export const MANUAL_DM_NO_SALA_MARKER = '(no room)'

/** Tooltip explaining the DmList marker. */
export const MANUAL_DM_NO_SALA_TITLE =
  'Manually created conversation via invitation, without a room'

/** DmList marker on signal-swarm channels (issue #105, spec §12.5: «(global)»). */
export const GLOBAL_DM_MARKER = '(global)'

/** Tooltip explaining the global-DM DmList marker. */
export const GLOBAL_DM_MARKER_TITLE =
  'Direct conversation opened by fingerprint through the global channel (opt-in)'

/** Wizard dialog accessible name. */
export const MANUAL_DM_WIZARD_LABEL = 'Manual connection without trackers'

/** Role-pick intro line. */
export const MANUAL_DM_INTRO_TEXT =
  'Create a direct conversation without trackers: you exchange two invitations over any channel (email, another messenger) and the connection is direct between you.'

/** Role-pick button: role A (creates the invite). */
export const MANUAL_DM_ROLE_INVITE_BUTTON = 'Create invitation'

/** Role-pick button: role B (answers an invite). */
export const MANUAL_DM_ROLE_ANSWER_BUTTON = 'Answer invitation'

/** Exact §12.2 warning shown wherever a blob is displayed for copying. */
export const MANUAL_DM_NETWORK_WARNING = 'The invitation may contain information about your network'

/** Role A — accessible name of the readonly textarea holding the invite blob. */
export const MANUAL_DM_INVITE_BLOB_LABEL = 'Your invitation: copy it and send it to your contact'

/** Role B — accessible name of the paste textarea for A's invite. */
export const MANUAL_DM_PASTE_INVITE_LABEL = 'Paste here the invitation you were sent'

/** Role B — button that validates the pasted invite and produces the answer. */
export const MANUAL_DM_GENERATE_ANSWER_BUTTON = 'Generate answer'

/** Role A — accessible name of the paste textarea for B's answer. */
export const MANUAL_DM_PASTE_ANSWER_LABEL = 'Paste here your contact’s answer'

/** Role A — button that validates the pasted answer and starts connecting. */
export const MANUAL_DM_CONNECT_BUTTON = 'Connect'

/** Copy button next to a displayed blob (clipboard with manual fallback). */
export const MANUAL_DM_COPY_BUTTON = 'Copy'

/** Transient feedback after a successful copy (aria-live). */
export const MANUAL_DM_COPIED_FEEDBACK = 'Copied'

/** Progress: the invite/answer is being generated (ICE gathering, §12.2). */
export const MANUAL_DM_PROGRESS_GENERATING = 'Generating invitation…'

/** Progress: waiting for the WebRTC handshake to finish. */
export const MANUAL_DM_PROGRESS_ESTABLISHING = 'Establishing P2P channel…'

/** Progress/connection status vocabulary (§10.3) reused at wizard connect. */
export const MANUAL_DM_PROGRESS_CONNECTED = 'P2P channel established'

/** Cancel control, available at every wizard state (§12.2). */
export const MANUAL_DM_CANCEL_BUTTON = 'Cancel'

/** Retry control after a guard failure (visible error + retry, RNF-07). */
export const MANUAL_DM_RETRY_BUTTON = 'Start over'

/** Failure text when the link drops after connecting (RF-04 vocabulary). */
export const MANUAL_DM_DROPPED_TEXT = 'The peer has disconnected'

/**
 * Inline errors for a rejected paste, keyed by the engine's ManualBlobError
 * reason (§12.2 validation order). The wizard stays open: the paste can be
 * corrected and retried.
 */
export const MANUAL_BLOB_ERROR_TEXT: Record<
  'encoding' | 'version' | 'role' | 'keys' | 'fingerprint' | 'sdp',
  string
> = {
  encoding: 'The pasted text is not a valid invitation.',
  version: 'The invitation uses an unknown format version.',
  role: 'The pasted text is not of the expected type (invitation or answer).',
  keys: 'The invitation contains invalid keys.',
  fingerprint:
    'The fingerprint does not match the key: the invitation is corrupt or tampered with.',
  sdp: 'The invitation contains an invalid connection description.',
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
  'bad-blob': 'The pasted text is not a valid answer for this invitation.',
  'fingerprint-mismatch': 'The answer’s fingerprint does not match the expected one.',
  'connect-timeout': 'The connection was not established in time. Try again.',
  'illegal-transition': 'The wizard is no longer in the expected state. Start over.',
  'not-connected': 'The channel is not connected.',
  'too-long': 'The message exceeds the 4000-character limit.',
}

// ---------------------------------------------------------------------------
// Issue #99 (English copy per issue #112 phase 1) — slash commands: the /help
// overlay and the /clear confirmation dialog. The command list itself renders
// straight from SLASH_COMMANDS (verb + usage + help live in the parser
// table); only the overlay chrome and the escape-hatch explanation live here.
// Local feed-line wording (command feedback/errors) is in lib/feed.ts, per
// the issue-#95 precedent.
// ---------------------------------------------------------------------------

/** /help overlay — dialog accessible name. */
export const SLASH_HELP_LABEL = 'Slash commands'

/** /help overlay — heading. */
export const SLASH_HELP_TITLE = 'Commands'

/**
 * /help overlay — the escape hatch for literal messages starting with '/',
 * documented here per the issue ("Documented in /help").
 */
export const SLASH_HELP_ESCAPE_HINT =
  'To send a text that starts with "/", prefix a backslash: \\/hello sends "/hello".'

/** /clear — ConfirmDialog title. */
export const CLEAR_FEED_DIALOG_TITLE = 'Clear local history'

/** /clear — ConfirmDialog body: what is (and is not) destroyed. */
export const CLEAR_FEED_DIALOG_BODY =
  'The messages of this room will be cleared from your browser only. The connection is not closed and your peers keep their history. Continue?'

/** /clear — ConfirmDialog confirm button. */
export const CLEAR_FEED_DIALOG_CONFIRM = 'Clear'

/**
 * Slash-candidate popup (issue #99 Phase 3) — accessible name of the
 * composer's inline listbox. The option rows render straight from
 * SLASH_COMMANDS (usage + help), like the /help overlay.
 */
export const SLASH_POPUP_LABEL = 'Command suggestions'

// ---------------------------------------------------------------------------
// Issue #103 phase 4 — P2P file transfer UI: the composer's pre-send dialog
// (attachment button, file picker, encryption notice, recipient scope), the
// consent/progress/result cards rendered from the engine's §12.4 map and the
// honest terminal-state texts. All English wording lives here so components
// and tests share the exact texts, like every other surface.
// ---------------------------------------------------------------------------

/** Composer attachment button (accessible name; visible text is 'Attach'). */
export const FILE_ATTACH_LABEL = 'Attach a file'

/** Pre-send dialog accessible name (the Modal label). */
export const FILE_DIALOG_LABEL = 'Send a file'

/** Visible text and accessible name of the styled file-picker affordance. */
export const FILE_PICK_LABEL = 'Choose a file…'

/** Recipient scope selector (room mode) accessible name. */
export const FILE_RECIPIENT_LABEL = 'Recipient'

/** Recipient scope in DM mode: a fixed line (the peer cannot change). */
export function fileRecipientDmText(peerNick: string): string {
  return `Recipient: ${peerNick}`
}

/** Pre-send encryption notice for a password room (room key, §9.3). */
export const FILE_ENC_NOTICE_ROOM =
  'It will be encrypted with the room key: only someone with the password will be able to read it.'

/** Pre-send encryption notice for a DM (DM key v2, §9.2; always sealed). */
export const FILE_ENC_NOTICE_DM = 'It will be encrypted end-to-end with this conversation’s DM key.'

/** §12.4 pre-send warning for public rooms (the exact DTLS-only disclosure). */
export const FILE_ENC_WARNING_PUBLIC =
  'Public room: no E2E encryption — DTLS only. The content does not travel end-to-end encrypted.'

/**
 * Card encryption line for a sealed transfer. The wire cannot say whether
 * the key is the room's or the DM's (§12.4's one ambiguity — GCM resolves it
 * per chunk), so incoming cards stay honest with the generic line.
 */
export const FILE_ENC_STATE_SEALED = 'End-to-end encrypted.'

/** Card encryption line for a cleartext transfer (public rooms, §12.4). */
export const FILE_ENC_STATE_CLEAR = 'No E2E encryption — DTLS only.'

/** Dialog buttons. */
export const FILE_SEND_BUTTON = 'Send file'
export const FILE_CANCEL_BUTTON = 'Cancel'

/** Room mode with no connected peers: there is nobody to address the offer to. */
export const FILE_NO_PEERS_TEXT = 'No connected peers: there is no recipient for the offer.'

/** Display-only placeholder when the File carries no mime (legitimate, §12.4). */
export const FILE_UNKNOWN_MIME_TEXT = 'unknown type'

/**
 * Inline refusals for the pre-send dialog, keyed by the engine's
 * SendFileRefusal (phase 3): every local rejection surfaces with its own
 * honest line before anything hits the wire.
 */
export const FILE_REFUSAL_TEXT: Record<SendFileRefusal, string> = {
  'unknown-room': 'The room is no longer connected: the file cannot be sent.',
  'not-connected': 'No connection: the offer could not be sent.',
  'peer-not-in-room': 'The recipient is not connected to the room.',
  'invalid-file': 'The file is not valid.',
  'file-too-big': 'The file exceeds the 20 MB limit.',
  'name-required': 'The file name is not valid.',
  'concurrency-cap': 'The recipient already has 3 transfers in progress: wait for one to finish.',
  'dm-key-unavailable': 'No DM key available: the file never travels unencrypted.',
  'key-resolution-failed': 'The encryption key could not be resolved: nothing was sent.',
}

/** Transfer cards area accessible name (one region per room/DM view). */
export const FILE_CARDS_REGION_LABEL = 'File transfers'

/** One card's accessible name, built from the file name and the peer nick. */
export function fileCardLabel(fileName: string, peerNick: string | null): string {
  return peerNick === null ? `Transfer of ${fileName}` : `Transfer of ${fileName} with ${peerNick}`
}

/** Consent card (incoming offer): the question, with the sender's nick. */
export function fileOfferText(peerNick: string): string {
  return `${peerNick} wants to send you a file:`
}

/** Sender-side pending offer line (waiting for the peer's consent). */
export const FILE_OFFER_PENDING_TEXT = 'Offer sent: waiting for the peer to accept it.'

/** In-flight lines, per direction. */
export const FILE_PROGRESS_SENDING_TEXT = 'Sending…'
export const FILE_PROGRESS_RECEIVING_TEXT = 'Receiving…'

/** Progress bar accessible name (role="progressbar" on the card). */
export const FILE_PROGRESS_LABEL = 'Transfer progress'

/** Done card text. */
export const FILE_DONE_TEXT = 'Completed'

/** Terminal texts: an explicitly declined offer and a cancelled transfer. */
export const FILE_REJECTED_TEXT = 'Declined'
export const FILE_ABORTED_TEXT = 'Cancelled'

/** Failed-transfer line per the engine's FileFailureReason (honest states). */
export const FILE_FAILURE_TEXT: Record<FileFailureReason, string> = {
  stall: 'Failed: the transfer stalled.',
  'peer-drop': 'Failed: the peer has disconnected.',
  'room-gone': 'Failed: the room has closed.',
  'size-limit': 'Failed: the file exceeds the allowed size.',
  'bad-frame': 'Failed: corrupt data was received.',
  crypto: 'Failed: the content could not be decrypted.',
  completeness: 'Failed: the file arrived incomplete.',
  'identity-regenerated': 'Failed: the session identity was regenerated.',
}

/** Consent card actions (before any byte flows, §12.4). */
export const FILE_ACCEPT_BUTTON = 'Accept'
export const FILE_DECLINE_BUTTON = 'Decline'

/** Download affordance on a done, non-image transfer (receiver side). */
export const FILE_DOWNLOAD_BUTTON = 'Download'

/** Dismiss control of a terminal card; revokes the object URL (§12.4). */
export const FILE_DISMISS_BUTTON = 'Dismiss'

// ---------------------------------------------------------------------------
// Issue #100 — QR invite (ChatHeader 'QR' button → popover over the share
// affordance). The QR encodes exactly buildRoomLink's output (room name
// only, never the password — RF-05); all wording lives here so the
// components and tests share the exact texts.
// ---------------------------------------------------------------------------

/** Header entry button: accessible name and tooltip (visible text is 'QR'). */
export const QR_BUTTON_LABEL = 'Room QR code'

/** Popover dialog accessible name (Modal label). */
export const QR_DIALOG_LABEL = 'Room QR code'

/** Canvas role="img" label: describes what the QR encodes. */
export function qrCanvasLabel(roomName: string): string {
  return `QR code with the link of room ${roomName}`
}

/** Button that downloads the QR as a PNG file. */
export const QR_DOWNLOAD_BUTTON = 'Download PNG'

/** Same-deployment disclosure (issue #100 Risks): a QR from another install joins nothing. */
export const QR_SAME_INSTALL_NOTE = 'The QR links to this same installation.'

// ---------------------------------------------------------------------------
// Issue #104 phase 4 — the service-worker update toast (App-level, bottom
// corner): a waiting worker means a deployed new version is ready behind
// this page, and «Reload» is the reload that swaps it in. Component-local
// state only: dismissing hides the toast for the session (a NEWER waiting
// worker notifies afresh), nothing persists, and the toast never implies
// push — it is a local same-origin artifact (§10.9).
// ---------------------------------------------------------------------------

/** The toast text: a new version waits behind this page. */
export const UPDATE_AVAILABLE_TEXT = 'New version available'

/** The action: reload so the waiting worker activates (the swap). */
export const UPDATE_RELOAD_BUTTON = 'Reload'

/** Accessible name and tooltip of the dismiss control (session-only). */
export const UPDATE_TOAST_DISMISS_LABEL = 'Dismiss the notice'

// ---------------------------------------------------------------------------
// Issue #105 phase 3 (spec §12.5) — the global-DM contact flow: the
// Privacy opt-in toggle, the DmList «+ contact» entry, the «My contact»
// share screen (fingerprint + QR via the #100 machinery) and the «Contact
// by fingerprint» knock flow, plus the inbound consent card. All English
// wording lives here so components and tests share the exact texts.
// ---------------------------------------------------------------------------

/** Privacy tab — the global-DM opt-in toggle (Settings → Privacy). */
export const GLOBAL_DM_TOGGLE_LABEL = 'Global DM channel'

/**
 * Privacy tab — the honest §9.5 disclosure under the toggle: what joining
 * exposes, what the off-by-default mitigation means, and that leaving is
 * instant. Also the hint that explains where the «+ contact» entries come
 * from while the setting is off.
 */
export const GLOBAL_DM_TOGGLE_HINT =
  'Opt-in: turning it on puts you in a public, well-known swarm where every peer with the setting active can see your IP, your fingerprint and your nickname, and knock you by fingerprint to open a DM with you. Off by default; turning it off leaves the swarm instantly and closes its channels. The sidebar’s ‘+ contact’ entries only appear while the channel is active.'

/** Sidebar DM section entry (visible text and accessible name), sibling of «+ invite». */
export const CONTACT_ENTRY = '+ contact'

/** Tooltip of the sidebar entry button. */
export const CONTACT_ENTRY_TITLE =
  'Share your fingerprint (‘My contact’) or knock another peer by fingerprint (‘Contact by fingerprint’)'

/** Contact dialog accessible name (the Modal label). */
export const CONTACT_DIALOG_LABEL = 'Contact by fingerprint'

/** Pick-screen intro line (the manual-wizard intro precedent). */
export const CONTACT_INTRO_TEXT =
  'The global channel connects two fingerprints without a shared room: both sides must have it enabled in Settings → Privacy. It carries no messages: only knocks, and the conversation starts when the other side accepts.'

/** Pick-screen button: share YOUR fingerprint (copy + QR deep link). */
export const CONTACT_SHARE_BUTTON = 'My contact'

/** Pick-screen button: knock someone by pasted fingerprint. */
export const CONTACT_KNOCK_ENTRY_BUTTON = 'Contact by fingerprint'

// Share screen («My contact»).

/** Accessible name of the readonly field holding the own fingerprint. */
export const CONTACT_FP_LABEL = 'Your identity fingerprint: copy it and send it to your contact'

/** Copy button next to the fingerprint (clipboard with manual fallback). */
export const CONTACT_COPY_BUTTON = 'Copy'

/** Transient feedback after a successful copy (aria-live). */
export const CONTACT_COPIED_FEEDBACK = 'Copied'

/** Canvas role="img" label: describes what the QR encodes. */
export const CONTACT_QR_CANVAS_LABEL = 'QR code with your contact link'

/** Button that downloads the contact QR as a PNG file (the #100 wording). */
export const CONTACT_DOWNLOAD_BUTTON = 'Download PNG'

/** Same-deployment disclosure (the #100 note reused for the contact QR). */
export const CONTACT_QR_SAME_INSTALL_NOTE = QR_SAME_INSTALL_NOTE

// Knock screen («Contact by fingerprint»).

/** Intro line: what a knock is and what it needs (presence on the swarm). */
export const CONTACT_KNOCK_INTRO_TEXT =
  'Paste your contact’s fingerprint: if they are present on the global channel they will receive your knock and decide whether to accept. While you wait, you can add an optional note.'

/** Accessible name of the paste textarea for the peer's fingerprint. */
export const CONTACT_KNOCK_PASTE_LABEL = 'Paste here your contact’s fingerprint'

/** Accessible name of the optional note textarea (capped at 140 chars). */
export const CONTACT_KNOCK_NOTE_LABEL = 'Optional note for your knock'

/** Character counter of the note field (aria-live). */
export function contactNoteCounter(length: number): string {
  return `${length}/140`
}

/** Button that validates the pasted fingerprint and knocks. */
export const CONTACT_KNOCK_SEND_BUTTON = 'Send knock'

/** Progress: the knock is out, waiting for the peer's consent (live region). */
export const CONTACT_KNOCK_WAITING_TEXT = 'Knock sent: waiting for an answer…'

/** Inline terminal state when the peer answered knock-ack(false). */
export const CONTACT_KNOCK_REJECTED_TEXT = 'Declined: the peer has not accepted your contact.'

/** Inline error for a paste that is not a fingerprint (the local form check). */
export const CONTACT_FP_INVALID_TEXT =
  'That is not a valid fingerprint: it must be 8 groups of 4 hexadecimal characters.'

/** Inline errors for a typed KnockError rejection, keyed by its reason. */
export const KNOCK_ERROR_TEXT: Record<'signal-off' | 'peer-not-present' | 'invalid-knock', string> =
  {
    'signal-off': 'The global channel is disabled: enable it in Settings → Privacy.',
    'peer-not-present': 'That fingerprint is not present on the global channel right now.',
    'invalid-knock': 'The knock is not valid: check the fingerprint and the note.',
  }

/** Back control to the pick screen (both screens keep the dialog open). */
export const CONTACT_BACK_BUTTON = 'Back'

/** Cancel control closing the dialog at every state (the wizard precedent). */
export const CONTACT_CANCEL_BUTTON = 'Cancel'

// Inbound consent card (the «door» rendered wherever the user is).

/** The card's question line (the exact §12.5 shape, with the sender's nick). */
export function knockConsentText(nick: string): string {
  return `@${nick} wants to open a DM with you`
}

/** Accessible name of one consent card region. */
export function knockCardLabel(nick: string): string {
  return `Contact request from @${nick}`
}

/** Accessible name of the consent-cards strip (one region, N cards). */
export const KNOCK_CARDS_REGION_LABEL = 'Contact requests'

/** Prefix of the optional note line rendered on the card. */
export const KNOCK_NOTE_PREFIX = 'Note: '

/** Consent card actions. «Mute» rejects AND mutes (issue #95). */
export const KNOCK_ACCEPT_BUTTON = 'Accept'
export const KNOCK_REJECT_BUTTON = 'Decline'
export const KNOCK_MUTE_BUTTON = 'Mute'
