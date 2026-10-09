/**
 * Exact wording of the settings validation messages (RF-07), the shared P2P
 * disclosure (issue #35) and every other centralized settings/wizard/files/
 * QR/contact/knock string — shared by the components and their tests.
 *
 * Issue #119 phase 2 — i18n: every string lives in `src/i18n/en.ts` under
 * its surface namespace (`settings.*`, `common.*`, `wizard.*`, `files.*`,
 * `qr.*`, `contact.*`, `slash.*`, `dm.*`); this module is now an adapter:
 *
 * - Builders (the `*Label`/`*Text` functions) keep their name and signature
 *   and resolve through `t()` on EVERY call — locale-live.
 * - The reason-keyed maps (`MANUAL_BLOB_ERROR_TEXT` & co.) became
 *   `manualBlobErrorText(reason)`-style lookup functions (same approach for
 *   all of them): the body is `t(keyFor[reason])`, so call sites stay
 *   locale-live and the old `MAP[reason]` reads become `fn(reason)` calls.
 * - Plain-string constants survive as LEGACY SHIMS for the test suites that
 *   import them: `export const X = t('key')`, resolved ONCE at module load
 *   — NOT locale-live. Component consumers must use `t('key')` (via `useT`
 *   in React components) instead; a shim with no remaining test importer is
 *   deleted.
 */

import { t, type TranslationKey } from '../../i18n/index'
import type { FileFailureReason, SendFileRefusal } from '../../lib/p2p/fileTransfer'

// ---------------------------------------------------------------------------
// Network tab — validation and hints (RF-07).
// ---------------------------------------------------------------------------

/** Legacy shim (module-load resolution; see the module docblock). */
export const TRACKER_ERROR_TEXT = t('settings.trackerError')
/** Legacy shim (module-load resolution; see the module docblock). */
export const ICE_ERROR_TEXT = t('settings.iceError')
/** Legacy shim (module-load resolution; see the module docblock). */
export const MAX_ROOMS_ERROR_TEXT = t('settings.maxRoomsError')

/**
 * Issue #30 — persistent-storage disclosure shown next to the TURN
 * credential fields while `rememberTurnCredentials` is on. Shared by the
 * Network tab and the Privacy-tab at-rest note.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const TURN_CREDENTIAL_STORAGE_HINT = t('settings.turnCredentialStorageHint')

/**
 * Issue #30 — shown while «Remember TURN credentials» is off.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const TURN_CREDENTIAL_MEMORY_HINT = t('settings.turnCredentialMemoryHint')

/**
 * Issue #35 — P2P exposure disclosure (onboarding line): direct WebRTC
 * connections reveal the IP to room peers (and, in less detail, to tracker
 * operators); a configured TURN does not hide it (the browser still
 * announces the public address among the ICE candidates).
 * Legacy shim: still imported by OnboardingScreen (untouched until phase 3)
 * and tests/onboarding.test.ts.
 */
export const P2P_DISCLOSURE_TEXT = t('settings.p2pDisclosure')

/**
 * Issue #35 — the Privacy-tab long-form of the exposure note (see above).
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const P2P_IP_EXPOSURE_NOTE = t('settings.p2pIpExposureNote')

// ---------------------------------------------------------------------------
// Issue #95 — local moderation: peer mute controls (PeerList menu,
// MessageItem author affordance) and the Privacy-tab mute list. The
// local-only system lines for these actions live in `lib/feed.ts` next to
// the other system-line texts.
// ---------------------------------------------------------------------------

/**
 * Accessible name of the MessageItem inline affordance on an author row.
 * Locale-live: resolves through `t()` on every call.
 */
export function muteAuthorAction(nickname: string): string {
  return t('settings.muteAuthorAction', { nickname })
}

/**
 * Accessible name of a mute-list row's unmute button; the identifier is the
 * @nickname or the truncated fingerprint. Locale-live.
 */
export function unmutePeerAction(identifier: string): string {
  return t('settings.unmutePeerAction', { identifier })
}

// ---------------------------------------------------------------------------
// Issue #102 — opt-in history gossip: the Privacy-tab consent toggle. The
// label is the issue's exact string; the hint discloses what a consented
// share covers (only on an explicit request, at most the last 50 chat
// messages held in memory, nothing persisted, password-room bodies
// re-sealed so only peers with the same password can read them).
// ---------------------------------------------------------------------------

/** Privacy tab — the history-gossip consent toggle (exact issue string).
 * Legacy shim (module-load resolution; see the module docblock). */
export const SHARE_HISTORY_LABEL = t('settings.shareHistoryLabel')

/** Privacy tab — what the consent covers, and what never leaves the tab.
 * Legacy shim (module-load resolution; see the module docblock). */
export const SHARE_HISTORY_HINT = t('settings.shareHistoryHint')

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the in-feed history-request card (empty room feed):
// one explicit tap asks the room for its recent messages, the other
// dismisses the offer for this join. Repeated asks are rate-limited by the
// manager's per-room budget; nothing is ever asked automatically. The
// recovered separator itself lives in lib/feed.ts, per the #95/#96
// precedent.
// ---------------------------------------------------------------------------

/** The offer text (exact issue string).
 * Legacy shim (module-load resolution; see the module docblock). */
export const HISTORY_ASK_TEXT = t('settings.historyAskText')

// ---------------------------------------------------------------------------
// Issue #96 — composer TTL selector (ChatInput, room and DM modes). Only the
// wording lives in i18n (`common.ttl*`); the selection itself is memory-only
// component state and is never persisted. The shims below exist for the
// test suites; ChatInput resolves the keys at render time.
// ---------------------------------------------------------------------------

/** Legacy shim (module-load resolution; see the module docblock). */
export const TTL_SELECT_LABEL = t('common.ttlSelectLabel')
/** Legacy shim (module-load resolution; see the module docblock). */
export const NO_EXPIRY_LABEL = t('common.noExpiryLabel')
/** Legacy shims (module-load resolution; see the module docblock). */
export const TTL_30S_LABEL = t('common.ttl30Seconds')
export const TTL_5M_LABEL = t('common.ttl5Minutes')
export const TTL_1H_LABEL = t('common.ttl1Hour')

// ---------------------------------------------------------------------------
// Issue #98 — message reactions (MessageItem quick-pick bar and aggregated
// chips row). The accessible names live in i18n under `common.reaction*`.
// ---------------------------------------------------------------------------

/** Legacy shims (module-load resolution; see the module docblock). */
export const REACTION_ADD_LABEL = t('common.reactionAdd')
export const REACTION_BAR_LABEL = t('common.reactionBar')
export const REACTIONS_ROW_LABEL = t('common.reactionsRow')

/** Accessible name and tooltip of one quick-pick button. Locale-live. */
export function reactQuickPickLabel(emo: string): string {
  return t('common.reactQuickPick', { emo })
}

/** Tooltip of an aggregated chip: the reactor nicknames, comma-separated
 * (locale-neutral — names are data, not copy). */
export function reactionChipTooltip(nicknames: readonly string[]): string {
  return nicknames.join(', ')
}

// ---------------------------------------------------------------------------
// Issue #97 (spec §12.2) — trackerless manual DMs: wizard strings, entry
// points and the DmList marker. The exact spec texts live in i18n under
// `wizard.*` (the «(no room)» marker is spec-frozen and stays literal
// English in every locale).
// ---------------------------------------------------------------------------

/** Sidebar DM section entry button (visible text and accessible name).
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_INVITE_ENTRY = t('wizard.inviteEntry')

/** Tracker-error banner shortcut (visible text and accessible name).
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_BANNER_SHORTCUT = t('wizard.bannerShortcut')

/**
 * Exact §12.2 warning shown wherever a blob is displayed for copying.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const MANUAL_DM_NETWORK_WARNING = t('wizard.networkWarning')

/** Role A — accessible name of the readonly textarea holding the invite blob.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_INVITE_BLOB_LABEL = t('wizard.inviteBlobLabel')

/** Role B — accessible name of the paste textarea for A's invite.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_PASTE_INVITE_LABEL = t('wizard.pasteInviteLabel')

/** Role B — button that validates the pasted invite and produces the answer.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_GENERATE_ANSWER_BUTTON = t('wizard.generateAnswerButton')

/** Role A — accessible name of the paste textarea for B's answer.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_PASTE_ANSWER_LABEL = t('wizard.pasteAnswerLabel')

/** Role A — button that validates the pasted answer and starts connecting.
 * Legacy shims (module-load resolution; see the module docblock). */
export const MANUAL_DM_ROLE_INVITE_BUTTON = t('wizard.roleInviteButton')
export const MANUAL_DM_ROLE_ANSWER_BUTTON = t('wizard.roleAnswerButton')

/** Wizard dialog accessible name.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_WIZARD_LABEL = t('wizard.label')

/** Progress: waiting for the WebRTC handshake to finish.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_PROGRESS_ESTABLISHING = t('wizard.progressEstablishing')

/** Progress/connection status vocabulary (§10.3) reused at wizard connect.
 * Legacy shim (module-load resolution; see the module docblock). */
export const MANUAL_DM_PROGRESS_CONNECTED = t('wizard.progressConnected')

/** Copy/Cancel/Copied buttons: the shared `common.copy`/`common.cancel`/
 * `common.copied` verbs (duplicates collapsed, per the i18n migration).
 * Legacy shims (module-load resolution; see the module docblock). */
export const MANUAL_DM_COPY_BUTTON = t('common.copy')
export const MANUAL_DM_COPIED_FEEDBACK = t('common.copied')

/**
 * ManualBlobError reason → i18n key (§12.2 validation order). Private: call
 * `manualBlobErrorText` (locale-live at call time).
 */
const MANUAL_BLOB_ERROR_KEYS: Record<
  'encoding' | 'version' | 'role' | 'keys' | 'fingerprint' | 'sdp',
  TranslationKey
> = {
  encoding: 'wizard.blobErrorEncoding',
  version: 'wizard.blobErrorVersion',
  role: 'wizard.blobErrorRole',
  keys: 'wizard.blobErrorKeys',
  fingerprint: 'wizard.blobErrorFingerprint',
  sdp: 'wizard.blobErrorSdp',
}

/**
 * Inline error for a rejected paste, keyed by the engine's ManualBlobError
 * reason (§12.2 validation order). The wizard stays open: the paste can be
 * corrected and retried. Locale-live: resolves through `t()` on every call.
 */
export function manualBlobErrorText(
  reason: 'encoding' | 'version' | 'role' | 'keys' | 'fingerprint' | 'sdp',
): string {
  return t(MANUAL_BLOB_ERROR_KEYS[reason])
}

/**
 * ManualPeerError code → i18n key. Private: call `manualPeerErrorText`
 * (locale-live at call time).
 */
const MANUAL_PEER_ERROR_KEYS: Partial<
  Record<
    | 'bad-blob'
    | 'fingerprint-mismatch'
    | 'connect-timeout'
    | 'illegal-transition'
    | 'not-connected'
    | 'too-long',
    TranslationKey
  >
> = {
  'bad-blob': 'wizard.peerErrorBadBlob',
  'fingerprint-mismatch': 'wizard.peerErrorFingerprintMismatch',
  'connect-timeout': 'wizard.peerErrorConnectTimeout',
  'illegal-transition': 'wizard.peerErrorIllegalTransition',
  'not-connected': 'wizard.peerErrorNotConnected',
  'too-long': 'wizard.peerErrorTooLong',
}

/** Inline error for an engine rejection beyond the blob parse. Locale-live. */
export function manualPeerErrorText(
  code:
    | 'bad-blob'
    | 'fingerprint-mismatch'
    | 'connect-timeout'
    | 'illegal-transition'
    | 'not-connected'
    | 'too-long',
): string | undefined {
  const key = MANUAL_PEER_ERROR_KEYS[code]
  return key === undefined ? undefined : t(key)
}

// ---------------------------------------------------------------------------
// Issue #99 (English copy per issue #112 phase 1) — slash commands: the /help
// overlay and the /clear confirmation dialog. The command list itself renders
// straight from SLASH_COMMANDS (verb + usage + help live in the parser
// table; `help` resolves through i18n there); only the overlay chrome and
// the escape-hatch explanation live here, under `slash.*`. Local feed-line
// wording (command feedback/errors) is in lib/feed.ts, per the issue-#95
// precedent.
// ---------------------------------------------------------------------------

/** /help overlay — dialog accessible name.
 * Legacy shims (module-load resolution; see the module docblock). */
export const SLASH_HELP_LABEL = t('slash.helpLabel')

/**
 * /help overlay — the escape hatch for literal messages starting with '/',
 * documented here per the issue ("Documented in /help").
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const SLASH_HELP_ESCAPE_HINT = t('slash.helpEscapeHint')

/** /clear — ConfirmDialog title.
 * Legacy shims (module-load resolution; see the module docblock). */
export const CLEAR_FEED_DIALOG_TITLE = t('slash.clearDialogTitle')

/** /clear — ConfirmDialog body: what is (and is not) destroyed.
 * Legacy shim (module-load resolution; see the module docblock). */
export const CLEAR_FEED_DIALOG_BODY = t('slash.clearDialogBody')

/**
 * Slash-candidate popup (issue #99 Phase 3) — accessible name of the
 * composer's inline listbox. The option rows render straight from
 * SLASH_COMMANDS (usage + help), like the /help overlay.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const SLASH_POPUP_LABEL = t('slash.popupLabel')

// ---------------------------------------------------------------------------
// Issue #103 phase 4 — P2P file transfer UI: the composer's pre-send dialog
// (attachment button, file picker, encryption notice, recipient scope), the
// consent/progress/result cards rendered from the engine's §12.4 map and the
// honest terminal-state texts. All wording lives in i18n under `files.*`
// (the shared Accept/Decline/Cancel verbs live under `common.*`).
// ---------------------------------------------------------------------------

/** Composer attachment button (accessible name; visible text is 'Attach').
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_ATTACH_LABEL = t('files.attachLabel')

/** Pre-send dialog accessible name (the Modal label).
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_DIALOG_LABEL = t('files.dialogLabel')

/** Visible text and accessible name of the styled file-picker affordance.
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_PICK_LABEL = t('files.pickLabel')

/** Recipient scope selector (room mode) accessible name.
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_RECIPIENT_LABEL = t('files.recipientLabel')

/** Recipient scope in DM mode: a fixed line (the peer cannot change). Locale-live. */
export function fileRecipientDmText(peerNick: string): string {
  return t('files.recipientDm', { peerNick })
}

/** Pre-send encryption notice for a password room (room key, §9.3).
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_ENC_NOTICE_ROOM = t('files.encNoticeRoom')

/** Pre-send encryption notice for a DM (DM key v2, §9.2; always sealed).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_ENC_NOTICE_DM = t('files.encNoticeDm')

/** §12.4 pre-send warning for public rooms (the exact DTLS-only disclosure).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_ENC_WARNING_PUBLIC = t('files.encWarningPublic')

/**
 * Card encryption line for a sealed transfer. The wire cannot say whether
 * the key is the room's or the DM's (§12.4's one ambiguity — GCM resolves it
 * per chunk), so incoming cards stay honest with the generic line; the
 * cleartext line (`files.encStateClear`) is the public-room DTLS-only state.
 * The card component resolves both keys at render time.
 * Legacy shim for the docs suite (module-load resolution; see the module
 * docblock).
 */
export const FILE_ENC_STATE_CLEAR = t('files.encStateClear')

/** Dialog buttons (Cancel is the shared `common.cancel` verb).
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_SEND_BUTTON = t('files.sendButton')
export const FILE_CANCEL_BUTTON = t('common.cancel')

/** Room mode with no connected peers: there is nobody to address the offer to.
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_NO_PEERS_TEXT = t('files.noPeers')

/** Display-only placeholder when the File carries no mime (legitimate, §12.4).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_UNKNOWN_MIME_TEXT = t('files.unknownMime')

/**
 * SendFileRefusal reason → i18n key. Private: call `fileRefusalText`
 * (locale-live at call time).
 */
const FILE_REFUSAL_KEYS: Record<SendFileRefusal, TranslationKey> = {
  'unknown-room': 'files.refusalUnknownRoom',
  'not-connected': 'files.refusalNotConnected',
  'peer-not-in-room': 'files.refusalPeerNotInRoom',
  'invalid-file': 'files.refusalInvalidFile',
  'file-too-big': 'files.refusalFileTooBig',
  'name-required': 'files.refusalNameRequired',
  'concurrency-cap': 'files.refusalConcurrencyCap',
  'dm-key-unavailable': 'files.refusalDmKeyUnavailable',
  'key-resolution-failed': 'files.refusalKeyResolutionFailed',
}

/**
 * Inline refusal for the pre-send dialog, keyed by the engine's
 * SendFileRefusal: every local rejection surfaces with its own honest line
 * before anything hits the wire. Locale-live: resolves through `t()` on
 * every call (replaces the old FILE_REFUSAL_TEXT string map).
 */
export function fileRefusalText(reason: SendFileRefusal): string {
  return t(FILE_REFUSAL_KEYS[reason])
}

/** One card's accessible name, built from the file name and the peer nick. Locale-live. */
export function fileCardLabel(fileName: string, peerNick: string | null): string {
  return peerNick === null
    ? t('files.cardLabel', { fileName })
    : t('files.cardLabelWithPeer', { fileName, peerNick })
}

/** Consent card (incoming offer): the question, with the sender's nick. Locale-live. */
export function fileOfferText(peerNick: string): string {
  return t('files.offerText', { peerNick })
}

/** Sender-side pending offer line (waiting for the peer's consent).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_OFFER_PENDING_TEXT = t('files.offerPending')

/** Progress bar accessible name (role="progressbar" on the card).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_PROGRESS_LABEL = t('files.progressLabel')

/** Done card text.
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_DONE_TEXT = t('files.done')

/** FileFailureReason → i18n key. Private: call `fileFailureText` (locale-live). */
const FILE_FAILURE_KEYS: Record<FileFailureReason, TranslationKey> = {
  stall: 'files.failureStall',
  'peer-drop': 'files.failurePeerDrop',
  'room-gone': 'files.failureRoomGone',
  'size-limit': 'files.failureSizeLimit',
  'bad-frame': 'files.failureBadFrame',
  crypto: 'files.failureCrypto',
  completeness: 'files.failureCompleteness',
  'identity-regenerated': 'files.failureIdentityRegenerated',
}

/**
 * Failed-transfer line per the engine's FileFailureReason (honest states).
 * Locale-live: resolves through `t()` on every call (replaces the old
 * FILE_FAILURE_TEXT string map).
 */
export function fileFailureText(reason: FileFailureReason): string {
  return t(FILE_FAILURE_KEYS[reason])
}

/** Consent card actions (before any byte flows, §12.4) — the shared
 * `common.accept`/`common.decline` verbs (duplicates collapsed).
 * Legacy shims (module-load resolution; see the module docblock). */
export const FILE_ACCEPT_BUTTON = t('common.accept')
export const FILE_DECLINE_BUTTON = t('common.decline')

/** Download affordance on a done, non-image transfer (receiver side).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_DOWNLOAD_BUTTON = t('files.downloadButton')

/** Dismiss control of a terminal card; revokes the object URL (§12.4).
 * Legacy shim (module-load resolution; see the module docblock). */
export const FILE_DISMISS_BUTTON = t('files.dismissButton')

// ---------------------------------------------------------------------------
// Issue #100 — QR invite (ChatHeader 'QR' button → popover over the share
// affordance). The QR encodes exactly buildRoomLink's output (room name
// only, never the password — RF-05); all wording lives in i18n under `qr.*`.
// ---------------------------------------------------------------------------

/** Header entry button: accessible name and tooltip (visible text is 'QR').
 * Legacy shims (module-load resolution; see the module docblock). */
export const QR_BUTTON_LABEL = t('qr.buttonLabel')

/** Popover dialog accessible name (Modal label).
 * Legacy shim (module-load resolution; see the module docblock). */
export const QR_DIALOG_LABEL = t('qr.dialogLabel')

/** Canvas role="img" label: describes what the QR encodes. Locale-live. */
export function qrCanvasLabel(roomName: string): string {
  return t('qr.canvasLabel', { roomName })
}

/** Button that downloads the QR as a PNG file.
 * Legacy shims (module-load resolution; see the module docblock). */
export const QR_DOWNLOAD_BUTTON = t('qr.downloadButton')

/** Same-deployment disclosure (issue #100 Risks): a QR from another install
 * joins nothing. Legacy shims (module-load resolution; see the module
 * docblock; the contact flow reuses the same key). */
export const QR_SAME_INSTALL_NOTE = t('qr.sameInstallNote')

// ---------------------------------------------------------------------------
// Issue #104 phase 4 — the service-worker update toast (App-level, bottom
// corner): a waiting worker means a deployed new version is ready behind
// this page, and «Reload» is the reload that swaps it in. Component-local
// state only: dismissing hides the toast for the session (a NEWER waiting
// worker notifies afresh), nothing persists, and the toast never implies
// push — it is a local same-origin artifact (§10.9). Wording lives in i18n
// under `common.update*`.
// ---------------------------------------------------------------------------

/** The toast text: a new version waits behind this page.
 * Legacy shims (module-load resolution; see the module docblock). */
export const UPDATE_AVAILABLE_TEXT = t('common.updateAvailable')

/** The action: reload so the waiting worker activates (the swap).
 * Legacy shim (module-load resolution; see the module docblock). */
export const UPDATE_RELOAD_BUTTON = t('common.updateReload')

/** Accessible name and tooltip of the dismiss control (session-only).
 * Legacy shim (module-load resolution; see the module docblock). */
export const UPDATE_TOAST_DISMISS_LABEL = t('common.updateToastDismiss')

// ---------------------------------------------------------------------------
// Issue #105 phase 3 (spec §12.5) — the global-DM contact flow: the
// Privacy opt-in toggle, the DmList «+ contact» entry, the «My contact»
// share screen (fingerprint + QR via the #100 machinery) and the «Contact
// by fingerprint» knock flow, plus the inbound consent card. All wording
// lives in i18n under `contact.*` (plus `qr.*` for the share screen's QR,
// whose wording is the #100 one verbatim). The «(global)» marker is
// spec-frozen and stays literal English in every locale.
// ---------------------------------------------------------------------------

/** Privacy tab — the global-DM opt-in toggle (Settings → Privacy).
 * Legacy shims (module-load resolution; see the module docblock). */
export const GLOBAL_DM_TOGGLE_LABEL = t('contact.toggleLabel')

/** Privacy tab — the honest §9.5 disclosure under the toggle (see the
 * `contact.toggleHint` key). Legacy shim (module-load resolution). */
export const GLOBAL_DM_TOGGLE_HINT = t('contact.toggleHint')

/** Sidebar DM section entry (visible text and accessible name), sibling of
 * «+ invite». Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_ENTRY = t('contact.entry')

/** Contact dialog accessible name (the Modal label).
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_DIALOG_LABEL = t('contact.dialogLabel')

// Share screen («My contact»).

/** Accessible name of the readonly field holding the own fingerprint.
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_FP_LABEL = t('contact.fpLabel')

/** Copy/feedback buttons: the shared `common.copy`/`common.copied` verbs
 * (duplicates collapsed). Legacy shims (module-load resolution). */
export const CONTACT_COPY_BUTTON = t('common.copy')
export const CONTACT_COPIED_FEEDBACK = t('common.copied')

/** Canvas role="img" label: describes what the QR encodes.
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_QR_CANVAS_LABEL = t('contact.qrCanvasLabel')

/** Button that downloads the contact QR as a PNG file — the #100 wording,
 * one `qr.downloadButton` key for both QRs (duplicates collapsed).
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_DOWNLOAD_BUTTON = t('qr.downloadButton')

/** Same-deployment disclosure — the `qr.sameInstallNote` key reused for the
 * contact QR. Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_QR_SAME_INSTALL_NOTE = t('qr.sameInstallNote')

// Knock screen («Contact by fingerprint»).

/** Accessible name of the paste textarea for the peer's fingerprint.
 * Legacy shims (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_PASTE_LABEL = t('contact.knockPasteLabel')

/** Accessible name of the optional note textarea (capped at 140 chars).
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_NOTE_LABEL = t('contact.knockNoteLabel')

/** Character counter of the note field (aria-live). Locale-live. */
export function contactNoteCounter(length: number): string {
  return t('contact.noteCounter', { length })
}

/** Pick-screen button that knocks by pasted fingerprint.
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_ENTRY_BUTTON = t('contact.knockEntryButton')

/** Button that validates the pasted fingerprint and knocks.
 * Legacy shims (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_SEND_BUTTON = t('contact.knockSendButton')

/** Progress: the knock is out, waiting for the peer's consent (live region).
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_WAITING_TEXT = t('contact.knockWaiting')

/** Inline terminal state when the peer answered knock-ack(false).
 * Legacy shim (module-load resolution; see the module docblock). */
export const CONTACT_KNOCK_REJECTED_TEXT = t('contact.knockRejected')

/**
 * KnockError reason → i18n key. Private: call `knockErrorText` (locale-live).
 */
const KNOCK_ERROR_KEYS: Record<'signal-off' | 'peer-not-present' | 'invalid-knock', TranslationKey> =
  {
    'signal-off': 'contact.knockErrorSignalOff',
    'peer-not-present': 'contact.knockErrorPeerNotPresent',
    'invalid-knock': 'contact.knockErrorInvalid',
  }

/**
 * Inline error for a typed KnockError rejection, keyed by its reason.
 * Locale-live: resolves through `t()` on every call (replaces the old
 * KNOCK_ERROR_TEXT string map).
 */
export function knockErrorText(reason: 'signal-off' | 'peer-not-present' | 'invalid-knock'): string {
  return t(KNOCK_ERROR_KEYS[reason])
}

// Inbound consent card (the «door» rendered wherever the user is).

/** The card's question line (the exact §12.5 shape, with the sender's nick). Locale-live. */
export function knockConsentText(nick: string): string {
  return t('contact.knockConsent', { nick })
}

/** Accessible name of one consent card region. Locale-live. */
export function knockCardLabel(nick: string): string {
  return t('contact.knockCardLabel', { nick })
}

/** Accessible name of the consent-cards strip (one region, N cards).
 * Legacy shims (module-load resolution; see the module docblock). */
export const KNOCK_CARDS_REGION_LABEL = t('contact.knockCardsRegionLabel')

/** Prefix of the optional note line rendered on the card.
 * Legacy shims (module-load resolution; see the module docblock); the shared
 * Accept/Decline/Mute verbs live under `common.*` (duplicates collapsed). */
export const KNOCK_NOTE_PREFIX = t('contact.knockNotePrefix')
export const KNOCK_ACCEPT_BUTTON = t('common.accept')
export const KNOCK_REJECT_BUTTON = t('common.decline')
export const KNOCK_MUTE_BUTTON = t('common.mute')
