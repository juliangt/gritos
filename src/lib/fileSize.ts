/**
 * Issue #103 phase 4 — human-readable file sizes for the pre-send dialog
 * and the transfer cards. Display-only: the engine's byte counts stay the
 * source of truth everywhere else.
 */

/** 700 → '700 B'; 16 356 → '16.0 KB'; 5 MB → '5.0 MB' (one decimal). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
