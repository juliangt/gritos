import { useState } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useRoomManager } from '../../hooks/useRoomManager'
import {
  EMPTY_ICE_HINT,
  EMPTY_TRACKERS_HINT,
  ICE_ERROR_TEXT,
  MAX_ROOMS_ERROR_TEXT,
  RECONNECT_NOTE,
  TRACKER_ERROR_TEXT,
  TURN_CREDENTIAL_MEMORY_HINT,
  TURN_CREDENTIAL_STORAGE_HINT,
} from './messages'
import { Toggle } from './Toggle'

/**
 * Red tab (RF-07): auto-join, custom trackers (wss://), ICE servers
 * (stun:/turn: with TURN credentials), the 1–6 active-room cap and the
 * "Reconectar todo" note + button that applies the settings via
 * reconnectAll(). Valid values persist instantly; invalid ones show the
 * inline Spanish error and are not saved. Issue #30: a toggle decides
 * whether TURN credentials persist in this browser — off keeps them
 * session-only (memory), and both states carry a Spanish disclosure.
 */

/** wss:// scheme + something after it. */
function isValidTrackerUrl(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('wss://') && trimmed.length > 'wss://'.length
}

/** stun:/turn: scheme + something after it. */
function isValidIceUrl(value: string): boolean {
  const trimmed = value.trim()
  return (
    (trimmed.startsWith('stun:') || trimmed.startsWith('turn:')) &&
    trimmed.length > 'stun:'.length
  )
}

interface IceRow {
  kind: 'stun' | 'turn'
  url: string
  username: string
  credential: string
}

function rowsFromSettings(servers: readonly RTCIceServer[]): IceRow[] {
  return servers.map((server) => {
    const url = typeof server.urls === 'string' ? server.urls : ''
    return {
      kind: url.startsWith('turn:') ? ('turn' as const) : ('stun' as const),
      url,
      username: server.username ?? '',
      credential: typeof server.credential === 'string' ? server.credential : '',
    }
  })
}

function rowsToSettings(rows: readonly IceRow[]): RTCIceServer[] {
  return rows
    .filter((row) => row.url.trim() !== '' && isValidIceUrl(row.url))
    .map((row) =>
      row.kind === 'turn'
        ? { urls: row.url.trim(), username: row.username, credential: row.credential }
        : { urls: row.url.trim() },
    )
}

export function NetworkTab() {
  const settings = useSettingsStore((state) => state.settings)
  const setSettings = useSettingsStore((state) => state.setSettings)
  // Never bootstraps an identity; reconnect-all acts on the session only.
  const { reconnectAll } = useRoomManager({ ensureIdentity: false })

  // Draft lists: valid values commit to the store on every change; invalid
  // ones stay in the draft and surface the inline error instead.
  const [trackerDraft, setTrackerDraft] = useState<string[]>(settings.trackers)
  const [iceDraft, setIceDraft] = useState<IceRow[]>(() => rowsFromSettings(settings.iceServers))
  const [maxRoomsDraft, setMaxRoomsDraft] = useState(String(settings.maxActiveRooms))
  const [maxRoomsError, setMaxRoomsError] = useState<string | null>(null)

  const trackerError =
    trackerDraft.some((url) => url.trim() !== '' && !isValidTrackerUrl(url)) === true
      ? TRACKER_ERROR_TEXT
      : null
  const iceError =
    iceDraft.some((row) => row.url.trim() !== '' && !isValidIceUrl(row.url)) === true
      ? ICE_ERROR_TEXT
      : null

  const updateTrackerRow = (index: number, value: string): void => {
    const next = trackerDraft.map((url, i) => (i === index ? value : url))
    setTrackerDraft(next)
    if (next.every((url) => url.trim() === '' || isValidTrackerUrl(url))) {
      setSettings({
        trackers: next.map((url) => url.trim()).filter((url) => url !== ''),
      })
    }
  }

  const addTrackerRow = (): void => setTrackerDraft([...trackerDraft, ''])

  const removeTrackerRow = (index: number): void => {
    const next = trackerDraft.filter((_, i) => i !== index)
    setTrackerDraft(next)
    if (next.every((url) => url.trim() === '' || isValidTrackerUrl(url))) {
      setSettings({ trackers: next.map((url) => url.trim()).filter((url) => url !== '') })
    }
  }

  const updateIceRow = (index: number, patch: Partial<IceRow>): void => {
    const next = iceDraft.map((row, i) => (i === index ? { ...row, ...patch } : row))
    setIceDraft(next)
    if (next.every((row) => row.url.trim() === '' || isValidIceUrl(row.url))) {
      setSettings({ iceServers: rowsToSettings(next) })
    }
  }

  const addIceRow = (): void =>
    setIceDraft([...iceDraft, { kind: 'stun', url: 'stun:', username: '', credential: '' }])

  const removeIceRow = (index: number): void => {
    const next = iceDraft.filter((_, i) => i !== index)
    setIceDraft(next)
    if (next.every((row) => row.url.trim() === '' || isValidIceUrl(row.url))) {
      setSettings({ iceServers: rowsToSettings(next) })
    }
  }

  const updateMaxRooms = (raw: string): void => {
    setMaxRoomsDraft(raw)
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 6) {
      setMaxRoomsError(MAX_ROOMS_ERROR_TEXT)
      return
    }
    setMaxRoomsError(null)
    setSettings({ maxActiveRooms: parsed })
  }

  const blurMaxRooms = (): void => {
    const parsed = Number.parseInt(maxRoomsDraft, 10)
    const clamped = Number.isNaN(parsed) ? 4 : Math.min(6, Math.max(1, parsed))
    setMaxRoomsDraft(String(clamped))
    setMaxRoomsError(null)
    setSettings({ maxActiveRooms: clamped })
  }

  return (
    <div className="flex flex-col gap-4">
      <Toggle
        label="Auto-unirse a #lobby al iniciar"
        checked={settings.autoJoinLobby}
        onChange={(autoJoinLobby) => setSettings({ autoJoinLobby })}
      />

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Trackers personalizados</legend>
        {trackerDraft.length === 0 && <p className="text-xs text-muted">{EMPTY_TRACKERS_HINT}</p>}
        {trackerDraft.map((url, index) => (
          <div key={index} className="flex items-center gap-1">
            <input
              type="url"
              value={url}
              placeholder="wss://tracker.ejemplo:443"
              aria-label={`Tracker ${index + 1}`}
              aria-invalid={url.trim() !== '' && !isValidTrackerUrl(url)}
              onChange={(event) => updateTrackerRow(index, event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs focus:border-accent"
            />
            <button
              type="button"
              aria-label={`Eliminar tracker ${index + 1}`}
              title="Eliminar tracker"
              onClick={() => removeTrackerRow(index)}
              className="rounded px-1.5 py-1 text-xs text-muted hover:bg-bg hover:text-text"
            >
              ✕
            </button>
          </div>
        ))}
        {trackerError !== null && (
          <p role="alert" className="text-xs text-accent">
            {trackerError}
          </p>
        )}
        <button
          type="button"
          onClick={addTrackerRow}
          className="self-start rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        >
          Añadir tracker
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Servidores ICE (STUN/TURN)</legend>
        {iceDraft.length === 0 && <p className="text-xs text-muted">{EMPTY_ICE_HINT}</p>}
        {iceDraft.map((row, index) => (
          <div key={index} className="flex flex-col gap-1 rounded-md border border-border p-2">
            <div className="flex items-center gap-1">
              <select
                value={row.kind}
                aria-label={`Tipo de servidor ICE ${index + 1}`}
                onChange={(event) =>
                  updateIceRow(index, {
                    kind: event.target.value === 'turn' ? 'turn' : 'stun',
                    url: event.target.value === 'turn' ? 'turn:' : 'stun:',
                  })
                }
                className="rounded-md border border-border bg-surface px-1 py-1 text-xs"
              >
                <option value="stun">STUN</option>
                <option value="turn">TURN</option>
              </select>
              <input
                type="text"
                value={row.url}
                placeholder="stun:host:puerto"
                aria-label={`URL del servidor ICE ${index + 1}`}
                aria-invalid={row.url.trim() !== '' && !isValidIceUrl(row.url)}
                onChange={(event) => updateIceRow(index, { url: event.target.value })}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs focus:border-accent"
              />
              <button
                type="button"
                aria-label={`Eliminar servidor ICE ${index + 1}`}
                title="Eliminar servidor ICE"
                onClick={() => removeIceRow(index)}
                className="rounded px-1.5 py-1 text-xs text-muted hover:bg-bg hover:text-text"
              >
                ✕
              </button>
            </div>
            {row.kind === 'turn' && (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={row.username}
                  placeholder="usuario"
                  aria-label={`Usuario TURN ${index + 1}`}
                  autoComplete="off"
                  onChange={(event) => updateIceRow(index, { username: event.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs focus:border-accent"
                />
                <input
                  type="password"
                  value={row.credential}
                  placeholder="contraseña"
                  aria-label={`Contraseña TURN ${index + 1}`}
                  autoComplete="new-password"
                  onChange={(event) => updateIceRow(index, { credential: event.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs focus:border-accent"
                />
              </div>
            )}
          </div>
        ))}
        {/* Issue #30: persistent-storage disclosure next to the TURN
            credential fields; the memory-only wording takes over while the
            remember toggle is off (it then lives under the checkbox). */}
        {settings.rememberTurnCredentials && iceDraft.some((row) => row.kind === 'turn') && (
          <p className="text-xs text-muted">{TURN_CREDENTIAL_STORAGE_HINT}</p>
        )}
        {iceError !== null && (
          <p role="alert" className="text-xs text-accent">
            {iceError}
          </p>
        )}
        <button
          type="button"
          onClick={addIceRow}
          className="self-start rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
        >
          Añadir servidor ICE
        </button>
      </fieldset>

      <Toggle
        label="Recordar credenciales TURN en este navegador"
        checked={settings.rememberTurnCredentials}
        hint={settings.rememberTurnCredentials ? undefined : TURN_CREDENTIAL_MEMORY_HINT}
        onChange={(rememberTurnCredentials) => setSettings({ rememberTurnCredentials })}
      />

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="max-active-rooms">
          Límite de salas activas
        </label>
        <input
          id="max-active-rooms"
          type="number"
          min={1}
          max={6}
          value={maxRoomsDraft}
          aria-invalid={maxRoomsError !== null}
          onChange={(event) => updateMaxRooms(event.target.value)}
          onBlur={blurMaxRooms}
          className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm focus:border-accent"
        />
        {maxRoomsError !== null && (
          <p role="alert" className="text-xs text-accent">
            {maxRoomsError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">{RECONNECT_NOTE}</p>
        <button
          type="button"
          onClick={() => void reconnectAll()}
          className="self-start rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:opacity-90"
        >
          Reconectar todo
        </button>
      </div>
    </div>
  )
}
