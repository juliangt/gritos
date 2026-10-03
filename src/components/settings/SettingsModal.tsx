import { useState, type FormEvent } from 'react'
import { Modal } from '../common/Modal'
import { useRoomManager } from '../../hooks/useRoomManager'
import {
  isValidNickname,
  normalizeNickname,
  NICKNAME_ERROR_TEXT,
} from '../../lib/nickname'
import { useAppStore } from '../../stores/useAppStore'
import { AppearanceTab } from './AppearanceTab'
import { NetworkTab } from './NetworkTab'
import { PrivacyTab } from './PrivacyTab'

/**
 * Settings modal (RF-07, RNF-05): three tabs — Red / Privacidad /
 * Apariencia — inside a focus-trapped modal that closes with Esc, the ✕
 * button or a backdrop click, and restores focus to the opener. Every
 * change persists to its store instantly (spec: "Todos los cambios se
 * guardan en localStorage al instante"). The nickname field at the top of
 * the modal applies on blur/Enter with the RF-01 validation, persists the
 * §8.2 identity record and re-announces presence (RF-01).
 */

type SettingsTab = 'network' | 'privacy' | 'appearance'

export type { SettingsTab }

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'network', label: 'Red' },
  { id: 'privacy', label: 'Privacidad' },
  { id: 'appearance', label: 'Apariencia' },
]

export function SettingsModal(props: {
  open: boolean
  onClose: () => void
  /** Tab shown on open (defaults to Red — M6 network-error banner shortcut). */
  initialTab?: SettingsTab
}) {
  // The content mounts only while open, so its drafts and tab start fresh
  // on every open without any reset effects.
  if (!props.open) return null
  return (
    <Modal
      open
      onClose={props.onClose}
      label="Ajustes"
      className="flex max-h-[90vh] w-full max-w-md flex-col rounded-lg border border-border bg-surface p-4 outline-none"
    >
      <SettingsModalContent initialTab={props.initialTab ?? 'network'} onClose={props.onClose} />
    </Modal>
  )
}

function SettingsModalContent(props: { initialTab: SettingsTab; onClose: () => void }) {
  const identity = useAppStore((state) => state.identity)
  // The settings modal only MUTATES an existing session (nickname,
  // regeneration, reconnect): it must never bootstrap an identity as a
  // side effect of being opened.
  const { changeNickname } = useRoomManager({ ensureIdentity: false })
  const [activeTab, setActiveTab] = useState<SettingsTab>(props.initialTab)
  const [nicknameDraft, setNicknameDraft] = useState(identity?.nickname ?? '')
  const [nicknameError, setNicknameError] = useState<string | null>(null)

  const applyNickname = (): void => {
    const normalized = normalizeNickname(nicknameDraft)
    if (normalized === '') {
      setNicknameDraft(identity?.nickname ?? '')
      setNicknameError(null)
      return
    }
    if (!isValidNickname(normalized)) {
      setNicknameError(NICKNAME_ERROR_TEXT)
      return
    }
    setNicknameError(null)
    if (normalized !== identity?.nickname) {
      changeNickname(normalized)
    }
    setNicknameDraft(normalized)
  }

  const submitNickname = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    applyNickname()
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Ajustes</h2>
        <button
          type="button"
          aria-label="Cerrar ajustes"
          onClick={props.onClose}
          className="rounded px-1.5 py-1 text-sm text-muted hover:bg-bg hover:text-text"
        >
          ✕
        </button>
      </div>

      <form
        aria-label="Cambiar apodo"
        onSubmit={submitNickname}
        className="mt-3 flex flex-col gap-1"
      >
        <label className="text-xs font-medium text-muted" htmlFor="settings-nickname">
          Tu apodo
        </label>
        <div className="flex items-center gap-1">
          <input
            id="settings-nickname"
            value={nicknameDraft}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={nicknameError !== null}
            onChange={(event) => {
              setNicknameDraft(event.target.value)
              setNicknameError(null)
            }}
            onBlur={applyNickname}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm focus:border-accent"
          />
          <button
            type="submit"
            className="shrink-0 rounded-md border border-border px-2 py-1.5 text-xs hover:border-accent"
          >
            Guardar apodo
          </button>
        </div>
        {nicknameError !== null && (
          <p role="alert" className="text-xs text-accent">
            {nicknameError}
          </p>
        )}
      </form>

      <div
        role="tablist"
        aria-label="Secciones de ajustes"
        className="mt-3 flex gap-1 border-b border-border"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={
              activeTab === tab.id
                ? 'rounded-t-md border-b-2 border-accent px-3 py-1.5 text-sm font-semibold'
                : 'rounded-t-md border-b-2 border-transparent px-3 py-1.5 text-sm text-muted hover:text-text'
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        aria-label={TABS.find((tab) => tab.id === activeTab)?.label}
        className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1"
      >
        {activeTab === 'network' && <NetworkTab />}
        {activeTab === 'privacy' && <PrivacyTab />}
        {activeTab === 'appearance' && <AppearanceTab />}
      </div>
    </>
  )
}
