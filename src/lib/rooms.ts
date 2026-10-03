/**
 * Room-list helpers shared by the sidebar (RF-02). Kept out of component
 * files so they stay unit-testable and eslint react-refresh-clean.
 */

/** Spec RF-02 / §10.1 — suggested rooms offered in the sidebar. */
export const SUGGESTED_ROOMS: readonly string[] = ['lobby', 'general', 'dev', 'random']

/** RF-02 — inline validation message for a non-normalizable room name. */
export const INVALID_ROOM_NAME_TEXT =
  'Solo minúsculas, números, guiones y guion bajo (1–32 caracteres)'
