/**
 * Friendly English nickname generator — spec RF-01: friendly hyphenated
 * nicknames such as 'fox-bold' or 'moon-wary' (noun-adjective, the exact
 * shape of the RF-01/§10.2 examples, English wordlists per issue #121).
 * Two curated lowercase ascii lists (~60 entries each). The GENERATED
 * nicknames are protocol data (they travel in envelopes and are matched
 * case-insensitively), not UI copy — deliberately NOT localized.
 */

export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 24

/** Nouns — the first half of the nickname. */
export const NICKNAME_NOUNS: readonly string[] = [
  'fox',
  'moon',
  'dune',
  'lynx',
  'falcon',
  'deer',
  'badger',
  'kite',
  'river',
  'ridge',
  'mist',
  'fog',
  'oak',
  'willow',
  'trout',
  'thrush',
  'eagle',
  'alder',
  'maple',
  'heather',
  'cedar',
  'comet',
  'condor',
  'summit',
  'island',
  'cliff',
  'lighthouse',
  'gulf',
  'beech',
  'bramble',
  'iris',
  'jaguar',
  'league',
  'sea',
  'mount',
  'snow',
  'wave',
  'moor',
  'pearl',
  'pine',
  'ray',
  'salt',
  'meadow',
  'wind',
  'ivy',
  'bee',
  'dawn',
  'bay',
  'dragon',
  'estuary',
  'hawk',
  'ice',
  'rockrose',
  'lake',
  'tide',
  'north',
  'ocean',
  'puma',
  'sage',
  'swift',
]

/** Adjectives — the second half of the nickname. */
export const NICKNAME_ADJECTIVES: readonly string[] = [
  'bold',
  'wary',
  'serene',
  'docile',
  'fierce',
  'solitary',
  'loyal',
  'gentle',
  'daring',
  'still',
  'timid',
  'slight',
  'faint',
  'agile',
  'slow',
  'swift',
  'kind',
  'misty',
  'silent',
  'curious',
  'errant',
  'cold',
  'grave',
  'honest',
  'just',
  'free',
  'mature',
  'noble',
  'tawny',
  'lukewarm',
  'rough',
  'brief',
  'candid',
  'sweet',
  'elusive',
  'firm',
  'graceful',
  'deep',
  'crisp',
  'autumnal',
  'pale',
  'remote',
  'subtle',
  'tardy',
  'shady',
  'green',
  'fleet',
  'hoarse',
  'plain',
  'wild',
  'aloof',
  'talkative',
  'terse',
  'lonely',
  'prudent',
  'fragile',
  'humble',
  'restless',
  'rugged',
  'stealthy',
  'taciturn',
]

/**
 * Nickname charset (RF-01): letters (accents included), numbers,
 * spaces, hyphens and underscores. Validated on the normalized form
 * (trimmed, whitespace runs collapsed), length 2–24.
 */
const NICKNAME_PATTERN = /^[a-z0-9áéíóúñüA-Z0-9ÁÉÍÓÚÑÜ_ -]{2,24}$/u

/** Trims and collapses whitespace runs into single spaces (RF-01). */
export function normalizeNickname(nickname: string): string {
  return nickname.trim().replace(/\s+/g, ' ')
}

/**
 * Issue #28 — Unicode Cc control characters plus the invisible-spoofing
 * extras (soft hyphen, zero-width spaces/joiners, bidi marks and overrides,
 * BOM). A remote-supplied nick carrying these would poison Peer.nickname,
 * author/system feed lines and notification titles. Exported since issue
 * #103 (spec §12.4): remote file names and mimes get the SAME character
 * class (with their own length caps) at the fileTransfer boundary.
 */
export const REMOTE_NICK_INVISIBLE_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g

/**
 * Issue #28 — boundary sanitizer for REMOTE-supplied nicknames (envelope
 * `nick`, presence payloads): strips control/invisible characters, trims and
 * caps the length at NICKNAME_MAX_LENGTH (oversized input is capped, never
 * rejected). The local RF-01 charset is deliberately NOT enforced — legit
 * peers may use other scripts; the goal is control characters and gigantism,
 * not cultural names (homoglyphs are out of scope). Returns null when
 * nothing legible remains, so the caller keeps its peerId-prefix display
 * fallback.
 */
export function sanitizeRemoteNick(nickname: string): string | null {
  const cleaned = nickname.replace(REMOTE_NICK_INVISIBLE_PATTERN, '').trim()
  if (cleaned === '') return null
  return cleaned.slice(0, NICKNAME_MAX_LENGTH)
}

/** 2–24 chars: letters, numbers, spaces, hyphens, underscores (RF-01). */
export function isValidNickname(nickname: string): boolean {
  return NICKNAME_PATTERN.test(normalizeNickname(nickname))
}

let lastGenerated: string | null = null

function pick(list: readonly string[]): string {
  const index = crypto.getRandomValues(new Uint32Array(1))[0] % list.length
  return list[index] as string
}

/**
 * Random 'noun-adjective' nickname (e.g. 'fox-bold'), always valid
 * per isValidNickname. Guaranteed not to repeat the immediately previous
 * draw, so consecutive calls always differ.
 */
export function generateNickname(): string {
  let candidate = `${pick(NICKNAME_NOUNS)}-${pick(NICKNAME_ADJECTIVES)}`
  for (let attempt = 0; attempt < 8 && candidate === lastGenerated; attempt += 1) {
    candidate = `${pick(NICKNAME_NOUNS)}-${pick(NICKNAME_ADJECTIVES)}`
  }
  lastGenerated = candidate
  return candidate
}

/**
 * RF-01 — inline validation for an invalid nickname. Issue #119 phase 3 —
 * the LEGACY SHIM is gone: the wording lives in `src/i18n/en.ts` under
 * `errors.nicknameInvalid`, and every consumer (OnboardingScreen, the
 * settings modal, /nick's executor line) resolves it through live `t()`
 * calls. This module imports no i18n at all: it sits on the import cycle
 * i18n → settings store → lib/crypto/dm → lib/p2p/protocol →
 * lib/nickname → i18n, and no nickname-module code needs translated text.
 */

/**
 * RF-06 — duplicate-nickname disambiguation: when two or more peers in the
 * same view share a nickname, each shows a short peerId suffix
 * ('fox-bold·a3f1'); unique nicknames render as-is.
 */
export function disambiguatedNickname(
  nickname: string,
  peerId: string,
  peers: ReadonlyArray<{ id: string; nickname: string }>,
): string {
  const duplicates = peers.filter((peer) => peer.nickname === nickname)
  if (duplicates.length < 2) return nickname
  return `${nickname}·${peerId.slice(-4)}`
}
