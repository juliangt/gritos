import { useState, type FormEvent } from 'react'
import { NicknameInput } from './NicknameInput'
import {
  generateNickname,
  isValidNickname,
  normalizeNickname,
  NICKNAME_ERROR_TEXT,
} from '../../lib/nickname'
import { useRoomManager } from '../../hooks/useRoomManager'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useAppStore } from '../../stores/useAppStore'

/**
 * First-visit onboarding (RF-01, spec §10.2): centered screen over the
 * theme background with the typographic logo, the nickname field, the
 * 'sorpréndeme' generator and the 'Entrar →' action. Entering persists the
 * identity profile and — when `autoJoinLobby` is on — joins #lobby, which
 * becomes the initial active view. The chat layout takes over as soon as
 * the store holds an identity.
 */
export function OnboardingScreen() {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [entering, setEntering] = useState(false)
  const { enterWithNickname, joinRoomFocused } = useRoomManager({
    // The identity is created on 'Entrar' with the chosen nickname; an
    // anonymous ephemeral identity must not be generated on mount.
    ensureIdentity: false,
  })
  const autoJoinLobby = useSettingsStore((state) => state.settings.autoJoinLobby)

  const surprise = () => {
    setValue(generateNickname())
    setError(null)
  }

  const enter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (entering) return

    // Empty field → random valid nickname (RF-01 acceptance).
    const normalized = normalizeNickname(value)
    const nickname = normalized === '' ? generateNickname() : normalized
    if (!isValidNickname(nickname)) {
      setError(NICKNAME_ERROR_TEXT)
      return
    }

    setEntering(true)
    try {
      await enterWithNickname(nickname)
      if (useSettingsStore.getState().settings.autoJoinLobby) {
        await joinRoomFocused('lobby')
      }
      // Identity in the store switches App to the chat layout.
      if (useAppStore.getState().identity === null) setEntering(false)
    } catch {
      // Web Crypto unavailable (non-secure context): stay and explain.
      setError('No se pudo crear la identidad local (contexto no seguro).')
      setEntering(false)
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 py-12">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-5xl font-bold tracking-tight">gritos</h1>
        <p className="max-w-md text-center text-sm text-muted">
          Sin servidor, sin cuentas: tus mensajes viajan directos entre navegadores y desaparecen al
          recargar.
        </p>
      </div>

      <form
        aria-label="entrada"
        onSubmit={(event) => void enter(event)}
        className="flex w-full max-w-sm flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm font-medium">
          Tu apodo
          <NicknameInput
            value={value}
            onValueChange={(next) => {
              setValue(next)
              setError(null)
            }}
            error={error}
            disabled={entering}
          />
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={surprise}
            disabled={entering}
            className="rounded-md border border-border px-3 py-2 text-sm hover:border-accent disabled:opacity-50"
          >
            sorpréndeme
          </button>
          <button
            type="submit"
            disabled={entering}
            className="ml-auto rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-text disabled:opacity-50"
          >
            Entrar →
          </button>
        </div>
        {autoJoinLobby && (
          <p className="text-center text-xs text-muted">
            Entrarás en #lobby automáticamente; desde la barra lateral podrás unirte a otras salas.
          </p>
        )}
      </form>
    </main>
  )
}
