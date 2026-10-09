// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OnboardingScreen } from '../src/components/onboarding/OnboardingScreen'
import { en } from '../src/i18n/en'
import { resetManagerForTests, setJoinRoomFactory } from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { IDENTITY_STORAGE_KEY } from '../src/lib/crypto/identity'
import { installFakeTrystero } from './fakeTrystero'

// Real timers: vitest fake timers swallow Node's webcrypto resolution under
// jsdom, and entering the app creates an identity (ECDH keypair).
let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  setJoinRoomFactory(null)
  vi.useRealTimers()
})

const input = () => screen.getByLabelText('Your nickname') as HTMLInputElement
const submitForm = () => fireEvent.submit(screen.getByRole('form', { name: 'enter' }))

describe('OnboardingScreen (RF-01, spec §10.2)', () => {
  it('renders the spec layout: logo, field, surprise me, Enter →', () => {
    render(<OnboardingScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'gritos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'surprise me' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter →' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'No server, no accounts: your messages travel directly between browsers and disappear on reload.',
      ),
    ).toBeInTheDocument()
  })

  it('discloses the P2P IP exposure to room peers (issue #35)', () => {
    render(<OnboardingScreen />)
    // Issue #119 phase 3 — the screen renders the live t() value now; pin
    // the same string via the dictionary key (the shim was deleted).
    expect(screen.getByText(en['settings.p2pDisclosure'])).toBeInTheDocument()
  })

  it('surprise me fills a valid generated nickname', () => {
    render(<OnboardingScreen />)
    expect(input().value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'surprise me' }))
    // The field must hold a generator-valid nickname (sustantivo-adjetivo).
    expect(input().value).toMatch(/^[a-záéíóúñü]+-[a-záéíóúñü]+$/)
  })

  it('shows an inline error (no modal) for an invalid nickname', () => {
    render(<OnboardingScreen />)
    fireEvent.change(input(), { target: { value: 'no!!!' } })
    submitForm()
    expect(screen.getByRole('alert')).toHaveTextContent('Use 2 to 24 characters')
    // Identity untouched.
    expect(useAppStore.getState().identity).toBeNull()
    expect(localStorage.getItem(IDENTITY_STORAGE_KEY)).toBeNull()
  })

  it('empty field + Entrar generates a random valid nickname and enters', async () => {
    render(<OnboardingScreen />)
    submitForm()

    await waitFor(() => {
      expect(useAppStore.getState().identity).not.toBeNull()
    })
    expect(useAppStore.getState().identity?.nickname ?? '').toMatch(/^[a-záéíóúñü]+-[a-záéíóúñü]+$/)
  })

  it('Entrar persists the identity profile and auto-joins #lobby', async () => {
    render(<OnboardingScreen />)
    fireEvent.change(input(), { target: { value: '  zorro   bravo ' } })
    submitForm()

    await waitFor(() => {
      // The nickname is normalized (trimmed, spaces collapsed).
      expect(useAppStore.getState().identity?.nickname).toBe('zorro bravo')
    })

    const persisted = localStorage.getItem(IDENTITY_STORAGE_KEY)
    expect(persisted).not.toBeNull()
    const parsed = JSON.parse(persisted as string) as Record<string, unknown>
    expect(parsed).toMatchObject({
      nickname: 'zorro bravo',
      fingerprint: useAppStore.getState().identity?.fingerprint,
    })
    expect(typeof parsed.createdAt).toBe('number')

    // autoJoinLobby default on → #lobby joined AND focused.
    await waitFor(() => {
      expect(useAppStore.getState().activeView?.kind).toBe('room')
    })
    const view = useAppStore.getState().activeView
    const room = view?.kind === 'room' ? useAppStore.getState().rooms[view.id] : null
    expect(room?.name).toBe('lobby')
  })

  it('does not join #lobby when autoJoinLobby is off', async () => {
    useSettingsStore.getState().setSettings({ autoJoinLobby: false })
    render(<OnboardingScreen />)
    fireEvent.change(input(), { target: { value: 'zorro-bravo' } })
    submitForm()

    await waitFor(() => {
      expect(useAppStore.getState().identity?.nickname).toBe('zorro-bravo')
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeView).toBeNull()
  })
})
