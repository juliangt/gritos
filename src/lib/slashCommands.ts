/**
 * Slash-command parser (issue #99, Phase 1): pure grammar for the composer's
 * `/` commands — no DOM, no React, no store/manager imports.
 *
 * Executor contract (Phases 2–3): `parseSlashCommand` classifies composer
 * input into a discriminated result the executor dispatches on without
 * re-parsing:
 *
 * - `null` — not a slash command: the normal chat send path.
 * - `kind: 'command'` — known verb with parse-level validation already
 *   applied: the payload is the canonical form (RF-01 nickname, RF-02 room
 *   name, trimmed /dm target, end-trimmed /me action). Dispatch on `verb`.
 * - `kind: 'error'` — known verb, rejected arguments; the executor prints a
 *   local system line. `error` says why, `arg` carries the trimmed raw input
 *   for quoting; wording reuses the owning libs (NICKNAME_ERROR_TEXT,
 *   INVALID_ROOM_NAME_TEXT) plus the row's usage (`slashUsageText`).
 * - `kind: 'unknown'` — leading '/' with a verb outside the table: the input
 *   is NEVER sent; the UI hints "Unknown command — /help".
 * - `kind: 'literal'` — `\/` escape hatch: the composer strips the backslash
 *   and sends `text` as a normal chat message.
 *
 * Verbs are lowercase-only by design (English UI, documented, not
 * localized): '/NICK' is an unknown verb. Zero-argument commands are strict:
 * any argument is an 'extra-args' error, never silently ignored. Whitespace
 * runs between verb and arguments are skipped and arguments are end-trimmed;
 * internal whitespace survives for /me and is folded by the domain rules for
 * /nick (RF-01: runs collapse to one space) and /room (RF-02: runs → '-').
 *
 * VERBS (issue #112, Phase 1 — clean break): the pre-release rename of the
 * original Spanish command verbs to their English counterparts keeps NO
 * Spanish aliases — the app has no released users, so there is no
 * compatibility burden to carry. English is the primary language of the
 * table: usage and help strings below are the shipped copy.
 *
 * Help and usage strings live in this table rather than settings/messages.ts
 * (superseding the Phase-4 note in the issue): the command table is
 * protocol-adjacent grammar data owned by the parser module, and the /help
 * overlay renders straight from SLASH_COMMANDS.
 */

import { isValidNickname, normalizeNickname } from './nickname'

/** Argument grammar of a command row. */
export type SlashArity =
  /** No arguments; anything else is an 'extra-args' error. */
  | 'none'
  /** One logical value given as the rest of the line (domain-normalized). */
  | 'value'
  /** The rest of the line, end-trimmed, internal whitespace preserved. */
  | 'rest'

export interface SlashCommandDef {
  /** Loose on purpose: the concrete literals live in the SLASH_COMMANDS rows. */
  readonly verb: string
  readonly arity: SlashArity
  /** Argument shape shown by /help and in usage errors, e.g. '/nick <name>'. */
  readonly usage: string
  /** One-line English help text (feeds the /help overlay). */
  readonly help: string
}

/**
 * The v1 command set (issue #99), in /help display order. Kept as a plain
 * tuple so `SlashVerb` derives from it and the parser switch stays
 * exhaustive over the real rows.
 */
export const SLASH_COMMANDS = [
  {
    verb: 'nick',
    arity: 'value',
    usage: '/nick <name>',
    help: 'Changes your nickname (2–24 characters: letters, numbers, spaces, hyphens and underscores).',
  },
  {
    verb: 'room',
    arity: 'value',
    usage: '/room <name>',
    help: 'Joins a room by its name (normalized to lowercase with hyphens).',
  },
  {
    verb: 'dm',
    arity: 'value',
    usage: '/dm <nick>',
    help: 'Opens an encrypted direct conversation with a peer.',
  },
  {
    verb: 'me',
    arity: 'rest',
    usage: '/me <action>',
    help: 'Sends an action: rendered in italics as "* nickname action".',
  },
  {
    verb: 'rooms',
    arity: 'none',
    usage: '/rooms',
    help: 'Lists the active rooms and their unread counts.',
  },
  {
    verb: 'clear',
    arity: 'none',
    usage: '/clear',
    help: 'Clears the local history of this room (your browser only).',
  },
  {
    verb: 'leave',
    arity: 'none',
    usage: '/leave',
    help: 'Leaves the active room.',
  },
  {
    verb: 'help',
    arity: 'none',
    usage: '/help',
    help: 'Shows this command list.',
  },
] as const satisfies readonly SlashCommandDef[]

/** Every verb the grammar knows, derived from the table. */
export type SlashVerb = (typeof SLASH_COMMANDS)[number]['verb']

/** A concrete table row (literal verb) — what the parser switches on. */
type SlashCommandEntry = (typeof SLASH_COMMANDS)[number]

/** Why a known command's arguments were rejected at parse level. */
export type SlashArgError =
  /** The grammar requires an argument and none was given (/nick /room /dm /me). */
  | 'missing-arg'
  /** An argument was given to a zero-argument command (strict arity). */
  | 'extra-args'
  /** The /nick argument fails the RF-01 nickname rules. */
  | 'invalid-nick'
  /** The /room argument cannot be normalized under RF-02. */
  | 'invalid-room'

/**
 * The discriminated parse result. The `command` payloads already carry the
 * canonical argument form, so the executor never re-parses; `error.arg`
 * preserves the trimmed raw input for error-line wording.
 */
export type SlashCommand =
  | { kind: 'command'; verb: 'nick'; nickname: string }
  | { kind: 'command'; verb: 'room'; room: string }
  | { kind: 'command'; verb: 'dm'; nick: string }
  | { kind: 'command'; verb: 'me'; action: string }
  | { kind: 'command'; verb: 'help' | 'rooms' | 'clear' | 'leave' }
  | { kind: 'error'; verb: SlashVerb; error: SlashArgError; arg: string }
  | { kind: 'unknown'; verb: string }
  | { kind: 'literal'; text: string }

/**
 * RF-02 room-name rule, character-for-character the same as
 * lib/p2p/roomManager.normalizeRoomName (trim + lowercase + whitespace runs
 * → '-', then 1–32 chars of [a-z0-9_-]). Deliberately NOT imported: this
 * module must stay free of the manager/trystero graph, so the two-line rule
 * is copied here and tests/slashCommands.test.ts asserts both stay in
 * lockstep. Error-line wording lives in lib/rooms INVALID_ROOM_NAME_TEXT.
 */
const ROOM_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

function normalizeRoomArg(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
  return ROOM_NAME_PATTERN.test(normalized) ? normalized : null
}

/**
 * Table lookup for the executor (the /help overlay, usage lines, the
 * unknown-command hint). Undefined for anything outside the table.
 */
export function getSlashCommandDef(verb: string): SlashCommandDef | undefined {
  return SLASH_COMMANDS.find((entry) => entry.verb === verb)
}

/** 'Usage: /nick <name>' — prefix for arity and validation error lines. */
export function slashUsageText(verb: SlashVerb): string {
  const def = getSlashCommandDef(verb)
  return `Usage: ${def?.usage ?? `/${verb}`}`
}

/**
 * Verb immediately after the '/', then one whitespace run, then the rest of
 * the line ([\s\S] so a newline cannot smuggle a second command past the
 * anchor). '/' alone and '/ <args>' match nothing: a command attempt with no
 * verb → unknown.
 */
const SLASH_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/

/**
 * Classifies composer input (leading '/' must be the FIRST character — the
 * composer decides whether to trim before calling). Returns null for plain
 * chat text; every slash-shaped input yields a non-null result, so unknown
 * verbs can be blocked from sending with an inline hint.
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  // Escape hatch first: '\/' prefixes a literal message ('\/hola' sends
  // '/hola'; a bare '\/' sends '/') and wins over any command shape. Only
  // the backslash form escapes — '//' is just an unknown verb, and a '\'
  // elsewhere is ordinary text.
  if (input.startsWith('\\/')) return { kind: 'literal', text: input.slice(1) }
  if (!input.startsWith('/')) return null
  const match = SLASH_PATTERN.exec(input)
  if (match === null) return { kind: 'unknown', verb: '' }
  const verb = match[1] ?? ''
  const def: SlashCommandEntry | undefined = SLASH_COMMANDS.find((entry) => entry.verb === verb)
  // Lowercase-only verbs: any other casing falls through as unknown.
  if (def === undefined) return { kind: 'unknown', verb }
  return commandResult(def, (match[2] ?? '').trim())
}

function commandResult(def: SlashCommandEntry, rawArgs: string): SlashCommand {
  switch (def.verb) {
    case 'nick': {
      if (rawArgs === '') {
        return { kind: 'error', verb: 'nick', error: 'missing-arg', arg: '' }
      }
      const nickname = normalizeNickname(rawArgs)
      if (!isValidNickname(nickname)) {
        return { kind: 'error', verb: 'nick', error: 'invalid-nick', arg: rawArgs }
      }
      return { kind: 'command', verb: 'nick', nickname }
    }
    case 'room': {
      if (rawArgs === '') {
        return { kind: 'error', verb: 'room', error: 'missing-arg', arg: '' }
      }
      const room = normalizeRoomArg(rawArgs)
      if (room === null) {
        return { kind: 'error', verb: 'room', error: 'invalid-room', arg: rawArgs }
      }
      return { kind: 'command', verb: 'room', room }
    }
    case 'dm':
      // No RF-01 gate: remote nicks are boundary-sanitized, not charset-
      // checked (a peer may legitimately be '漢字テスト'); matching against
      // live peers is the executor's job. Whitespace-only → missing arg.
      if (rawArgs === '') {
        return { kind: 'error', verb: 'dm', error: 'missing-arg', arg: '' }
      }
      return { kind: 'command', verb: 'dm', nick: rawArgs }
    case 'me':
      // Rest-of-line: ends trimmed here, internal whitespace preserved (it
      // is action prose, not a validated token).
      if (rawArgs === '') {
        return { kind: 'error', verb: 'me', error: 'missing-arg', arg: '' }
      }
      return { kind: 'command', verb: 'me', action: rawArgs }
    case 'help':
    case 'rooms':
    case 'clear':
    case 'leave':
      // Strict arity: an argument to a zero-arg command is a typo, never
      // silently ignored.
      if (rawArgs !== '') {
        return { kind: 'error', verb: def.verb, error: 'extra-args', arg: rawArgs }
      }
      return { kind: 'command', verb: def.verb }
  }
}
