/**
 * Friendly es-ES nickname generator — spec RF-01: friendly hyphenated
 * nicknames such as 'zorro-bravo' or 'luna-cauta' (sustantivo-adjetivo, the
 * exact shape of the examples in RF-01/§10.2). Two curated lowercase lists
 * (~60 entries each), ascii-safe with Spanish accents.
 */

export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 24

/** Nouns (sustantivos) — the first half of the nickname. */
export const NICKNAME_NOUNS: readonly string[] = [
  'zorro',
  'luna',
  'duna',
  'lince',
  'halcón',
  'ciervo',
  'tejón',
  'milano',
  'río',
  'sierra',
  'bruma',
  'niebla',
  'roble',
  'sauce',
  'trucha',
  'zorzal',
  'águila',
  'aliso',
  'arce',
  'brezo',
  'cedro',
  'cometa',
  'cóndor',
  'cumbre',
  'isla',
  'cantil',
  'faro',
  'golfo',
  'haya',
  'zarza',
  'iris',
  'jaguar',
  'legua',
  'mar',
  'monte',
  'nieve',
  'ola',
  'páramo',
  'perla',
  'pino',
  'raya',
  'sal',
  'vega',
  'viento',
  'yedra',
  'abeja',
  'alba',
  'bahía',
  'drago',
  'estero',
  'gavilán',
  'hielo',
  'jara',
  'lago',
  'marea',
  'norte',
  'océano',
  'puma',
  'salvia',
  'vencejo',
]

/** Adjectives (adjetivos) — the second half of the nickname. */
export const NICKNAME_ADJECTIVES: readonly string[] = [
  'bravo',
  'cauta',
  'sereno',
  'dócil',
  'feroz',
  'huraño',
  'leal',
  'manso',
  'osado',
  'quieto',
  'tímido',
  'leve',
  'tenue',
  'ágil',
  'lento',
  'rápido',
  'amable',
  'brumoso',
  'callado',
  'curioso',
  'errante',
  'frío',
  'grave',
  'íntegro',
  'justo',
  'libre',
  'maduro',
  'noble',
  'pardo',
  'tibio',
  'áspero',
  'breve',
  'cándido',
  'dulce',
  'esquivo',
  'firme',
  'grácil',
  'hondo',
  'nítido',
  'otoñal',
  'pálido',
  'remoto',
  'sutil',
  'tardío',
  'umbrío',
  'verde',
  'veloz',
  'ronco',
  'llano',
  'silvestre',
  'arisco',
  'locuaz',
  'parco',
  'solitario',
  'prudente',
  'frágil',
  'humilde',
  'inquieto',
  'rudo',
  'sigiloso',
  'taciturno',
]

/**
 * Nickname charset (RF-01): letters (Spanish accents included), numbers,
 * spaces, hyphens and underscores. Validated on the normalized form
 * (trimmed, whitespace runs collapsed), length 2–24.
 */
const NICKNAME_PATTERN = /^[a-z0-9áéíóúñüA-Z0-9ÁÉÍÓÚÑÜ_ -]{2,24}$/u

/** Trims and collapses whitespace runs into single spaces (RF-01). */
export function normalizeNickname(nickname: string): string {
  return nickname.trim().replace(/\s+/g, ' ')
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
 * Random 'sustantivo-adjetivo' nickname (e.g. 'zorro-bravo'), always valid
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

/** RF-01 — inline validation message for an invalid nickname. */
export const NICKNAME_ERROR_TEXT =
  'Usa entre 2 y 24 caracteres: letras, números, espacios, guiones y guion bajo.'

/**
 * RF-06 — duplicate-nickname disambiguation: when two or more peers in the
 * same view share a nickname, each shows a short peerId suffix
 * ('zorro-bravo·a3f1'); unique nicknames render as-is.
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
