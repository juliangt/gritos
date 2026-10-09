/**
 * Issue #119 — i18n source of truth (English).
 *
 * Every user-facing string in gritos eventually lives here, keyed by flat
 * dotted literals with one namespace per surface (phase 2 moved the
 * centralized copy in — settings/messages.ts, lib/feed.ts, lib/rooms.ts,
 * lib/notifications.ts, lib/nickname.ts, the §10.3 status templates and the
 * slash-command help strings; sidebar/chat inline literals follow in
 * phase 3):
 *
 *   common.*        shared verbs/labels reused across surfaces
 *   settings.*      the settings modal (validation, disclosures, mute list)
 *   chat.*          the chat header/composer (§10.3 status, banners)
 *   feed.*          room feed rows and separators
 *   dm.*            direct-message surfaces
 *   sidebar.*       the sidebar sections (rooms, peers, DM list, join form)
 *   slash.*         slash-command docs, feedback and error lines
 *   files.*         file-transfer UI (§12.4)
 *   qr.*            the QR share overlay
 *   wizard.*        the manual-DM wizard (§12.2)
 *   contact.*       the contact/invite surface (§12.5)
 *   onboarding.*    first-visit onboarding
 *   notifications.* desktop notification bodies (§10.5)
 *   panic.*         the panic-button confirmations
 *   errors.*        generic error lines
 *
 * Phase 3 moved the remaining inline component literals in: every aria-label,
 * title, placeholder and JSX string of the sidebar, the settings tabs, the
 * chat chrome, onboarding and the panic flow now resolve through `t` at
 * render time, and the engine-thrown UI errors (the room-cap/invalid-name
 * messages surfacing verbatim in the join popover and /room lines) are
 * single-sourced here too.
 *
 * EXACT-TEXT CONTRACT: components AND tests import the same keys — tests
 * assert the `en` strings verbatim through `t`, so a copy change here is a
 * compile-visible test change, never a silent one. `./es` is typed against
 * `Translations = Record<TranslationKey, string>`, so a key added here and
 * missing there (or an extra one on either side) is a `tsc -b` build error:
 * key parity is compile-enforced, not convention.
 *
 * Placeholder convention: `{name}`-style tokens (`'Copied {what}'`) are
 * filled by `t`'s `params` argument; unknown params leave the token as-is.
 * Plural convention: a countable concept gets a `…One`/`…Other` key pair
 * (`common.peerCountOne`/`common.peerCountOther`) — English and Spanish
 * only distinguish those two CLDR forms — selected by `tPlural`.
 *
 * Grammar/protocol fragments that stay English inside every locale (the
 * migration audit's freeze list): slash `usage` strings (`{usage}` content,
 * e.g. '/nick <name>'), the '(no room)'/'(global)' DmList markers and the
 * '#room-name' pieces of /rooms output — they are protocol-shaped tokens,
 * not prose.
 */

/**
 * The English dictionary, grouped by surface. Key names derive from the
 * original export names with the redundant `_TEXT/_LABEL/_HINT/_TITLE`
 * suffixes dropped; the doc comments keep the spec references (§ tags,
 * issue numbers, privacy/consent nuances) the phase-4 translation review
 * needs.
 */
export const en = {
  // -------------------------------------------------------------------------
  // common — shared verbs/labels reused across surfaces.
  // -------------------------------------------------------------------------

  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  /** Interpolation seed: `{what}` is filled from `t` params. */
  'common.copiedWith': 'Copied {what}',
  /** Plural seed — `tPlural('common.peerCount', n)` picks the right form.
   * Phase 3: ChatHeader's header count and DmHeader's fixed single-peer line
   * render through this pair too (the hardcoded '1 peer' is gone). */
  'common.peerCountOne': '{count} peer',
  'common.peerCountOther': '{count} peers',
  /** Plural pair — the unread pill next to every sidebar row (Badge). */
  'common.unreadCountOne': '{count} unread',
  'common.unreadCountOther': '{count} unread',

  /** Shared chrome reused across surfaces (phase 3 inline-literal harvest). */
  'common.continue': 'Continue',
  'common.join': 'Join',
  'common.send': 'Send',
  /** The settings entry: ChatHeader/DmHeader ⚙ aria + title and the modal's
   * accessible name and heading — one wording everywhere. */
  'common.settings': 'Settings',
  /** The ✕ dismiss control of the network banners (aria + title, ×2 spots). */
  'common.dismissNotice': 'Dismiss the notice',
  /** The 🔒 marker on a password room (RoomList row, ChatHeader title,
   * JoinRoomPopover toggle): accessible name and tooltip. */
  'common.encryptedRoomAria': 'encrypted room',
  'common.encryptedRoomTitle': 'Password-protected room',
  /** Onboarding + settings nickname fields: the label and the field's
   * accessible name are the same wording (one key). */
  'common.yourNickname': 'Your nickname',

  /** Shared destructive/safe verbs: PeerList menu, knock cards, file cards. */
  'common.mute': 'Mute',
  'common.unmute': 'Unmute',
  'common.accept': 'Accept',
  'common.decline': 'Decline',

  /**
   * Issue #96 — composer TTL selector (room and DM modes). Only the wording
   * lives here: the selection itself is memory-only component state and is
   * never persisted.
   */
  'common.ttlSelectLabel': 'Message expiry',
  /** Default option: the message lives for the session (no ttl on the wire). */
  'common.noExpiryLabel': 'No expiry',
  /** Per-message expiry choices offered by the selector. */
  'common.ttl30Seconds': '30 seconds',
  'common.ttl5Minutes': '5 minutes',
  'common.ttl1Hour': '1 hour',

  /**
   * Issue #98 — message reactions (MessageItem quick-pick bar and aggregated
   * chips row). All English wording shared by components and tests.
   */

  /** Accessible name and tooltip of the row affordance that opens the quick-pick bar. */
  'common.reactionAdd': 'React',
  /** Accessible label of the quick-pick bar container (the 7-whitelist row). */
  'common.reactionBar': 'Quick reactions',
  /** Accessible label of the aggregated chips row under the bubble. */
  'common.reactionsRow': 'Reactions',
  /** Accessible name and tooltip of one quick-pick button. */
  'common.reactQuickPick': 'React with {emo}',

  /**
   * Issue #104 — the service-worker update toast (App-level, bottom corner):
   * a waiting worker means a deployed new version is ready behind this page,
   * and «Reload» is the reload that swaps it in. Component-local state only:
   * dismissing hides the toast for the session (a NEWER waiting worker
   * notifies afresh), nothing persists, and the toast never implies push —
   * it is a local same-origin artifact (§10.9).
   */

  /** The toast text: a new version waits behind this page. */
  'common.updateAvailable': 'New version available',
  /** The action: reload so the waiting worker activates (the swap). */
  'common.updateReload': 'Reload',
  /** Accessible name and tooltip of the dismiss control (session-only). */
  'common.updateToastDismiss': 'Dismiss the notice',
  /** The toast region's accessible name (UpdateToast role="status"). */
  'common.updateToastLabel': 'New app version',

  // -------------------------------------------------------------------------
  // settings — the settings modal: Network-tab validation (RF-07), the
  // TURN/P2P storage & exposure disclosures (#30/#35), the mute list (#95),
  // the history-gossip consent (#102) and its in-feed request card, and the
  // join-form texts (RF-02/RF-05).
  // -------------------------------------------------------------------------

  /** Network tab — inline validation (RF-07). */
  'settings.trackerError': 'Tracker URLs must start with wss://',
  'settings.iceError': 'ICE servers must start with stun: or turn:',
  'settings.maxRoomsError': 'The active-room limit must be between 1 and 6.',

  /** Network tab — empty-config hints and the reconnect semantics note. */
  'settings.emptyTrackersHint': 'Empty list: Trystero’s default trackers are used.',
  'settings.emptyIceHint': 'Empty list: Trystero’s default ICE configuration is used.',
  'settings.reconnectNote': 'Network changes are applied when the rooms reconnect.',

  /**
   * Issue #30 — persistent-storage disclosures shown next to the TURN
   * credential fields. The storage variant is shared by the Network tab and
   * the Privacy-tab at-rest note; the memory variant shows while
   * «Remember TURN credentials» is off.
   */
  'settings.turnCredentialStorageHint':
    'TURN credentials are stored unencrypted in this browser.',
  'settings.turnCredentialMemoryHint':
    'TURN credentials are kept in memory only and are lost when the tab closes.',
  /**
   * Privacy tab — the at-rest note: the storage disclosure above glued (in
   * the pre-i18n markup) to the pointer at the Network-tab toggle. ONE
   * template so a locale can reflow the whole sentence.
   */
  'settings.turnCredentialAtRestNote':
    'TURN credentials are stored unencrypted in this browser. They are configured in the Network tab; turn off «Remember TURN credentials in this browser» there so they only live in the session’s memory.',

  /**
   * Issue #35 — P2P exposure disclosures (onboarding line and Privacy-tab
   * note): direct WebRTC connections reveal the IP to room peers (and, in
   * less detail, to tracker operators); a configured TURN does not hide it
   * (the browser still announces the public address among the ICE candidates).
   */
  'settings.p2pDisclosure':
    'Connections are P2P: whoever shares a room with you can see your IP address.',
  'settings.p2pIpExposureNote':
    'Connections are P2P by design: whoever shares a room with you can see your IP address, and configuring TURN does not hide it from peers (the browser keeps announcing your public address). Tracker operators see connection metadata in less detail: your IP, opaque ids and join instants.',

  /**
   * Issue #95 — local moderation: peer mute controls. The dialog discloses
   * (before acting) that muting a peer with an open DM channel also ignores
   * their future DMs (phase 2 receive-path enforcement).
   */
  /** Accessible name of the MessageItem inline affordance on an author row. */
  'settings.muteAuthorAction': 'Mute @{nickname}',
  /** ConfirmDialog title/body shown by the PeerList for the DM-loss consent. */
  'settings.muteDmDialogTitle': 'Mute peer',
  'settings.muteDmDialogBody':
    'You have a direct conversation open with this peer: muting them stops their room messages from reaching you and their direct messages will be ignored. You can undo this in Settings → Privacy. Continue?',

  /** Privacy tab — the local mute list: what it does, and why nicknames may
   * be missing (they ride memory-only next to the persisted fingerprints). */
  'settings.mutedPeersHeading': 'Muted peers',
  'settings.mutedPeersHint':
    'These peers cannot send you room messages or direct messages. The nickname is only shown if you muted them in this session.',
  /** Privacy tab — empty state when no fingerprint is muted. */
  'settings.emptyMutedPeers': 'You have not muted any peer.',
  /** Accessible name of a mute-list row's unmute button; the identifier is
   * the @nickname or the truncated fingerprint. */
  'settings.unmutePeerAction': 'Unmute {identifier}',

  /**
   * Issue #102 — opt-in history gossip: the Privacy-tab consent toggle (the
   * label is the issue's exact string). The hint discloses what a consented
   * share covers (only on an explicit request, at most the last 50 chat
   * messages held in memory, nothing persisted, password-room bodies
   * re-sealed so only peers with the same password can read them).
   */
  'settings.shareHistoryLabel': 'Share my recent history with late joiners',
  'settings.shareHistoryHint':
    'Only if you turn it on, whoever joins a room late and explicitly asks for it may receive up to the last 50 chat messages this tab holds in memory. Nothing is stored or sent without a request; in password rooms the bodies travel re-sealed with the room key, so only someone who knows it can read them.',

  /**
   * Issue #102 phase 3 — the in-feed history-request card (empty room feed):
   * one explicit tap asks the room for its recent messages, the other
   * dismisses the offer for this join. Repeated asks are rate-limited by the
   * manager's per-room budget; nothing is ever asked automatically.
   */
  /** Accessible name of the inline card region. */
  'settings.historyAskLabel': 'Request recent messages',
  /** The offer text (exact issue string). */
  'settings.historyAskText': 'Ask the room for the latest messages?',
  /** Confirm button: dispatches one hist-req (n = 50). */
  'settings.historyAskConfirm': 'Ask',
  /** Dismiss button: declines the offer for this join (memory-only). */
  'settings.historyAskDismiss': 'No',

  /** Join form (RF-02/RF-05): inline validation, the encrypted-room hint
   * (issue #31: a password room's name is never saved in this browser) and
   * the empty-password error. */
  'settings.invalidRoomName':
    'Only lowercase letters, numbers, hyphens and underscores (1–32 characters)',
  'settings.encryptedRoomHint':
    'Whoever lacks the password will not find this room. Its name is never saved in this browser.',
  'settings.emptyRoomPassword': 'Write a password for the encrypted room',

  /**
   * Phase 3 — the inline literals of the modal itself and its three tabs.
   * The modal label/heading render the shared `common.settings` wording.
   */

  /** Modal chrome: the ✕ control, the nickname form (RF-01) and the tabs. */
  'settings.closeAria': 'Close settings',
  'settings.changeNicknameLabel': 'Change nickname',
  'settings.saveNickname': 'Save nickname',
  'settings.sectionsAria': 'Settings sections',
  'settings.tabNetwork': 'Network',
  'settings.tabPrivacy': 'Privacy',
  'settings.tabAppearance': 'Appearance',

  /** Privacy tab — the notifications toggle with its permission-request flow.
   * The hint mirrors the browser's NotificationPermission state. */
  'settings.notificationsLabel': 'Desktop notifications',
  'settings.allowNotifications': 'Allow notifications',
  'settings.permissionGranted': 'Permission granted.',
  'settings.permissionDefault': 'Permission not requested.',
  'settings.permissionDenied': 'Permission denied. Enable it from the browser settings.',
  'settings.permissionUnsupported': 'Your browser does not support notifications.',
  /** Privacy tab — remember-recents toggle. */
  'settings.rememberRoomsLabel': 'Remember recent rooms',

  /**
   * Privacy tab — identity regeneration (issue #24 context): the at-rest
   * note for the wrapped private key, the ECDH pointer above the button, and
   * the confirm dialog. The button label doubles as the dialog title (one
   * wording, as before the migration).
   */
  'settings.identityKeyAtRestNote':
    'Your private key is stored encrypted in this browser: the key that decrypts it lives in IndexedDB and nothing travels over the network. Even so, if something fully compromises this origin (a malicious extension, malware on your computer) it could use that key to impersonate you.',
  'settings.regenerateHint': 'Generate a new ECDH key pair: your fingerprint will change for all your peers.',
  'settings.regenerateIdentity': 'Regenerate identity',
  'settings.regenerateDialogBody':
    'A new key pair will be generated: your fingerprint will change and the DM channels with your peers will stop matching. Continue?',
  'settings.regenerateConfirm': 'Regenerate',

  /** Network tab — auto-join (RF-02) and the custom-tracker list. */
  'settings.autoJoinLobbyLabel': 'Auto-join #lobby on start',
  'settings.customTrackersHeading': 'Custom trackers',
  'settings.addTracker': 'Add tracker',
  /** Per-row accessible names; `{index}` is the 1-based row number. */
  'settings.trackerRowLabel': 'Tracker {index}',
  'settings.removeTrackerRowLabel': 'Remove tracker {index}',
  'settings.removeTrackerTitle': 'Remove tracker',

  /** Network tab — the ICE server list (STUN/TURN). The option values
   * ('stun'/'turn') are persisted data and stay literal; only the labels
   * and the per-row accessible names live here. */
  'settings.iceServersHeading': 'ICE servers (STUN/TURN)',
  'settings.stunOption': 'STUN',
  'settings.turnOption': 'TURN',
  'settings.addIceServer': 'Add ICE server',
  'settings.iceTypeRowLabel': 'ICE server type {index}',
  'settings.iceUrlRowLabel': 'ICE server URL {index}',
  'settings.removeIceRowLabel': 'Remove ICE server {index}',
  'settings.removeIceTitle': 'Remove ICE server',
  'settings.turnUsernameLabel': 'TURN username {index}',
  'settings.turnPasswordLabel': 'TURN password {index}',
  'settings.turnUsernamePlaceholder': 'username',
  'settings.turnPasswordPlaceholder': 'password',
  /** Issue #30 — the toggle deciding TURN-credential persistence. The same
   * wording is quoted inside `settings.turnCredentialAtRestNote`. */
  'settings.rememberTurnCredentialsLabel': 'Remember TURN credentials in this browser',

  /** Network tab — the 1–6 active-room cap and the reconnect-all action. */
  'settings.maxActiveRoomsLabel': 'Active room limit',
  'settings.reconnectAll': 'Reconnect all',

  /** Appearance tab — the theme radio group (labels only: the persisted
   * ThemeChoice VALUES 'light'/'dark'/'system' are data, never translated). */
  'settings.themeLabel': 'Theme',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.themeSystem': 'System',
  'settings.collapseSidebarLabel': 'Collapse sidebar on start',

  // -------------------------------------------------------------------------
  // chat — the chat header/composer: the §10.3 connection-status templates,
  // the network banners (RNF-07, issue #43, issue #125) and the password-room
  // not-found status (§10.3/RF-05, routed through errors.roomNotFound).
  // -------------------------------------------------------------------------

  /** §10.3 header status: searching with no peers discovered yet. */
  'chat.searchingStatus': 'Searching for peers on the torrent network…',
  /** §10.3 transition state: peers discovered, no DataChannel yet (2–6 s). */
  'chat.connectingStatusOne': 'Connecting ({count} peer found)…',
  'chat.connectingStatusOther': 'Connecting ({count} peers found)…',
  /** §10.3 connected: at least one active DataChannel. */
  'chat.connectedStatusOne': 'P2P channel established · {count} peer',
  'chat.connectedStatusOther': 'P2P channel established · {count} peers',

  /**
   * RNF-07 — text of the non-blocking banner shown at the top of the chat
   * area while any active room sits in the `error` state (§10.3 wording).
   */
  'chat.networkErrorBanner':
    'No tracker access — check your connection or configure alternative trackers',

  /**
   * Issue #125 — subtle line under the header status while a room latched the
   * peerless hint: the §10.3 heuristic expired over REACHABLE trackers with
   * zero peers, so the room stays `searching` (an empty room is not a broken
   * network) and this says so without the error banner's wording.
   */
  'chat.peerlessHint': 'Still waiting for peers — the room may be empty',

  /**
   * Issue #43 — text of the non-blocking banner shown at the top of the chat
   * area when the page runs outside a secure context (plain HTTP on a LAN IP):
   * Web Crypto and WebRTC are unavailable, so the #lobby auto-join is skipped
   * up front instead of rejecting silently. The '(insecure context)' phrasing
   * matches the onboarding error.
   */
  'chat.insecureContextBanner':
    'Could not connect — WebRTC and encryption require HTTPS or localhost (insecure context). See the README for serving the app over HTTPS.',

  /**
   * Phase 3 — the header/composer inline chrome: sidebar toggle (header +
   * DmHeader twin), share affordance (issue #41), room-status dot a11y
   * labels (§10.1), the composer (RF-03), the password-recovery offer
   * (issue #41/§10.3) and the RNF-07 banner chrome.
   */

  /** ☰ toggle (ChatHeader AND DmHeader — one wording). */
  'chat.toggleSidebarAria': 'Show or hide the sidebar',
  'chat.toggleSidebarTitle': 'Show or hide the sidebar (Ctrl/Cmd+B)',

  /** Issue #41 — share affordance: button accessible name, the Web Share
   * sheet title ({name} is the room name; 'gritos' is the brand, kept) and
   * the clipboard-fallback feedback. */
  'chat.shareRoomAria': 'Share room',
  'chat.shareTitle': 'Room #{name} on gritos',
  'chat.linkCopied': 'Link copied',

  /** StatusDot a11y labels per §10.3 room status (resolve at render). */
  'chat.statusSearching': 'searching for peers',
  'chat.statusConnected': 'connected',
  'chat.statusError': 'no tracker access',

  /** Composer (RF-03): form/textarea accessible names, the visible hint and
   * the queue note; the counter (`{length}/{cap}`) stays literal data. */
  'chat.composerLabel': 'Message',
  'chat.messageAria': 'Write a message',
  'chat.messagePlaceholder': 'Message (Markdown)…',
  'chat.markdownHint': '**bold** · *italic* · `code`',
  'chat.queuedHint': 'Queued until connected…',

  /** Password-recovery offer over a not-found room (issue #41, RF-05). */
  'chat.joinWithPasswordLabel': 'Join with password',
  'chat.passwordJoinPrompt': 'If the room has a password, join with it:',

  /** Room feed accessible name (MessageFeed label; {name} stays literal). */
  'chat.roomFeedLabel': 'Messages in #{name}',

  /** Empty-layout hint and the mobile drawer's accessible name. */
  'chat.noActiveRoomHint':
    'No active room. Join one from the sidebar (press Ctrl/Cmd+B to show it).',
  'chat.sidebarDrawerLabel': 'Sidebar',

  /** RNF-07 banner chrome: the region label and the settings shortcut. */
  'chat.networkStatusAria': 'Network status',
  'chat.openSettings': 'Open settings',

  /** Own-message receipt markers (✓/✓✓) accessible labels. */
  'chat.receiptDelivered': 'delivered',
  'chat.receiptPending': 'sent, pending receipt',

  // -------------------------------------------------------------------------
  // feed — system lines, separators and empty states (RF-03/RF-06, §10.4).
  // Local-only lines (mute, separators) are never sent over the wire.
  // -------------------------------------------------------------------------

  /** RF-03 — separator shown when the 500-message cap has trimmed history. */
  'feed.fifoSeparator': '— earlier messages discarded —',
  /**
   * Issue #96 — local separator for TTL messages the expiry sweep has removed
   * from this feed. Mirrors the FIFO separator: one line above the history,
   * memory-only; the count accumulates for the feed's lifetime (same latched
   * semantics as the FIFO trim flag).
   */
  'feed.expiredSeparatorOne': '— {count} expired message —',
  'feed.expiredSeparatorOther': '— {count} expired messages —',
  /**
   * Issue #102 — local separator above history recovered through opt-in
   * history gossip. Exact issue string, no count: it labels PROVENANCE (these
   * rows are a peer's replay, not live arrivals), not a quantity. Latched per
   * feed like the FIFO/expired lines, memory-only, never sent over the wire.
   * FROZEN verbatim by tests/historyGossipDocs.test.ts.
   */
  'feed.recoveredSeparator': '— messages recovered from peers —',

  // Empty states (M6, spec §10.4 — discrete).
  /** Empty room feed: invites sharing the room name (RF-02). */
  'feed.emptyRoom': 'Share the room name so others can join.',
  /** Empty DM feed (RF-04): the conversation exists but has no messages yet. */
  'feed.emptyDm': 'No messages yet. Write the first one.',
  /** Empty *Direct messages* section (RF-04): no open DM channels. */
  'feed.emptyDmList':
    'No direct messages yet. Open a peer’s menu to start an encrypted conversation.',
  /** Empty *Recents* section (RF-02): nothing remembered yet. */
  'feed.emptyRecents': 'No recent rooms yet.',

  /** RF-06 — system feed lines for peer joins/leaves. */
  'feed.joinLine': '— {nickname} joined —',
  'feed.leaveLine': '— {nickname} left —',

  /**
   * Issue #95 — local-only feed lines for a UI mute/unmute of a peer (never
   * sent over the wire). The @-prefixed nickname identifies the affected
   * identity; it is display text, not a mention.
   */
  'feed.muteLine': '@{nickname} was muted',
  'feed.unmuteLine': '@{nickname} is no longer muted',

  /**
   * Typing indicator line (RF-03): one known nick → 'nick is typing…',
   * several → 'N people are typing…', none → null (bar hidden).
   */
  'feed.typingOne': '{nickname} is typing…',
  'feed.typingOther': '{count} people are typing…',

  /** Floating new-messages button label (RF-03: '↓ N new messages'). */
  'feed.newMessagesOne': '↓ {count} new message',
  'feed.newMessagesOther': '↓ {count} new messages',

  /**
   * RF-05 — placeholder stored/rendered when a room chat arrives encrypted
   * and cannot be opened (theoretical no-key/derivation-collision case): the
   * raw ciphertext must NEVER reach the feed as text.
   */
  'feed.encryptedPlaceholder': '🔒 encrypted message',

  // -------------------------------------------------------------------------
  // dm — direct-message surfaces (RF-04, TOFU/issue #22, legacy-peer #93).
  // -------------------------------------------------------------------------

  /** RF-04 — header state when the peer shares no active room anymore. Also
   * the manual wizard's drop text (§12.2, RF-04 vocabulary) — one wording. */
  'dm.peerDisconnected': 'The peer has disconnected',

  /**
   * Issue #93 (spec §12.1) — composer hint when the connected peer runs a
   * legacy build (no session-ephemeral `ephkeys` announce): DMs are
   * impossible until it updates, and the honest state replaces the silent
   * message loss of the mixed-version degradation.
   */
  'dm.legacyPeer': 'This peer runs an older version without per-session encrypted DMs',

  /** RF-04 — TOFU verification notice shown under the peer's fingerprint. */
  'dm.verifyNotice': 'Compare it with your contact to verify their identity',

  /**
   * Issue #22 — TOFU divergence warning: the peer's live fingerprint differs
   * from the pinned first-seen one. Advisory only (messages keep flowing);
   * the hint tells the user what to do about it.
   */
  'dm.keyChangedWarning': '⚠ The fingerprint changed since your last verification',
  'dm.keyChangedHint':
    'The peer may have reinstalled the app or could be an impersonation: verify their identity through another channel before trusting them.',

  /** Accessible label of the DM message feed. */
  'dm.feedLabel': 'Direct messages with {peerNick}',

  /**
   * Phase 3 — the peer menu (PeerList) and the DmList disconnected chrome.
   * The ⚠ rotation warning line collapses onto `dm.keyChangedWarning`.
   */
  'dm.directMessageAction': 'Direct message',
  'dm.copyFingerprint': 'Copy fingerprint',
  'dm.fingerprintCopied': 'Fingerprint copied.',
  /** DmList row tooltip while the peer is away — the `dm.peerDisconnected`
   * wording plus the history-retention clause. */
  'dm.peerDisconnectedHistory': 'The peer has disconnected — the history remains',

  // -------------------------------------------------------------------------
  // sidebar — the sidebar sections (RF-02/RF-06, §10.1): room lists, the
  // peers section, the DM list and the join-by-name form. Phase 3 namespace.
  // -------------------------------------------------------------------------

  /** '[+ Join]' entry button (brackets are UI chrome, kept verbatim). */
  'sidebar.joinEntry': '[+ Join]',

  /** Room sections: accessible names, headings and the empty state. */
  'sidebar.activeRoomsLabel': 'Active rooms',
  'sidebar.activeHeading': 'Active',
  'sidebar.emptyActive': 'No active rooms yet.',
  'sidebar.suggestedRoomsLabel': 'Suggested rooms',
  'sidebar.suggestedHeading': 'Suggested',
  'sidebar.recentRoomsLabel': 'Recent rooms',
  'sidebar.recentHeading': 'Recent',
  /** Per-row ✕ control: aria and tooltip share the template ({name} is the
   * room name — a protocol token, never translated). */
  'sidebar.leaveRoom': 'Leave {name}',

  /** Peers section: accessible name, count heading (tPlural pair) and the
   * empty state. */
  'sidebar.peersSectionLabel': 'Peers',
  'sidebar.peerCountOne': 'Peer ({count})',
  'sidebar.peerCountOther': 'Peers ({count})',
  'sidebar.emptyPeers': 'No peers yet. Share the room name so others can join.',
  /** Per-peer affordances: latency dot, rotation ⚠, and the menu. */
  'sidebar.latencyAria': 'latency',
  'sidebar.fingerprintChangedAria': 'fingerprint changed',
  'sidebar.peerActionsLabel': 'Actions for {nickname}',
  /** DmList ⚪ marker accessible name (the tooltip is `dm.peerDisconnected`). */
  'sidebar.peerDisconnectedAria': 'peer disconnected',

  /** DM section heading and its section accessible name (one wording). */
  'sidebar.dmSectionLabel': 'Direct messages',

  /** Join-by-name popover (RF-02/RF-05): the form, the name field (the
   * placeholder is a normalized-room-name hint — translated) and the live
   * join preview (the '#{name}' token stays protocol-shaped). */
  'sidebar.joinByNameLabel': 'Join by name',
  'sidebar.roomNameAria': 'Room name',
  'sidebar.roomNamePlaceholder': 'room-name',
  'sidebar.joinPreview': 'You will join',
  'sidebar.encryptedRoomText': '🔒 encrypted room',
  'sidebar.roomPasswordAria': 'Room password',
  'sidebar.roomPasswordPlaceholder': 'Room password',

  // -------------------------------------------------------------------------
  // slash — slash-command docs and local feedback/error lines (issue #99).
  // Feedback lines are local-only (never sent over the wire). The `usage`
  // strings ('/nick <name>') stay English grammar inside every locale: they
  // are the parser's protocol-shaped grammar tokens.
  // -------------------------------------------------------------------------

  /** /help overlay — dialog accessible name and heading. */
  'slash.helpLabel': 'Slash commands',
  'slash.helpTitle': 'Commands',
  /**
   * /help overlay — the escape hatch for literal messages starting with '/',
   * documented here per the issue ("Documented in /help").
   */
  'slash.helpEscapeHint':
    'To send a text that starts with "/", prefix a backslash: \\/hello sends "/hello".',

  /** /clear — ConfirmDialog: what is (and is not) destroyed. */
  'slash.clearDialogTitle': 'Clear local history',
  'slash.clearDialogBody':
    'The messages of this room will be cleared from your browser only. The connection is not closed and your peers keep their history. Continue?',
  'slash.clearDialogConfirm': 'Clear',

  /** Slash-candidate popup (issue #99 Phase 3) — accessible name of the
   * composer's inline listbox. */
  'slash.popupLabel': 'Command suggestions',

  /** Inline hint for an unknown verb — never sent, points at /help. */
  'slash.unknownCommand': 'Unknown command — /help',
  /** Error line when a room-scoped command (/clear, /leave) has no target. */
  'slash.noActiveRoom': 'No active room.',

  /** Confirmation line after a successful /nick (the manager re-announced presence). */
  'slash.nicknameChanged': 'Nickname changed to "{nickname}"',

  /**
   * /rooms output: one line listing the active rooms in join order, each with
   * its unread badge when it has pending messages. `#{name}` stays literal
   * (a room name is a protocol token, not prose).
   */
  'slash.activeRooms': 'Active rooms: {rooms}',
  'slash.roomUnreadOne': '#{name} ({count} unread)',
  'slash.roomUnreadOther': '#{name} ({count} unread)',
  /** /rooms with no active rooms (plural — distinct from slash.noActiveRoom). */
  'slash.noActiveRooms': 'No active rooms.',

  /** /dm error: no current peer carries that nickname (case-insensitive match). */
  'slash.dmPeerNotFound': 'Nobody among your peers is named "{nickname}".',
  /** /dm error: several peers share the nickname; the peer list disambiguates. */
  'slash.dmAmbiguous':
    'Several peers are named "{nickname}": open the conversation from the peer list.',

  /**
   * 'Usage: /nick <name>' — prefix for arity and validation error lines. The
   * `Usage: ` prefix is UI chrome (translates); `{usage}` is injected
   * parser-grammar English in every locale.
   */
  'slash.usageLine': 'Usage: {usage}',
  /** Validation error + usage in ONE template (Spanish word order may move
   * the usage clause; the two placeholders are injected strings). */
  'slash.errorWithUsage': '{error} {usage}',

  // The v1 command set's one-line help texts (issue #99; English verbs per
  // the issue-#112 rename). Rendered by the /help overlay and the composer's
  // slash popup straight from SLASH_COMMANDS (getter-backed, live locale).
  'slash.nickHelp':
    'Changes your nickname (2–24 characters: letters, numbers, spaces, hyphens and underscores).',
  'slash.roomHelp': 'Joins a room by its name (normalized to lowercase with hyphens).',
  'slash.dmHelp': 'Opens an encrypted direct conversation with a peer.',
  'slash.meHelp': 'Sends an action: rendered in italics as "* nickname action".',
  'slash.roomsHelp': 'Lists the active rooms and their unread counts.',
  'slash.clearHelp': 'Clears the local history of this room (your browser only).',
  'slash.leaveHelp': 'Leaves the active room.',
  'slash.helpHelp': 'Shows this command list.',

  // -------------------------------------------------------------------------
  // files — P2P file transfer UI (issue #103, spec §12.4): the composer's
  // pre-send dialog, the consent/progress/result cards and the honest
  // terminal-state texts.
  // -------------------------------------------------------------------------

  /** Composer attachment button (accessible name; visible text is 'Attach'). */
  'files.attachLabel': 'Attach a file',
  /** The visible text of that button (phase 3). */
  'files.attachButton': 'Attach',
  /** Pre-send dialog accessible name (the Modal label). */
  'files.dialogLabel': 'Send a file',
  /** Visible text and accessible name of the styled file-picker affordance. */
  'files.pickLabel': 'Choose a file…',
  /** Recipient scope selector (room mode) accessible name. */
  'files.recipientLabel': 'Recipient',
  /** Recipient scope in DM mode: a fixed line (the peer cannot change). */
  'files.recipientDm': 'Recipient: {peerNick}',

  /** Pre-send encryption notices: room key (§9.3), DM key v2 (§9.2, always
   * sealed) and the §12.4 DTLS-only warning for public rooms (the exact
   * disclosure). */
  'files.encNoticeRoom':
    'It will be encrypted with the room key: only someone with the password will be able to read it.',
  'files.encNoticeDm': 'It will be encrypted end-to-end with this conversation’s DM key.',
  'files.encWarningPublic':
    'Public room: no E2E encryption — DTLS only. The content does not travel end-to-end encrypted.',

  /**
   * Card encryption lines. The wire cannot say whether the key is the room's
   * or the DM's (§12.4's one ambiguity — GCM resolves it per chunk), so
   * incoming cards stay honest with the generic sealed line; the clear line
   * is the public-room DTLS-only state.
   */
  'files.encStateSealed': 'End-to-end encrypted.',
  'files.encStateClear': 'No E2E encryption — DTLS only.',

  /** Dialog buttons. */
  'files.sendButton': 'Send file',

  /** Room mode with no connected peers: there is nobody to address the offer to. */
  'files.noPeers': 'No connected peers: there is no recipient for the offer.',
  /** Display-only placeholder when the File carries no mime (legitimate, §12.4). */
  'files.unknownMime': 'unknown type',

  /**
   * Inline refusals for the pre-send dialog, keyed by the engine's
   * SendFileRefusal: every local rejection surfaces with its own honest line
   * before anything hits the wire.
   */
  'files.refusalUnknownRoom': 'The room is no longer connected: the file cannot be sent.',
  'files.refusalNotConnected': 'No connection: the offer could not be sent.',
  'files.refusalPeerNotInRoom': 'The recipient is not connected to the room.',
  'files.refusalInvalidFile': 'The file is not valid.',
  'files.refusalFileTooBig': 'The file exceeds the 20 MB limit.',
  'files.refusalNameRequired': 'The file name is not valid.',
  'files.refusalConcurrencyCap':
    'The recipient already has 3 transfers in progress: wait for one to finish.',
  'files.refusalDmKeyUnavailable': 'No DM key available: the file never travels unencrypted.',
  'files.refusalKeyResolutionFailed': 'The encryption key could not be resolved: nothing was sent.',

  /** Transfer cards area accessible name (one region per room/DM view). */
  'files.cardsRegionLabel': 'File transfers',
  /** One card's accessible name, built from the file name and the peer nick. */
  'files.cardLabel': 'Transfer of {fileName}',
  'files.cardLabelWithPeer': 'Transfer of {fileName} with {peerNick}',

  /** Consent card (incoming offer): the question, with the sender's nick. */
  'files.offerText': '{peerNick} wants to send you a file:',
  /** Sender-side pending offer line (waiting for the peer's consent). */
  'files.offerPending': 'Offer sent: waiting for the peer to accept it.',

  /** In-flight lines, per direction; progress bar accessible name. */
  'files.progressSending': 'Sending…',
  'files.progressReceiving': 'Receiving…',
  'files.progressLabel': 'Transfer progress',

  /** Done card text, and the terminal declined/cancelled states. */
  'files.done': 'Completed',
  'files.rejected': 'Declined',
  'files.aborted': 'Cancelled',

  /** Failed-transfer lines per the engine's FileFailureReason (honest states). */
  'files.failureStall': 'Failed: the transfer stalled.',
  'files.failurePeerDrop': 'Failed: the peer has disconnected.',
  'files.failureRoomGone': 'Failed: the room has closed.',
  'files.failureSizeLimit': 'Failed: the file exceeds the allowed size.',
  'files.failureBadFrame': 'Failed: corrupt data was received.',
  'files.failureCrypto': 'Failed: the content could not be decrypted.',
  'files.failureCompleteness': 'Failed: the file arrived incomplete.',
  'files.failureIdentityRegenerated': 'Failed: the session identity was regenerated.',

  /** Download affordance on a done, non-image transfer (receiver side). */
  'files.downloadButton': 'Download',
  /** Dismiss control of a terminal card; revokes the object URL (§12.4). */
  'files.dismissButton': 'Dismiss',

  // -------------------------------------------------------------------------
  // qr — the QR invite (issue #100, ChatHeader 'QR' button → popover over
  // the share affordance). The QR encodes exactly buildRoomLink's output
  // (room name only, never the password — RF-05).
  // -------------------------------------------------------------------------

  /** Header entry button: accessible name and tooltip (visible text is 'QR'). */
  'qr.buttonLabel': 'Room QR code',
  /** Popover dialog accessible name (Modal label). */
  'qr.dialogLabel': 'Room QR code',
  /** Canvas role="img" label: describes what the QR encodes. */
  'qr.canvasLabel': 'QR code with the link of room {roomName}',
  /** Button that downloads the QR as a PNG file (also the contact QR). */
  'qr.downloadButton': 'Download PNG',
  /** Same-deployment disclosure (issue #100 Risks): a QR from another install joins nothing. */
  'qr.sameInstallNote': 'The QR links to this same installation.',

  // -------------------------------------------------------------------------
  // wizard — the trackerless manual-DM wizard (issue #97, spec §12.2):
  // sidebar entry points, the DmList marker and the two-role invite/answer
  // exchange. The «(no room)» marker is spec-frozen (stays literal English).
  // -------------------------------------------------------------------------

  /** Sidebar DM section entry button (visible text and accessible name). */
  'wizard.inviteEntry': '+ invite',
  /** Tooltip of the sidebar entry button. */
  'wizard.inviteEntryTitle':
    'Start a direct conversation without trackers by exchanging invitations',
  /** Tracker-error banner shortcut (visible text and accessible name). */
  'wizard.bannerShortcut': 'or connect without trackers',
  /** DmList marker on manual channels (spec §12.2: «(no room)») — stays literal. */
  'wizard.noRoomMarker': '(no room)',
  /** Tooltip explaining the DmList marker. */
  'wizard.noRoomTitle': 'Manually created conversation via invitation, without a room',

  /** Wizard dialog accessible name, role-pick intro and role buttons. */
  'wizard.label': 'Manual connection without trackers',
  'wizard.intro':
    'Create a direct conversation without trackers: you exchange two invitations over any channel (email, another messenger) and the connection is direct between you.',
  'wizard.roleInviteButton': 'Create invitation',
  'wizard.roleAnswerButton': 'Answer invitation',

  /** Exact §12.2 warning shown wherever a blob is displayed for copying. */
  'wizard.networkWarning': 'The invitation may contain information about your network',

  /** Role A — accessible name of the readonly textarea holding the invite blob. */
  'wizard.inviteBlobLabel': 'Your invitation: copy it and send it to your contact',
  /** Role B — accessible name of the paste textarea for A's invite. */
  'wizard.pasteInviteLabel': 'Paste here the invitation you were sent',
  /** Role B — button that validates the pasted invite and produces the answer. */
  'wizard.generateAnswerButton': 'Generate answer',
  /** Role A — accessible name of the paste textarea for B's answer. */
  'wizard.pasteAnswerLabel': 'Paste here your contact’s answer',
  /** Role A — button that validates the pasted answer and starts connecting. */
  'wizard.connectButton': 'Connect',

  /** Progress: the invite/answer is being generated (ICE gathering, §12.2). */
  'wizard.progressGenerating': 'Generating invitation…',
  /** Progress: waiting for the WebRTC handshake to finish. */
  'wizard.progressEstablishing': 'Establishing P2P channel…',
  /** Progress/connection status vocabulary (§10.3) reused at wizard connect
   * (the peer-counted header form lives in chat.connectedStatus…). */
  'wizard.progressConnected': 'P2P channel established',
  /** Retry control after a guard failure (visible error + retry, RNF-07). */
  'wizard.retryButton': 'Start over',

  /**
   * Inline errors for a rejected paste, keyed by the engine's ManualBlobError
   * reason (§12.2 validation order). The wizard stays open: the paste can be
   * corrected and retried.
   */
  'wizard.blobErrorEncoding': 'The pasted text is not a valid invitation.',
  'wizard.blobErrorVersion': 'The invitation uses an unknown format version.',
  'wizard.blobErrorRole': 'The pasted text is not of the expected type (invitation or answer).',
  'wizard.blobErrorKeys': 'The invitation contains invalid keys.',
  'wizard.blobErrorFingerprint':
    'The fingerprint does not match the key: the invitation is corrupt or tampered with.',
  'wizard.blobErrorSdp': 'The invitation contains an invalid connection description.',

  /** Inline errors for engine rejections beyond the blob parse. */
  'wizard.peerErrorBadBlob': 'The pasted text is not a valid answer for this invitation.',
  'wizard.peerErrorFingerprintMismatch': 'The answer’s fingerprint does not match the expected one.',
  'wizard.peerErrorConnectTimeout': 'The connection was not established in time. Try again.',
  'wizard.peerErrorIllegalTransition': 'The wizard is no longer in the expected state. Start over.',
  'wizard.peerErrorNotConnected': 'The channel is not connected.',
  'wizard.peerErrorTooLong': 'The message exceeds the 4000-character limit.',

  // -------------------------------------------------------------------------
  // contact — the global-DM contact flow (issue #105, spec §12.5): the
  // Privacy opt-in toggle, the DmList «+ contact» entry, the «My contact»
  // share screen (fingerprint + QR via the #100 machinery) and the «Contact
  // by fingerprint» knock flow, plus the inbound consent card. The «(global)»
  // marker is spec-frozen (§12.5, stays literal English).
  // -------------------------------------------------------------------------

  /** Privacy tab — the global-DM opt-in toggle (Settings → Privacy). */
  'contact.toggleLabel': 'Global DM channel',
  /**
   * Privacy tab — the honest §9.5 disclosure under the toggle: what joining
   * exposes, what the off-by-default mitigation means, and that leaving is
   * instant. Also the hint that explains where the «+ contact» entries come
   * from while the setting is off.
   */
  'contact.toggleHint':
    'Opt-in: turning it on puts you in a public, well-known swarm where every peer with the setting active can see your IP, your fingerprint and your nickname, and knock you by fingerprint to open a DM with you. Off by default; turning it off leaves the swarm instantly and closes its channels. The sidebar’s ‘+ contact’ entries only appear while the channel is active.',

  /** Sidebar DM section entry (visible text and accessible name), sibling of «+ invite». */
  'contact.entry': '+ contact',
  /** Tooltip of the sidebar entry button. */
  'contact.entryTitle':
    'Share your fingerprint (‘My contact’) or knock another peer by fingerprint (‘Contact by fingerprint’)',

  /** DmList marker on signal-swarm channels (issue #105, spec §12.5: «(global)»)
   * — stays literal English. */
  'contact.globalMarker': '(global)',
  /** Tooltip explaining the global-DM DmList marker. */
  'contact.globalMarkerTitle':
    'Direct conversation opened by fingerprint through the global channel (opt-in)',

  /** Contact dialog accessible name (the Modal label) and pick-screen intro
   * (the manual-wizard intro precedent). */
  'contact.dialogLabel': 'Contact by fingerprint',
  'contact.intro':
    'The global channel connects two fingerprints without a shared room: both sides must have it enabled in Settings → Privacy. It carries no messages: only knocks, and the conversation starts when the other side accepts.',

  /** Pick-screen buttons: share YOUR fingerprint, or knock by pasted fingerprint. */
  'contact.shareButton': 'My contact',
  'contact.knockEntryButton': 'Contact by fingerprint',

  // Share screen («My contact»).
  /** Accessible name of the readonly field holding the own fingerprint. */
  'contact.fpLabel': 'Your identity fingerprint: copy it and send it to your contact',
  /** Canvas role="img" label: describes what the QR encodes (the #100 wording). */
  'contact.qrCanvasLabel': 'QR code with your contact link',

  // Knock screen («Contact by fingerprint»).
  /** Intro line: what a knock is and what it needs (presence on the swarm). */
  'contact.knockIntro':
    'Paste your contact’s fingerprint: if they are present on the global channel they will receive your knock and decide whether to accept. While you wait, you can add an optional note.',
  /** Accessible name of the paste textarea for the peer's fingerprint. */
  'contact.knockPasteLabel': 'Paste here your contact’s fingerprint',
  /** Accessible name of the optional note textarea (capped at 140 chars). */
  'contact.knockNoteLabel': 'Optional note for your knock',
  /** Character counter of the note field (aria-live). */
  'contact.noteCounter': '{length}/140',
  /** Button that validates the pasted fingerprint and knocks. */
  'contact.knockSendButton': 'Send knock',
  /** Progress: the knock is out, waiting for the peer's consent (live region). */
  'contact.knockWaiting': 'Knock sent: waiting for an answer…',
  /** Inline terminal state when the peer answered knock-ack(false). */
  'contact.knockRejected': 'Declined: the peer has not accepted your contact.',
  /** Inline error for a paste that is not a fingerprint (the local form check). */
  'contact.fpInvalid':
    'That is not a valid fingerprint: it must be 8 groups of 4 hexadecimal characters.',

  /** Inline errors for a typed KnockError rejection, keyed by its reason. */
  'contact.knockErrorSignalOff': 'The global channel is disabled: enable it in Settings → Privacy.',
  'contact.knockErrorPeerNotPresent':
    'That fingerprint is not present on the global channel right now.',
  'contact.knockErrorInvalid': 'The knock is not valid: check the fingerprint and the note.',

  /** Back control to the pick screen (both screens keep the dialog open). */
  'contact.backButton': 'Back',

  // Inbound consent card (the «door» rendered wherever the user is).
  /** The card's question line (the exact §12.5 shape, with the sender's nick). */
  'contact.knockConsent': '@{nick} wants to open a DM with you',
  /** Accessible name of one consent card region. */
  'contact.knockCardLabel': 'Contact request from @{nick}',
  /** Accessible name of the consent-cards strip (one region, N cards). */
  'contact.knockCardsRegionLabel': 'Contact requests',
  /** Prefix of the optional note line rendered on the card. */
  'contact.knockNotePrefix': 'Note: ',

  /** Phase 3 — the share screen's empty-session guard (no identity yet). */
  'contact.noIdentity': 'No identity in this session.',

  // -------------------------------------------------------------------------
  // panic — the panic-button flow (RF-08, Privacy tab): the red entry button
  // (its label doubles as both dialog titles and the final confirm label),
  // the last-resort note above it and the two confirmation bodies. Phase 3
  // namespace; the double confirmation order is the component's, not this
  // dictionary's.
  // -------------------------------------------------------------------------

  'panic.buttonLabel': 'Wipe everything and leave',
  'panic.lastResortNote':
    'Last resort: wipes the nickname, keys, settings and every local trace in this browser.',
  'panic.dialogBody': 'Nickname, keys, settings and every local trace will be wiped. Continue?',
  'panic.finalDialogBody':
    'This action is definitive: every connection will be closed and the app will reload to start from scratch.',

  // -------------------------------------------------------------------------
  // onboarding — first-visit onboarding (RF-01, spec §10.2): the tagline, the
  // nickname form and its hints. Phase 3 namespace. The placeholder's
  // 'zorro-bravo' example is DATA (an English-wordlist pair, like anything
  // `generateNickname` may produce) — only the surrounding label translates.
  // -------------------------------------------------------------------------

  /** The pitch under the typographic logo. */
  'onboarding.tagline':
    'No server, no accounts: your messages travel directly between browsers and disappear on reload.',
  /** The form's accessible name (historically lowercase — kept verbatim). */
  'onboarding.formAria': 'enter',
  /** The nickname field: label (shared `common.yourNickname` for the visible
   * label) and the example placeholder. */
  'onboarding.nicknamePlaceholder': 'e.g. zorro-bravo',
  /** The two actions: the random generator and the submit. */
  'onboarding.surpriseButton': 'surprise me',
  'onboarding.enterButton': 'Enter →',
  /** Join hints: the #lobby auto-join note and the '#room' deep-link note
   * (prefix/suffix around the mono-styled '#{name}' token). */
  'onboarding.lobbyHint':
    'You will join #lobby automatically; from the sidebar you can join other rooms.',
  'onboarding.linkedRoomPrefix': 'You will join the room',
  'onboarding.linkedRoomSuffix': 'from the shared link.',
  /** Web Crypto unavailable (non-secure context): the honest inline error. */
  'onboarding.insecureContextError': 'Could not create the local identity (insecure context).',

  // -------------------------------------------------------------------------
  // notifications — desktop notifications (spec §10.5/RF-09): the exact
  // §10.5 title/body formats. Only two triggers exist: a room mention and an
  // incoming DM; both fire for hidden tabs only.
  // -------------------------------------------------------------------------

  /** §10.5 — exact DM title format. */
  'notifications.dmTitle': 'gritos — DM from {nick}',
  /** §10.5 — exact mention title format. */
  'notifications.mentionTitle': 'gritos — mention in #{room}',
  /** §10.5 — exact body format. */
  'notifications.body': '{nick}: {text}',

  // -------------------------------------------------------------------------
  // errors — generic error lines.
  // -------------------------------------------------------------------------

  'errors.unknown': 'Unknown error',

  /** RF-01 — inline validation message for an invalid nickname. */
  'errors.nicknameInvalid':
    'Use 2 to 24 characters: letters, numbers, spaces, hyphens and underscores.',

  /**
   * Issue #38/#119 — the top-level crash fallback (ErrorBoundary), the
   * phase-3 census's one missed surface. Consumed through plain `t`: a
   * class component cannot call the `useT` hook, so the fallback reads the
   * live locale snapshot once per render without subscribing — while
   * crashed nothing re-renders on a locale switch, and the crash screen's
   * only way out is the reload, which re-mounts everything in the chosen
   * locale anyway.
   */
  'errors.crashTitle': 'Something went wrong',
  'errors.crashBody': 'An unexpected error occurred. Reload the page to start over.',
  'errors.crashReload': 'Reload',

  /**
   * Phase 3 — the engine-thrown rejections that surface verbatim in the UI
   * (JoinRoomPopover/ChatLayout alert lines, the /room and /nick system
   * lines). They interpolate the offending value; the templates here are the
   * single source (roomManager throws through `t`, locale-live at throw
   * time). Note the distinction: `errors.nicknameInvalid` is the RULE text,
   * `errors.invalidNickname` the quoted-value rejection.
   */
  'errors.roomLimitReached': 'Active room limit reached ({count})',
  'errors.roomNameInvalid': 'Invalid room name: "{name}"',
  'errors.invalidNickname': 'Invalid nickname: "{nickname}"',

  /**
   * §10.3/RF-05 — a password room that exhausted the error heuristic without
   * finding any peer shows the single not-found message (wrong password and
   * nonexistent room are indistinguishable by design, so one wording covers
   * both). Rendered by roomStatusText.
   */
  'errors.roomNotFound': 'Room #{name} not found with that password',
} as const

/** Every legal dictionary key — the flat dotted literal union above. */
export type TranslationKey = keyof typeof en

/** One complete dictionary: every `en` key present, string-valued. */
export type Translations = Record<TranslationKey, string>
