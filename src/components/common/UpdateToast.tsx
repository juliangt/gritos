import { useEffect, useState } from 'react'
import { onUpdateReady } from '../../lib/pwa/registerSw'
import { useT } from '../../i18n/index'

/**
 * Update toast (issue #104, phase 4): mounted once at App level, it shows
 * «New version available — [Reload]» while a service worker waits
 * behind this page (a deployed new version), per the registerSw module's
 * waiting-worker detection. Reload calls location.reload(), which
 * dismisses the old client so the waiting worker activates and the
 * activate-time cache cleanup runs; dismissing is session-only component
 * state — nothing persists, so the toast naturally reappears on the next
 * visit if the update was never applied, and a NEWER waiting worker (a
 * further deploy while the page stays open) notifies afresh — the same
 * per-occurrence dismissal rule as the NetworkErrorBanner. role="status"
 * like every other inline-status surface of the app (§10.3's vocabulary):
 * polite, non-blocking, never modal — the chat keeps flowing while the
 * toast waits in the corner.
 */
export function UpdateToast() {
  const t = useT()
  const [visible, setVisible] = useState(false)

  // Subscribe for the lifetime of the mount; onUpdateReady returns the
  // unsubscribe (and delivers a detection that happened before this effect).
  useEffect(() => onUpdateReady(() => setVisible(true)), [])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-label={t('common.updateToastLabel')}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 border border-border bg-surface px-3 py-2 text-xs shadow-lg"
    >
      <p className="min-w-0 flex-1 text-muted">{t('common.updateAvailable')}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:border-accent"
      >
        {t('common.updateReload')}
      </button>
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label={t('common.updateToastDismiss')}
        title={t('common.updateToastDismiss')}
        className="shrink-0 rounded px-1 text-muted hover:text-text"
      >
        ✕
      </button>
    </div>
  )
}
