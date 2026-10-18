/**
 * Schema validation for the persisted `gritos:settings` payload (issue #29).
 *
 * `settingsStorage.getItem` used to spread the raw parsed JSON over the
 * defaults with zero checks, so a corrupted store (or a future
 * settings-import feature) could push `maxActiveRooms: 1e9`, junk tracker
 * strings or arbitrary `iceServers` objects straight into Trystero's
 * `rtcConfig` → `RTCPeerConnection`. Each field is now checked
 * independently: the valid parts of a record survive and everything else
 * falls back to the documented defaults (spec §8.1). The pass is total and
 * never throws — every `new URL` parse is wrapped in try/catch.
 * Issue #30: when `rememberTurnCredentials` resolves to false, TURN
 * `credential` fields are dropped on load as well — a stale record written
 * before the toggle existed (or by a careless import) must not survive
 * rehydration once remembering is off. Issue #95: the local-moderation mute
 * list rides in the same record (spec §8.2: no sixth `gritos:*` key); its
 * entries must match the canonical fingerprint form and a list over the cap
 * is rejected wholesale instead of silently truncated. Issue #102: the
 * history-gossip consent flag joins the boolean pass — type-checked like
 * `notifications`/`rememberRooms`, defaulting to silence. Issue #105: the
 * global-DM opt-in flag joins the same boolean pass, defaulting to off
 * (joining the signal swarm is a visible privacy decision, spec §12.5).
 * Issue #119: the UI language joins the enum pass like `theme` — only
 * 'en'/'es'/'auto' survive verbatim, anything else falls back to 'auto'
 * (follow the browser). Issue #132: the signaling transport swapped from
 * `@trystero-p2p/torrent` to `@trystero-p2p/nostr`, so "trackers" now means
 * Nostr relay `wss://` URLs. The persisted `Settings` field keeps its
 * historical `trackers` name for storage compatibility — renaming it would
 * orphan the value inside every existing `gritos:` record already on disk
 * and break every store consumer — while the relay rule itself is unchanged.
 * The five WebTorrent default tracker URLs (`LEGACY_WEBTORRENT_TRACKERS`)
 * are evicted from any stored or imported list: they are BitTorrent tracker
 * servers and must never receive Nostr NIP-01 signaling traffic, and an
 * evicted-to-[] list falls back to `@trystero-p2p/nostr`'s
 * `defaultRelayUrls`. `relays` is accepted as an INPUT alias for the same
 * list (`record.trackers` wins when it is an array, `record.relays`
 * otherwise) so exported or hand-written settings that speak the new
 * vocabulary hydrate correctly; the alias feeds the identical
 * validation + eviction pass.
 */

import { canonicalFingerprint } from './crypto/dm'
import type { LanguageSetting } from '../i18n/index'
import type { Settings, ThemeChoice } from '../stores/useAppStore'

/** RF-02 active-room cap, enforced by the NetworkTab UI (1–6). */
export const MIN_ACTIVE_ROOMS = 1
export const MAX_ACTIVE_ROOMS = 6

/** Issue #95 — mute-list cap: at most 100 muted fingerprints. */
export const MAX_MUTED_FINGERPRINTS = 100

/** §8.1 — the only theme values the app knows (RF-10). */
const THEMES: readonly ThemeChoice[] = ['light', 'dark', 'system']

/**
 * Issue #119 — the only UI-language values the app knows.
 */
const LANGUAGES: readonly LanguageSetting[] = ['en', 'es', 'auto']

/**
 * Issue #132 — the five `wss://` defaults baked into the retired
 * `@trystero-p2p/torrent` transport (Trystero 0.25.4's `defaultRelayUrls`).
 * They are BitTorrent tracker servers, not Nostr relays: after the #132
 * transport swap, a stale `gritos:settings` record or an imported settings
 * file still carrying them would aim Nostr NIP-01 signaling traffic at
 * servers that cannot speak it and must never receive it. Every occurrence
 * is therefore evicted during normalization; when the whole list was only
 * legacy trackers the result is `[]`, which is itself the documented default
 * and activates `@trystero-p2p/nostr`'s own `defaultRelayUrls`. The eviction
 * is surgical: any other user-configured `wss://` relay survives untouched.
 */
export const LEGACY_WEBTORRENT_TRACKERS: readonly string[] = [
  'wss://open.ftorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
]

/**
 * Comparison key for the legacy-tracker blocklist. Hosts are
 * case-insensitive per the URL spec (the parser already lowercases them)
 * and are lowercased again here as belt-and-braces; paths are lowercased
 * too — over-evicting a differently-cased path on a blocklisted BitTorrent
 * host is harmless, while under-evicting would leak signaling traffic. The
 * empty path of a bare-host URL (`wss://open.ftorrent.com`) and its
 * trailing-slash form are the same key.
 */
function legacyTrackerKey(url: URL): string {
  const path = url.pathname === '' ? '/' : url.pathname
  return `${url.host.toLowerCase()}${path.toLowerCase()}`
}

/** The blocklist pre-parsed into comparison keys (all five parse cleanly). */
const LEGACY_TRACKER_KEYS: ReadonlySet<string> = new Set(
  LEGACY_WEBTORRENT_TRACKERS.flatMap((entry) => {
    const url = parseUrl(entry)
    return url === null ? [] : [legacyTrackerKey(url)]
  }),
)

/** `new URL` that yields null instead of throwing (never trust the store). */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Relay rule (issue #132: "trackers" now means Nostr relays): parses as a
 * URL, `wss:` scheme, something after it. The rule itself predates the
 * transport swap and is unchanged — WebTorrent's `wss://` trackers and
 * Nostr's relays happen to share the same shape, so the migration only had
 * to add the blocklist eviction below.
 */
function isValidTrackerUrl(value: string): boolean {
  const url = parseUrl(value.trim())
  return url !== null && url.protocol === 'wss:' && url.href !== url.protocol
}

/**
 * Exported alias for the relay rule, named for what the list means since
 * issue #132 (Nostr relays) rather than for the persisted `trackers` field
 * name. Both names delegate to the identical rule; nothing else about it
 * changed. See the module docblock for why the field name stays `trackers`.
 */
export function isValidRelayUrl(value: string): boolean {
  return isValidTrackerUrl(value)
}

/**
 * Issue #132 — true when the entry is one of the retired WebTorrent default
 * trackers (see `LEGACY_WEBTORRENT_TRACKERS`). Compared on the parsed
 * host+path key so a trimmed, differently-cased or trailing-slash spelling
 * of the same BitTorrent server is still evicted; see `legacyTrackerKey`.
 */
function isLegacyWebTorrentTracker(value: string): boolean {
  const url = parseUrl(value.trim())
  return url !== null && LEGACY_TRACKER_KEYS.has(legacyTrackerKey(url))
}

/**
 * Keeps only well-formed `wss://` relay URLs, trimmed, with the legacy
 * WebTorrent trackers evicted (issue #132). The eviction is surgical: a
 * user-configured relay like `wss://relay.damus.io` survives untouched, and
 * a list that was only legacy trackers normalizes to `[]` — which lets
 * `@trystero-p2p/nostr`'s `defaultRelayUrls` take over.
 */
function normalizeTrackers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && isValidTrackerUrl(entry))
    .map((entry) => entry.trim())
    .filter((entry) => !isLegacyWebTorrentTracker(entry))
}

const ICE_PROTOCOLS: readonly string[] = ['stun:', 'turn:', 'turns:']

/** ICE rule: parses as a URL, stun/turn(s) scheme, something after it. */
function isValidIceUrl(value: string): boolean {
  const url = parseUrl(value.trim())
  return url !== null && ICE_PROTOCOLS.includes(url.protocol) && url.href !== url.protocol
}

/**
 * Rebuilds one ICE entry from the only fields gritos understands (§6.3):
 * `urls` as a string or string array of stun:/turn:/turns: URLs, plus
 * optional string `username`/`credential`. Any other key (or shape) is
 * dropped so nothing unvetted reaches `RTCPeerConnection`. Issue #30: the
 * `credential` only survives when the caller keeps credentials.
 */
function normalizeIceServer(raw: unknown, keepCredentials: boolean): RTCIceServer | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const rawUrls: unknown = record.urls
  const candidates: readonly unknown[] = Array.isArray(rawUrls) ? rawUrls : [rawUrls]
  if (candidates.length === 0) return null
  const urls: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isValidIceUrl(candidate)) return null
    urls.push(candidate.trim())
  }
  const server: RTCIceServer = { urls: urls.length === 1 ? urls[0] : urls }
  if (typeof record.username === 'string') server.username = record.username
  if (keepCredentials && typeof record.credential === 'string') {
    server.credential = record.credential
  }
  return server
}

function normalizeIceServers(raw: unknown, keepCredentials: boolean): RTCIceServer[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => normalizeIceServer(entry, keepCredentials))
    .filter((server): server is RTCIceServer => server !== null)
}

function normalizeMaxActiveRooms(raw: unknown, fallback: Settings): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback.maxActiveRooms
  return Math.min(MAX_ACTIVE_ROOMS, Math.max(MIN_ACTIVE_ROOMS, Math.trunc(raw)))
}

/**
 * Issue #95 — canonical fingerprint rule: after `canonicalFingerprint`
 * (whitespace stripped, uppercased — the same normalizer the DM derivation
 * and the TOFU pin comparison run) the value must be exactly 32 hex chars,
 * i.e. the 8×4 display groups concatenated. Both the spaced display form
 * and the compact form are accepted, in either hex case.
 */
export function isValidFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-F]{32}$/.test(canonicalFingerprint(value))
}

/**
 * Issue #95 — keeps only well-formed entries of the persisted mute list,
 * deduplicated and in canonical form. A list over MAX_MUTED_FINGERPRINTS
 * unique entries cannot be produced by the app (the store helper refuses
 * the 101st), so it is corrupt or hostile: it is rejected wholesale —
 * falling back to [] — rather than silently evicting user mutes.
 */
function normalizeMutedFingerprints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const muted = raw
    .filter((entry): entry is string => isValidFingerprint(entry))
    .map((entry) => canonicalFingerprint(entry))
  const unique = [...new Set(muted)]
  return unique.length > MAX_MUTED_FINGERPRINTS ? [] : unique
}

/**
 * Issue #30 — shallow-copies each ICE entry without its `credential`
 * (`urls`/`username` and any other field survive). Used on the persist path
 * when `rememberTurnCredentials` is off so the stored `gritos:settings`
 * JSON never carries TURN secrets.
 */
export function stripIceCredentials(servers: readonly RTCIceServer[]): RTCIceServer[] {
  return servers.map((server) => {
    const copy = { ...server }
    delete copy.credential
    return copy
  })
}

/**
 * Validates a parsed `gritos:settings` value against the `Settings` schema.
 * Non-object payloads (corrupt shape, `"[]"`, `42`, `null`, arrays) come
 * back as fresh defaults; objects are validated field by field and unknown
 * keys never survive. `fallback` supplies the documented defaults (spec
 * §8.1) so this module stays a pure helper with no store dependency.
 * Issue #30: `rememberTurnCredentials` is resolved first so the ICE pass
 * can honor it — with the toggle off, rehydrated `credential` fields are
 * dropped (see the module comment above).
 */
export function normalizeSettings(raw: unknown, fallback: Settings): Settings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const record = raw as Record<string, unknown>
  const rememberTurnCredentials =
    typeof record.rememberTurnCredentials === 'boolean'
      ? record.rememberTurnCredentials
      : fallback.rememberTurnCredentials
  // Issue #132 — `relays` input alias: the persisted field name stays
  // `trackers` for storage compatibility (a rename would orphan the value in
  // every existing `gritos:settings` record and break every store consumer),
  // but exported/hand-written settings may already speak the new relay
  // vocabulary. Precedence: `record.trackers` wins when it is an array,
  // `record.relays` is used when the trackers field is not an array, and
  // anything else falls back to `normalizeTrackers`' [] default. Both inputs
  // run through the identical validation + legacy-eviction pass.
  const rawRelayList: unknown = Array.isArray(record.trackers)
    ? record.trackers
    : Array.isArray(record.relays)
      ? record.relays
      : undefined
  return {
    autoJoinLobby:
      typeof record.autoJoinLobby === 'boolean' ? record.autoJoinLobby : fallback.autoJoinLobby,
    trackers: normalizeTrackers(rawRelayList),
    iceServers: normalizeIceServers(record.iceServers, rememberTurnCredentials),
    maxActiveRooms: normalizeMaxActiveRooms(record.maxActiveRooms, fallback),
    theme: THEMES.includes(record.theme as ThemeChoice)
      ? (record.theme as ThemeChoice)
      : fallback.theme,
    notifications:
      typeof record.notifications === 'boolean' ? record.notifications : fallback.notifications,
    rememberRooms:
      typeof record.rememberRooms === 'boolean' ? record.rememberRooms : fallback.rememberRooms,
    rememberTurnCredentials,
    mutedFingerprints: normalizeMutedFingerprints(record.mutedFingerprints),
    shareHistory:
      typeof record.shareHistory === 'boolean' ? record.shareHistory : fallback.shareHistory,
    globalDm: typeof record.globalDm === 'boolean' ? record.globalDm : fallback.globalDm,
    language: LANGUAGES.includes(record.language as LanguageSetting)
      ? (record.language as LanguageSetting)
      : fallback.language,
  }
}
