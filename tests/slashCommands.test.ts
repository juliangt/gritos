import { describe, expect, it } from 'vitest'
import { normalizeRoomName } from '../src/lib/p2p/roomManager'
import {
  getSlashCommandDef,
  parseSlashCommand,
  slashUsageText,
  SLASH_COMMANDS,
} from '../src/lib/slashCommands'

/** /room view of the parser: the normalized room, or null when rejected. */
function roomOf(rawArg: string): string | null {
  const result = parseSlashCommand(`/room ${rawArg}`)
  if (result === null || result.kind !== 'command' || result.verb !== 'room') return null
  return result.room
}

describe('parseSlashCommand — non-command input', () => {
  it('returns null for plain chat text, including the empty string', () => {
    expect(parseSlashCommand('hola')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand('¿probamos? /help')).toBeNull()
  })

  it('requires the slash to be the first character', () => {
    expect(parseSlashCommand(' /nick')).toBeNull()
    expect(parseSlashCommand('\t/help')).toBeNull()
  })

  it('leaves backslashes that are not the escape untouched', () => {
    expect(parseSlashCommand('\\')).toBeNull()
    expect(parseSlashCommand('\\hola')).toBeNull()
    expect(parseSlashCommand('\\\\hola')).toBeNull() // double backslash
    expect(parseSlashCommand('hola \\/ mundo')).toBeNull() // inner escape is chat text
  })
})

describe('parseSlashCommand — escape hatch (\\/ prefix)', () => {
  it('strips the backslash and marks the rest as a literal message', () => {
    expect(parseSlashCommand('\\/hola')).toEqual({ kind: 'literal', text: '/hola' })
    expect(parseSlashCommand('\\/nick x')).toEqual({ kind: 'literal', text: '/nick x' })
  })

  it('a bare \\/ sends a single slash', () => {
    expect(parseSlashCommand('\\/')).toEqual({ kind: 'literal', text: '/' })
  })

  it('keeps every following backslash verbatim', () => {
    expect(parseSlashCommand('\\/a\\/b')).toEqual({ kind: 'literal', text: '/a\\/b' })
  })
})

describe('parseSlashCommand — unknown verbs (never sent)', () => {
  it('returns a typed unknown result carrying the verb', () => {
    expect(parseSlashCommand('/foo bar baz')).toEqual({ kind: 'unknown', verb: 'foo' })
    expect(parseSlashCommand('/nick2 x')).toEqual({ kind: 'unknown', verb: 'nick2' })
  })

  it('treats a lone slash, and space before the verb, as an empty unknown verb', () => {
    expect(parseSlashCommand('/')).toEqual({ kind: 'unknown', verb: '' })
    expect(parseSlashCommand('/ ')).toEqual({ kind: 'unknown', verb: '' })
    expect(parseSlashCommand('/   hola')).toEqual({ kind: 'unknown', verb: '' })
  })

  it('does not treat // as an escape: it is just an unknown verb', () => {
    expect(parseSlashCommand('//hola')).toEqual({ kind: 'unknown', verb: '/hola' })
  })

  it('is lowercase-only: uppercased verbs are unknown (English UI, not localized)', () => {
    expect(parseSlashCommand('/NICK x')).toEqual({ kind: 'unknown', verb: 'NICK' })
    expect(parseSlashCommand('/Help')).toEqual({ kind: 'unknown', verb: 'Help' })
  })
})

describe('parseSlashCommand — happy paths for every verb', () => {
  it('parses the zero-argument commands', () => {
    expect(parseSlashCommand('/help')).toEqual({ kind: 'command', verb: 'help' })
    expect(parseSlashCommand('/rooms')).toEqual({ kind: 'command', verb: 'rooms' })
    expect(parseSlashCommand('/clear')).toEqual({ kind: 'command', verb: 'clear' })
    expect(parseSlashCommand('/leave')).toEqual({ kind: 'command', verb: 'leave' })
  })

  it('parses the argument commands with their canonical payloads', () => {
    expect(parseSlashCommand('/nick zorro-bravo')).toEqual({
      kind: 'command',
      verb: 'nick',
      nickname: 'zorro-bravo',
    })
    expect(parseSlashCommand('/room Mi Sala')).toEqual({
      kind: 'command',
      verb: 'room',
      room: 'mi-sala',
    })
    expect(parseSlashCommand('/dm luna-cauta')).toEqual({
      kind: 'command',
      verb: 'dm',
      nick: 'luna-cauta',
    })
    expect(parseSlashCommand('/me se pone a bailar')).toEqual({
      kind: 'command',
      verb: 'me',
      action: 'se pone a bailar',
    })
  })
})

describe('parseSlashCommand — whitespace handling', () => {
  it('tolerates runs between verb and arguments and trims the ends', () => {
    const nick = parseSlashCommand('/nick    zorro')
    expect(nick).toEqual({ kind: 'command', verb: 'nick', nickname: 'zorro' })
    const me = parseSlashCommand('/me   salta   alto   ')
    expect(me).toEqual({ kind: 'command', verb: 'me', action: 'salta   alto' })
  })

  it('preserves internal whitespace for /me', () => {
    const result = parseSlashCommand('/me  corre\tentre\ttejas')
    expect(result).toEqual({ kind: 'command', verb: 'me', action: 'corre\tentre\ttejas' })
  })

  it('trailing whitespace alone is not an argument for zero-arg commands', () => {
    expect(parseSlashCommand('/help  ')).toEqual({ kind: 'command', verb: 'help' })
    expect(parseSlashCommand('/leave\t')).toEqual({ kind: 'command', verb: 'leave' })
  })
})

describe('parseSlashCommand — strict arity', () => {
  it('rejects a missing argument with missing-arg', () => {
    const missing: Array<[string, string]> = [
      ['/nick', 'nick'],
      ['/nick   ', 'nick'],
      ['/room', 'room'],
      ['/dm', 'dm'],
      ['/me', 'me'],
    ]
    for (const [input, verb] of missing) {
      expect(parseSlashCommand(input)).toEqual({
        kind: 'error',
        verb,
        error: 'missing-arg',
        arg: '',
      })
    }
  })

  it('rejects spurious arguments to zero-arg commands with extra-args', () => {
    const extra: Array<[string, string, string]> = [
      ['/help hola', 'help', 'hola'],
      ['/rooms --all', 'rooms', '--all'],
      ['/clear ya', 'clear', 'ya'],
      ['/leave 1', 'leave', '1'],
    ]
    for (const [input, verb, arg] of extra) {
      expect(parseSlashCommand(input)).toEqual({
        kind: 'error',
        verb,
        error: 'extra-args',
        arg,
      })
    }
  })
})

describe('parseSlashCommand — /nick via the real RF-01 rules', () => {
  it('accepts valid nicknames, boundaries included', () => {
    expect(parseSlashCommand('/nick zorro-bravo')).toMatchObject({
      kind: 'command',
      nickname: 'zorro-bravo',
    })
    expect(parseSlashCommand('/nick bufón-si')).toMatchObject({
      kind: 'command',
      nickname: 'bufón-si',
    })
    expect(parseSlashCommand(`/nick ${'a'.repeat(24)}`)).toMatchObject({ kind: 'command' })
  })

  it('normalizes through RF-01: whitespace runs collapse (spaces are legal nick chars)', () => {
    expect(parseSlashCommand('/nick zorro    bravo')).toEqual({
      kind: 'command',
      verb: 'nick',
      nickname: 'zorro bravo',
    })
    // RF-01 does not case-fold: the nickname keeps its case.
    expect(parseSlashCommand('/nick  ZORRO')).toEqual({
      kind: 'command',
      verb: 'nick',
      nickname: 'ZORRO',
    })
  })

  it('rejects invalid nicknames with invalid-nick, quoting the raw argument', () => {
    for (const bad of ['a', 'a'.repeat(25), 'zorro!', 'zorro.bravo', 'ñandú🐦']) {
      expect(parseSlashCommand(`/nick ${bad}`)).toEqual({
        kind: 'error',
        verb: 'nick',
        error: 'invalid-nick',
        arg: bad,
      })
    }
  })
})

describe('parseSlashCommand — /room via the real RF-02 rules', () => {
  it('normalizes: trim + lowercase + whitespace runs → dashes', () => {
    expect(roomOf('Mi Sala')).toBe('mi-sala')
    expect(roomOf('UPPER')).toBe('upper')
    expect(roomOf('con  espacios dobles')).toBe('con-espacios-dobles')
    expect(roomOf('a_b-c9')).toBe('a_b-c9')
    expect(roomOf('  colgante   del  rio  ')).toBe('colgante-del-rio')
  })

  it('accepts the 1–32 char boundaries', () => {
    expect(roomOf('a'.repeat(32))).toBe('a'.repeat(32))
    expect(roomOf('a'.repeat(33))).toBeNull()
  })

  it('rejects non-normalizable names with invalid-room, quoting the raw argument', () => {
    for (const bad of ['mal nombre!', 'ñ', 'sala pigeon🐦']) {
      expect(parseSlashCommand(`/room ${bad}`)).toEqual({
        kind: 'error',
        verb: 'room',
        error: 'invalid-room',
        arg: bad,
      })
    }
  })

  it('stays in lockstep with the manager normalization (no import, drift guard)', () => {
    const corpus = [
      'Mi Sala',
      'UPPER',
      'a_b-c9',
      '',
      '   ',
      'mal nombre!',
      'ñ',
      'a'.repeat(32),
      'a'.repeat(33),
      'con  espacios',
      '  lead trail  ',
      'tab\there',
      'under_score-dash9',
    ]
    for (const raw of corpus) {
      expect(roomOf(raw)).toBe(normalizeRoomName(raw))
    }
  })
})

describe('parseSlashCommand — /dm', () => {
  it('passes the trimmed target through without a charset gate', () => {
    // Remote nicks are boundary-sanitized, not RF-01: any legible target is
    // parseable; matching against live peers happens at execution time.
    expect(parseSlashCommand('/dm 漢字テスト')).toEqual({
      kind: 'command',
      verb: 'dm',
      nick: '漢字テスト',
    })
    expect(parseSlashCommand('/dm   zorro  bravo ')).toEqual({
      kind: 'command',
      verb: 'dm',
      nick: 'zorro  bravo',
    })
  })

  it('rejects a whitespace-only target with missing-arg', () => {
    expect(parseSlashCommand('/dm   ')).toEqual({
      kind: 'error',
      verb: 'dm',
      error: 'missing-arg',
      arg: '',
    })
  })
})

describe('SLASH_COMMANDS table', () => {
  it('holds exactly the v1 set with unique verbs', () => {
    expect(SLASH_COMMANDS.map((def) => def.verb)).toEqual([
      'nick',
      'room',
      'dm',
      'me',
      'rooms',
      'clear',
      'leave',
      'help',
    ])
  })

  it('keeps every help text a single non-empty line and every usage slash-led', () => {
    for (const def of SLASH_COMMANDS) {
      expect(def.help).not.toHaveLength(0)
      expect(def.help).not.toMatch(/\n/)
      expect(def.usage.startsWith(`/${def.verb}`)).toBe(true)
    }
  })

  it('matches each verb with its argument grammar', () => {
    const arity = Object.fromEntries(SLASH_COMMANDS.map((def) => [def.verb, def.arity]))
    expect(arity).toEqual({
      nick: 'value',
      room: 'value',
      dm: 'value',
      me: 'rest',
      rooms: 'none',
      clear: 'none',
      leave: 'none',
      help: 'none',
    })
  })

  it('exposes lookup and usage text helpers for the executor', () => {
    expect(getSlashCommandDef('nick')?.usage).toBe('/nick <name>')
    expect(getSlashCommandDef('nope')).toBeUndefined()
    expect(slashUsageText('room')).toBe('Usage: /room <name>')
    expect(slashUsageText('leave')).toBe('Usage: /leave')
  })
})
