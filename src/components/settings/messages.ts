/**
 * Exact Spanish wording of the settings validation messages (RF-07) —
 * shared by the tabs and their tests so the spec strings live in one place.
 */

export const TRACKER_ERROR_TEXT = 'Las URLs de tracker deben empezar por wss://'
export const ICE_ERROR_TEXT = 'Los servidores ICE deben empezar por stun: o turn:'
export const MAX_ROOMS_ERROR_TEXT = 'El límite de salas activas debe estar entre 1 y 6.'

export const EMPTY_TRACKERS_HINT = 'Lista vacía: se usan los trackers por defecto de Trystero.'
export const EMPTY_ICE_HINT = 'Lista vacía: se usa la configuración ICE por defecto de Trystero.'
export const RECONNECT_NOTE = 'Los cambios de red se aplican al reconectar las salas.'

/**
 * Issue #30 — persistent-storage disclosure shown next to the TURN
 * credential fields while `rememberTurnCredentials` is on. Shared by the
 * Red tab and the Privacidad at-rest note.
 */
export const TURN_CREDENTIAL_STORAGE_HINT =
  'Las credenciales TURN se guardan sin cifrar en este navegador.'

/** Issue #30 — shown while «Recordar credenciales TURN» is off. */
export const TURN_CREDENTIAL_MEMORY_HINT =
  'Las credenciales TURN solo se guardan en memoria y se pierden al cerrar la pestaña.'
