/**
 * Friendly es-ES nickname generator — spec RF-01: 'adjetivo-sustantivo'
 * format (e.g. 'zorro-bravo', 'luna-cauta'). Implemented in M2 with the
 * word lists and their tests.
 */

export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 24

/** Random 'adjetivo-sustantivo' nickname, valid per isValidNickname. */
export function generateNickname(): string {
  throw new Error('not implemented: nickname generator lands in M2 (RF-01)')
}

/** 2–24 chars: letters, numbers, spaces, hyphens, underscores (RF-01). */
export function isValidNickname(_nickname: string): boolean {
  throw new Error('not implemented: nickname validation lands in M2 (RF-01)')
}
