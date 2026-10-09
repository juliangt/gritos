import type { Translations } from './en'

/**
 * Issue #119 — Spanish dictionary, compile-pinned to the English keys:
 * `Translations = Record<TranslationKey, string>` makes a missing or extra
 * key a `tsc -b` error, so the two dictionaries can never drift apart.
 * Phase-1 seed mirrors of ./en (the phrasing is refined in phase 4, once
 * the real copy has moved in). Placeholders (`{what}`, `{count}`) keep the
 * exact `en` tokens — `t` fills them the same way in both languages.
 */
export const es: Translations = {
  'common.cancel': 'Cancelar',
  'common.copy': 'Copiar',
  'common.copied': 'Copiado',
  'common.copiedWith': 'Copiado {what}',
  'common.peerCountOne': '{count} par',
  'common.peerCountOther': '{count} pares',
  'errors.unknown': 'Error desconocido',
}
