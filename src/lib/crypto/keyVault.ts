/**
 * Key vault — issue #24. Keeps the long-term private identity key out of
 * `localStorage` as plaintext: the JWK is AES-GCM-256 encrypted ("wrapped")
 * with a key that is generated on first use, stored in IndexedDB and marked
 * non-extractable, so neither store alone yields usable key material
 * (localStorage holds ciphertext, IndexedDB holds the wrapping key).
 *
 * Envelope formats (the string persisted under `gritos:identity.priv`):
 * - v1 `{"v":1,"iv":"<b64>","ct":"<b64>"}` — wrapped (12-byte IV, AES-GCM).
 * - v0 `{"v":0,"plain":"<privJwk JSON>"}` — passthrough fallback, used ONLY
 *   where IndexedDB is unavailable or fails to open (some embedded webviews,
 *   hardening extensions, certain private modes). Storage then behaves
 *   exactly like pre-#24 builds: plaintext at rest, the bar is NOT raised.
 *   Recovery is intentional: the app keeps working where IDB is missing.
 *
 * Failure policy: vault errors (missing IndexedDB, failed open, corrupted or
 * unwrappable envelope) never crash the caller — `wrapPrivateKey` degrades
 * to a v0 envelope and `unwrapPrivateKey` rejects, which the persistence
 * layer turns into the regular re-keying migration path (a fresh keypair,
 * a new fingerprint).
 */

/** IndexedDB database / store / record holding the wrapping key. */
const VAULT_DB_NAME = 'gritos'
const VAULT_STORE_NAME = 'keys'
const VAULT_WRAP_RECORD = 'identity-wrap'

const WRAP_KEY_ALGORITHM: AesKeyGenParams = { name: 'AES-GCM', length: 256 }
const WRAP_KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt']
const IV_LENGTH_BYTES = 12

/** Wrapped envelope (v1): the storable form of a private JWK. */
export interface WrappedEnvelope {
  v: 1
  /** base64 12-byte AES-GCM IV. */
  iv: string
  /** base64 ciphertext of the privJwk JSON. */
  ct: string
}

/** Passthrough envelope (v0): fallback where IndexedDB is unavailable. */
export interface PassthroughEnvelope {
  v: 0
  /** The privJwk JSON, verbatim (plaintext — same as pre-#24 builds). */
  plain: string
}

export type KeyVaultEnvelope = WrappedEnvelope | PassthroughEnvelope

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] as number)
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function passthroughEnvelope(privJwkJson: string): string {
  return JSON.stringify({ v: 0, plain: privJwkJson } satisfies PassthroughEnvelope)
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing (promise-wrapped, minimal surface)
// ---------------------------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(VAULT_DB_NAME)
    } catch (error) {
      reject(error instanceof Error ? error : new Error('IndexedDB open threw'))
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
        db.createObjectStore(VAULT_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB open blocked'))
  })
}

// ---------------------------------------------------------------------------
// Wrapping key lifecycle (cached per session, generated on first use)
// ---------------------------------------------------------------------------

let wrapKeyPromise: Promise<CryptoKey | null> | null = null

/**
 * Loads (or creates) the non-extractable AES-GCM wrapping key from the
 * vault. Resolves to null whenever the vault is unusable — callers degrade
 * to passthrough envelopes instead of failing.
 */
function loadWrapKey(): Promise<CryptoKey | null> {
  wrapKeyPromise ??= (async () => {
    try {
      const db = await openVaultDb()
      try {
        const existing = await requestToPromise(
          db.transaction(VAULT_STORE_NAME, 'readonly').objectStore(VAULT_STORE_NAME).get(VAULT_WRAP_RECORD),
        )
        if (existing instanceof CryptoKey) return existing
        // First use (or a corrupt record): generate and persist. The key is
        // never extractable, so a localStorage dump alone is not enough.
        const generated = (await crypto.subtle.generateKey(
          WRAP_KEY_ALGORITHM,
          false,
          WRAP_KEY_USAGES,
        )) as CryptoKey
        await requestToPromise(
          db
            .transaction(VAULT_STORE_NAME, 'readwrite')
            .objectStore(VAULT_STORE_NAME)
            .put(generated, VAULT_WRAP_RECORD),
        )
        return generated
      } finally {
        db.close()
      }
    } catch {
      return null
    }
  })()
  return wrapKeyPromise
}

/**
 * Wraps the private JWK JSON into a storable envelope: v1 (AES-GCM) when
 * the vault is usable, v0 (passthrough) otherwise. Never rejects.
 */
export async function wrapPrivateKey(privJwkJson: string): Promise<string> {
  const key = await loadWrapKey()
  if (key === null) return passthroughEnvelope(privJwkJson)
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(privJwkJson),
    )
    return JSON.stringify({
      v: 1,
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ciphertext)),
    } satisfies WrappedEnvelope)
  } catch {
    // Encryption is not expected to fail with a live key; degrade rather
    // than lose the identity write.
    return passthroughEnvelope(privJwkJson)
  }
}

/**
 * Opens a stored envelope and returns the original privJwk JSON. Rejects
 * for malformed/tampered envelopes or when a v1 envelope meets a vault
 * that no longer holds the wrapping key — the caller migrates to a fresh
 * keypair instead of surfacing the error.
 */
export async function unwrapPrivateKey(envelope: string): Promise<string> {
  let parsed: KeyVaultEnvelope
  try {
    parsed = JSON.parse(envelope) as KeyVaultEnvelope
  } catch {
    throw new Error('keyVault: malformed envelope')
  }
  if (parsed !== null && typeof parsed === 'object' && parsed.v === 0) {
    const plain = (parsed as PassthroughEnvelope).plain
    if (typeof plain !== 'string') throw new Error('keyVault: malformed v0 envelope')
    return plain
  }
  if (parsed !== null && typeof parsed === 'object' && parsed.v === 1) {
    const wrapped = parsed as WrappedEnvelope
    if (typeof wrapped.iv !== 'string' || typeof wrapped.ct !== 'string') {
      throw new Error('keyVault: malformed v1 envelope')
    }
    const key = await loadWrapKey()
    if (key === null) throw new Error('keyVault: wrapping key unavailable')
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
        key,
        fromBase64(wrapped.ct),
      )
      return new TextDecoder().decode(plaintext)
    } catch {
      throw new Error('keyVault: envelope failed to open')
    }
  }
  throw new Error('keyVault: unknown envelope format')
}

/**
 * Clears the vault (panic wipe, RF-08). Best-effort by design: resolves
 * silently where IndexedDB is unavailable, and any failure is swallowed so
 * the panic flow is never blocked. The cached session key is dropped too.
 */
export async function wipeKeyVault(): Promise<void> {
  wrapKeyPromise = null
  try {
    const db = await openVaultDb()
    try {
      await requestToPromise(
        db.transaction(VAULT_STORE_NAME, 'readwrite').objectStore(VAULT_STORE_NAME).clear(),
      )
    } finally {
      db.close()
    }
  } catch {
    // Nothing to wipe (or the vault refuses): the panic keeps going.
  }
}

/** Test-only reset of the cached wrapping key (see resetManagerForTests). */
export function resetKeyVaultForTests(): void {
  wrapKeyPromise = null
}
