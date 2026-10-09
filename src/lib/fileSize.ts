import { getLocale } from '../i18n/index'

/**
 * Issue #103 phase 4 — human-readable file sizes for the pre-send dialog
 * and the transfer cards. Display-only: the engine's byte counts stay the
 * source of truth everywhere else. Issue #119: the decimal separator
 * follows the app locale ('16,0 KB' under es) — no new import cycle, the
 * i18n runtime imports nothing from this module.
 */

/** 700 → '700 B'; 16 356 → '16.0 KB'; 5 MB → '5.0 MB' (one decimal). */
export function formatFileSize(bytes: number): string {
  const decimalSeparator = getLocale() === 'es' ? ',' : '.'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1).replace('.', decimalSeparator)} KB`
  return `${(kb / 1024).toFixed(1).replace('.', decimalSeparator)} MB`
}
