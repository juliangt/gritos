/**
 * Issue #119 — i18n source of truth (English).
 *
 * Every user-facing string in gritos eventually lives here, keyed by flat
 * dotted literals with one namespace per surface (later phases move the
 * copy in, surface by surface — this file ships only the seed):
 *
 *   common.*        shared verbs/labels reused across surfaces
 *   settings.*      the settings modal
 *   feed.*          room feed rows and separators
 *   dm.*            direct-message surfaces
 *   sidebar.*       the room/DM sidebar
 *   chat.*          the chat header/composer
 *   slash.*         slash-command docs and feedback
 *   files.*         file-transfer UI
 *   qr.*            the QR share overlay
 *   wizard.*        the manual-DM wizard
 *   contact.*       the contact/invite surface
 *   onboarding.*    first-visit onboarding
 *   notifications.* desktop notification bodies
 *   panic.*         the panic-button confirmations
 *   errors.*        generic error lines
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
 */

/**
 * The English dictionary. Phase-1 seed only: real keys the i18n machinery
 * itself exercises (shared verbs, one interpolation pair, one plural pair,
 * the generic error) that later phases reuse as-is.
 */
export const en = {
  'common.cancel': 'Cancel',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  /** Interpolation seed: `{what}` is filled from `t` params. */
  'common.copiedWith': 'Copied {what}',
  /** Plural seed — `tPlural('common.peerCount', n)` picks the right form. */
  'common.peerCountOne': '{count} peer',
  'common.peerCountOther': '{count} peers',
  'errors.unknown': 'Unknown error',
} as const

/** Every legal dictionary key — the flat dotted literal union above. */
export type TranslationKey = keyof typeof en

/** One complete dictionary: every `en` key present, string-valued. */
export type Translations = Record<TranslationKey, string>
